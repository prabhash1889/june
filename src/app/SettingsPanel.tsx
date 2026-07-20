import { useEffect, useState } from "react";

import { bridgeHealth, type BridgeHealth, type ProbeResult, testBrain } from "../lib/diagnostics.ts";
import { type LatencySample, latencySamples, percentile } from "../lib/latency.ts";
import {
  MCP_CATALOG,
  type McpClass,
  type McpServerEntry,
  type McpTransport,
  slugify,
} from "../lib/mcp-servers.ts";
import { PRIVACY_MODES, type PrivacyMode } from "../lib/privacy.ts";
import {
  defaultVoiceFor,
  keyedProviders,
  type Provider,
  providersFor,
  resolveProvider,
  type Stage,
  voicesFor,
} from "../lib/providers.ts";
import {
  DEFAULT_SETTINGS,
  deleteKey,
  type Effort,
  hasKey,
  type JuneSettings,
  loadSettings,
  privacyViolations,
  readMemory,
  saveSettings,
  setKey,
  voiceAllowed,
  writeMemory,
} from "../lib/settings.ts";
import { transcribe } from "../lib/stt.ts";
import { synthesize } from "../lib/tts.ts";
import { startCapture } from "../lib/voice-capture.ts";

// The full settings surface (PLAN.md §3-§4, Phase 7). This is the window's
// second face: choose the STT / brain / TTS stack, verify each stage, manage
// API keys (OS-keychain backed), pick a privacy mode, and see diagnostics.
// Selections persist to settings.json and take effect on the next turn - so
// switching a provider never disturbs an in-flight command or pending approval
// (those live in the Rust session, read fresh each turn).

const EFFORTS: Effort[] = ["low", "medium", "high"];
const TEST_SAMPLE = "June is ready when you are.";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The endpoint June will hit for the chosen brain: a custom provider uses the
 *  user's URL, everyone else the registry default. */
function brainBaseUrl(s: JuneSettings): string {
  const p = resolveProvider("brain", s.brain.provider);
  if (p?.editableBaseUrl) return s.brainBaseUrl;
  return p?.baseUrl ?? "";
}

async function playBytes(bytes: Uint8Array, mime: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const el = new Audio(url);
  await new Promise<void>((resolve) => {
    el.onended = () => resolve();
    el.onerror = () => resolve();
    void el.play().catch(() => resolve());
  }).finally(() => URL.revokeObjectURL(url));
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<JuneSettings | null>(null);

  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .catch(() => setSettings(DEFAULT_SETTINGS));
  }, []);

  if (!settings) return <div className="settings-view">Loading settings…</div>;

  // Persist on every change: settings are read fresh at the start of each turn,
  // so a change here never disrupts a running command or a pending approval.
  const update = (next: JuneSettings) => {
    setSettings(next);
    void saveSettings(next).catch(() => {});
  };

  return (
    <div className="settings-view">
      <ModelsSection settings={settings} update={update} />
      <KeysSection />
      <PrivacySection settings={settings} update={update} />
      <ActivationSection settings={settings} update={update} />
      <HandsFreeSection settings={settings} update={update} />
      <TranscriptSection settings={settings} update={update} />
      <ConversationSection settings={settings} update={update} />
      <MemorySection />
      <CapabilitiesSection settings={settings} update={update} />
      <DiagnosticsSection />
    </div>
  );
}

// --- Models ---------------------------------------------------------------

function ModelsSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  return (
    <section className="settings-section">
      <h2>Models</h2>
      <p className="settings-hint">Pick a provider and model for each stage, then test it.</p>

      <SttCard settings={settings} update={update} />
      <BrainCard settings={settings} update={update} />
      <TtsCard settings={settings} update={update} />
    </section>
  );
}

/** Provider dropdown for a stage. Unavailable providers (local voice, not yet
 *  wired) are shown so the intended stack is visible but cannot be selected. */
function ProviderSelect({
  stage,
  value,
  onChange,
}: {
  stage: Stage;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {providersFor(stage).map((p) => (
        <option key={p.id} value={p.id} disabled={!p.available}>
          {p.label}
          {p.available ? "" : " - coming soon"}
        </option>
      ))}
    </select>
  );
}

function ModelInput({ provider, value, onChange }: { provider: Provider; value: string; onChange: (v: string) => void }) {
  const listId = `models-${provider.id}`;
  return (
    <>
      <input list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder="model id" />
      <datalist id={listId}>
        {provider.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </datalist>
    </>
  );
}

/** Test button + result line. Latency doubles as the diagnostics latency
 *  breakdown for this stage (§4). */
function TestControl({ run }: { run: () => Promise<ProbeResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const click = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await run());
    } catch (e) {
      setResult({ ok: false, detail: msg(e), ms: 0 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-test">
      <button onClick={click} disabled={busy}>
        {busy ? "Testing…" : "Test"}
      </button>
      {result && (
        <span className={`test-result ${result.ok ? "ok" : "bad"}`}>
          {result.ok ? "✓" : "✗"} {result.detail}
          {result.ms ? ` (${result.ms} ms)` : ""}
        </span>
      )}
    </div>
  );
}

function SttCard({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const provider = resolveProvider("stt", settings.stt.provider);

  const runTest = async (): Promise<ProbeResult> => {
    const t0 = performance.now();
    const handle = await startCapture({ onEndpoint: () => {}, maxMs: 3000 });
    await new Promise((r) => setTimeout(r, 2500));
    const { audio, mime } = await handle.stop();
    if (audio.length === 0) return { ok: false, detail: "No audio captured - is the microphone allowed?", ms: 0 };
    const text = (await transcribe(audio, mime, settings.stt)).trim();
    const ms = Math.round(performance.now() - t0);
    return text
      ? { ok: true, detail: `Heard: "${text}"`, ms }
      : { ok: false, detail: "Transcription came back empty - try speaking during the test.", ms };
  };

  return (
    <div className="stage-card">
      <div className="stage-row">
        <span className="stage-label">Speech to text</span>
        <ProviderSelect stage="stt" value={settings.stt.provider} onChange={(id) => update(withProvider(settings, "stt", id))} />
        {provider && <ModelInput provider={provider} value={settings.stt.model} onChange={(v) => update({ ...settings, stt: { ...settings.stt, model: v } })} />}
      </div>
      <TestControl run={runTest} />
    </div>
  );
}

function BrainCard({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const provider = resolveProvider("brain", settings.brain.provider);

  const runTest = (): Promise<ProbeResult> => testBrain(settings.brain.provider, brainBaseUrl(settings));

  return (
    <div className="stage-card">
      <div className="stage-row">
        <span className="stage-label">Brain</span>
        <ProviderSelect stage="brain" value={settings.brain.provider} onChange={(id) => update(withProvider(settings, "brain", id))} />
        {provider && (
          <ModelInput provider={provider} value={settings.brain.model} onChange={(v) => update({ ...settings, brain: { ...settings.brain, model: v } })} />
        )}
        <select
          value={settings.brain.effort}
          onChange={(e) => update({ ...settings, brain: { ...settings.brain, effort: e.target.value as Effort } })}
          title="Reasoning effort"
        >
          {EFFORTS.map((eff) => (
            <option key={eff} value={eff}>
              {eff} effort
            </option>
          ))}
        </select>
      </div>
      {provider?.editableBaseUrl && (
        <div className="stage-row">
          <span className="stage-label">Endpoint</span>
          <input
            className="wide"
            value={settings.brainBaseUrl}
            onChange={(e) => update({ ...settings, brainBaseUrl: e.target.value })}
            placeholder="https://your-endpoint/v1"
          />
        </div>
      )}
      <TestControl run={runTest} />
    </div>
  );
}

function TtsCard({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const provider = resolveProvider("tts", settings.tts.provider);

  const runTest = async (): Promise<ProbeResult> => {
    const t0 = performance.now();
    const { bytes, mime } = await synthesize(TEST_SAMPLE, settings.tts);
    const ms = Math.round(performance.now() - t0);
    if (bytes.length === 0) return { ok: false, detail: "No audio returned.", ms };
    await playBytes(bytes, mime);
    return { ok: true, detail: `Spoke a sample in the ${settings.tts.voice} voice.`, ms };
  };

  return (
    <div className="stage-card">
      <div className="stage-row">
        <span className="stage-label">Text to speech</span>
        <ProviderSelect stage="tts" value={settings.tts.provider} onChange={(id) => update(withProvider(settings, "tts", id))} />
        {provider && <ModelInput provider={provider} value={settings.tts.model} onChange={(v) => update({ ...settings, tts: { ...settings.tts, model: v } })} />}
        <select value={settings.tts.voice} onChange={(e) => update({ ...settings, tts: { ...settings.tts, voice: e.target.value } })} title="Voice">
          {voicesFor(settings.tts.provider).map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <TestControl run={runTest} />
    </div>
  );
}

/** Change a stage's provider and reset its model to that provider's first
 *  suggestion (avoids leaving a model id that doesn't belong to the provider).
 *  For TTS also reset the voice, so switching engines (OpenAI <-> local Kokoro,
 *  whose voice tables are disjoint) never leaves a voice the new engine lacks. */
function withProvider(settings: JuneSettings, stage: Stage, providerId: string): JuneSettings {
  const p = resolveProvider(stage, providerId);
  const model = p?.models[0]?.id ?? "";
  const cur = settings[stage];
  if (stage === "tts") {
    return { ...settings, tts: { ...settings.tts, provider: providerId, model, voice: defaultVoiceFor(providerId) } };
  }
  return { ...settings, [stage]: { ...cur, provider: providerId, model } };
}

// --- API keys -------------------------------------------------------------

function KeysSection() {
  return (
    <section className="settings-section">
      <h2>API keys</h2>
      <p className="settings-hint">Stored in your OS keychain, never in settings files. Local providers (Ollama, LM Studio) need no key.</p>
      {keyedProviders().map((p) => (
        <KeyRow key={p.keyService} label={p.label} keyService={p.keyService} />
      ))}
    </section>
  );
}

function KeyRow({ label, keyService }: { label: string; keyService: string }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    hasKey(keyService)
      .then(setPresent)
      .catch(() => setPresent(false));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await setKey(keyService, value.trim());
      setValue("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await deleteKey(keyService);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="key-row">
      <span className="key-label">
        {label}
        <span className={`key-dot ${present ? "on" : ""}`} title={present ? "Key set" : "No key"} />
      </span>
      <input type="password" placeholder={present ? "Replace key…" : "sk-…"} value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="primary" onClick={save} disabled={busy || !value.trim()}>
        Save
      </button>
      <button onClick={clear} disabled={busy || present === false}>
        Clear
      </button>
    </div>
  );
}

// --- Privacy --------------------------------------------------------------

function PrivacySection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const violations = privacyViolations(settings);
  return (
    <section className="settings-section">
      <h2>Privacy</h2>
      {PRIVACY_MODES.map((m) => (
        <label key={m.id} className="privacy-mode">
          <input
            type="radio"
            name="privacy-mode"
            checked={settings.privacyMode === m.id}
            onChange={() => update({ ...settings, privacyMode: m.id as PrivacyMode })}
          />
          <span>
            <span className="privacy-name">{m.label}</span>
            <span className="privacy-desc">{m.desc}</span>
          </span>
        </label>
      ))}
      {violations.length > 0 && (
        <div className="privacy-violations">
          {violations.map((v) => (
            <p key={v.stage} className="err">
              {v.message}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

// --- Activation -----------------------------------------------------------

function ActivationSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const wake = settings.wake;
  const setWake = (next: Partial<JuneSettings["wake"]>) => update({ ...settings, wake: { ...wake, ...next } });
  // Wake uses cloud STT today, so it can't run under a mode that keeps voice
  // on-device (there is no local voice provider yet) - say so instead of failing.
  const voiceOff = !voiceAllowed(settings);

  return (
    <section className="settings-section">
      <h2>Activation</h2>
      <p className="settings-hint">
        Push to talk: <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Space</kbd>. A configurable hotkey arrives in a later
        phase.
      </p>

      <div className="stage-card">
        <label className="wake-toggle">
          <input
            type="checkbox"
            checked={wake.enabled}
            disabled={voiceOff}
            onChange={(e) => setWake({ enabled: e.target.checked })}
          />
          <span>
            <span className="privacy-name">Wake word (hands-free)</span>
            <span className="privacy-desc">
              Say the wake word to start a command without touching the keyboard. Detected on-device (openWakeWord); the
              command itself still uses your speech-to-text provider, so hands-free stays off in privacy modes that keep
              voice on-device.
            </span>
          </span>
        </label>

        {wake.enabled && (
          <>
            <div className="stage-row">
              <span className="stage-label">Phrase</span>
              <input
                value={wake.phrase}
                onChange={(e) => setWake({ phrase: e.target.value })}
                placeholder="hey june"
              />
            </div>
            <p className="settings-hint">
              The on-device wake word is currently <strong>"hey jarvis"</strong> (a trained "hey june" model is coming).
              This phrase applies only to the cloud fallback used if the local model can't load.
            </p>
            <div className="stage-row">
              <span className="stage-label">Sensitivity</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={wake.sensitivity}
                onChange={(e) => setWake({ sensitivity: Number(e.target.value) })}
              />
              <span className="settings-hint">
                {wake.sensitivity >= 0.75 ? "Strict - fewest false triggers" : wake.sensitivity <= 0.35 ? "Loose - easiest to trigger" : "Balanced"}
              </span>
            </div>
          </>
        )}

        {voiceOff && (
          <p className="settings-hint">Wake word is unavailable in your current privacy mode. Switch to Standard to use it.</p>
        )}
      </div>
    </section>
  );
}

// --- Hands-free -----------------------------------------------------------

// Hands-free & conversational voice UX (PLAN.md Phase 14). Every toggle is off by
// default: manual review + click-to-approve is the safe baseline. Voice-off modes
// disable the whole group (there is no local voice provider for these flows yet).
function HandsFreeSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const hands = settings.handsFree;
  const setHands = (next: Partial<JuneSettings["handsFree"]>) =>
    update({ ...settings, handsFree: { ...hands, ...next } });
  const voiceOff = !voiceAllowed(settings);

  const rows: { key: keyof JuneSettings["handsFree"]; name: string; desc: string }[] = [
    {
      key: "autoAccept",
      name: "Auto-send after review",
      desc: `The review card sends automatically after a ${3}s countdown. Any edit, or a tap, pauses it - so you stay in control.`,
    },
    {
      key: "spokenApprovals",
      name: "Spoken approvals",
      desc: "June reads a paid action's exact details aloud and takes a spoken yes/no. Destructive or external actions still require a click.",
    },
    {
      key: "followUp",
      name: "Follow-up mode",
      desc: "After each reply the mic reopens briefly with no wake word, so you can keep talking. Say nothing and it stands down.",
    },
    {
      key: "backchannel",
      name: "Say “on it”",
      desc: "A brief spoken acknowledgement when June starts working on a tool call, so a slow action doesn't feel silent.",
    },
  ];

  return (
    <section className="settings-section">
      <h2>Hands-free</h2>
      <p className="settings-hint">
        A fully spoken loop - wake, command, spoken approval, follow-up - with hands off the keyboard. All off by
        default; turn on only what you want.
      </p>
      <div className="stage-card">
        {rows.map((r) => (
          <label className="wake-toggle" key={r.key}>
            <input
              type="checkbox"
              checked={hands[r.key]}
              disabled={voiceOff}
              onChange={(e) => setHands({ [r.key]: e.target.checked })}
            />
            <span>
              <span className="privacy-name">{r.name}</span>
              <span className="privacy-desc">{r.desc}</span>
            </span>
          </label>
        ))}
        {voiceOff && (
          <p className="settings-hint">Hands-free is unavailable in your current privacy mode. Switch to Standard to use it.</p>
        )}
      </div>
    </section>
  );
}

// --- Dictation & transcript ----------------------------------------------

// Transcript quality & system-wide dictation (PLAN.md Phase 15). All on-device:
// the cleaner (src/lib/transcript.ts) is pure and runs in every privacy mode.
// Auto-edit tidies each transcript before the review gate; the dictionary and
// snippets are user term maps (the dictionary also grows itself from corrections
// made at the review gate). Dictation mode itself is a toggle in the widget - a
// held Ctrl+Shift+Space types your speech into the focused app.
function TranscriptSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const t = settings.transcript;
  const setT = (next: Partial<JuneSettings["transcript"]>) =>
    update({ ...settings, transcript: { ...t, ...next } });

  return (
    <section className="settings-section">
      <h2>Dictation &amp; transcript</h2>
      <p className="settings-hint">
        Turn on <strong>dictation</strong> from the widget (the keyboard icon), then hold <kbd>Ctrl</kbd> + <kbd>Shift</kbd>{" "}
        + <kbd>Space</kbd> to type your speech into whatever app is focused. Cleaning below applies to both dictation and
        spoken commands, and runs entirely on-device.
      </p>

      <div className="stage-card">
        <label className="wake-toggle">
          <input type="checkbox" checked={t.autoEdit} onChange={(e) => setT({ autoEdit: e.target.checked })} />
          <span>
            <span className="privacy-name">Auto-edit transcripts</span>
            <span className="privacy-desc">
              Strip fillers (“um”, “uh”), tidy spacing and punctuation, and capitalize - before the review card and before
              dictation injection. Your dictionary and snippets always apply regardless.
            </span>
          </span>
        </label>
      </div>

      <div className="stage-card">
        <div className="stage-row">
          <span className="stage-label">Dictionary</span>
        </div>
        <p className="settings-hint">
          Corrections for words June mishears, one per line as <code>heard = correction</code> (e.g.{" "}
          <code>june = June</code>). Edits you make at the review card are added here automatically.
        </p>
        <textarea
          className="memory-text wide"
          rows={4}
          value={mapToText(t.dictionary)}
          onChange={(e) => setT({ dictionary: textToMap(e.target.value) })}
          placeholder="june = June"
        />
      </div>

      <div className="stage-card">
        <div className="stage-row">
          <span className="stage-label">Snippets</span>
        </div>
        <p className="settings-hint">
          Spoken shortcuts, one per line as <code>cue = expansion</code> (e.g.{" "}
          <code>insert my intro = Hi, I'm …</code>). Saying the cue inserts the saved text.
        </p>
        <textarea
          className="memory-text wide"
          rows={4}
          value={mapToText(t.snippets)}
          onChange={(e) => setT({ snippets: textToMap(e.target.value) })}
          placeholder="insert my intro = Hi, I'm June's owner."
        />
      </div>
    </section>
  );
}

// --- Conversation ---------------------------------------------------------

// Conversation memory (PLAN.md Phase 11.2). June now carries context across
// turns; this sets how long an idle gap must be before the next command starts a
// fresh conversation. 0 = never auto-reset (use "New conversation" to clear it).
function ConversationSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  return (
    <section className="settings-section">
      <h2>Conversation</h2>
      <p className="settings-hint">June remembers the current conversation across turns. Use “New conversation” in either window to clear it.</p>
      <div className="stage-card">
        <div className="stage-row">
          <span className="stage-label">New conversation after</span>
          <input
            type="number"
            min={0}
            step={1}
            value={settings.conversationIdleMinutes}
            onChange={(e) =>
              update({ ...settings, conversationIdleMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
            }
          />
          <span className="settings-hint">
            {settings.conversationIdleMinutes === 0
              ? "minutes idle - never resets automatically"
              : "minutes idle"}
          </span>
        </div>
      </div>
    </section>
  );
}

// --- Memory ---------------------------------------------------------------

// Long-term memory (PLAN.md Phase 11.4): one user-editable june-memory.md, shown
// to June at the start of every conversation. June writes durable facts here on
// its own (the remember tool); this surface lets the user see, edit, or clear
// them. Kept in its own file, not settings.json, and local-only (no network).
function MemorySection() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    readMemory()
      .then((m) => {
        setText(m);
        setSaved(m);
      })
      .catch(() => setText(""));
  }, []);

  if (text === null) return null;
  const dirty = text !== saved;

  const save = async (value: string) => {
    setBusy(true);
    try {
      await writeMemory(value);
      setText(value);
      setSaved(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Memory</h2>
      <p className="settings-hint">
        What June remembers about you across conversations. June saves durable facts here on its own; you can edit or
        clear them. Stored on-device only.
      </p>
      <div className="stage-card">
        <textarea
          className="memory-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="June hasn't remembered anything yet."
          rows={6}
        />
        <div className="settings-test">
          <button className="primary" onClick={() => save(text)} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button onClick={() => save("")} disabled={busy || (text.length === 0 && saved.length === 0)}>
            Clear
          </button>
        </div>
      </div>
    </section>
  );
}

// --- Capabilities ---------------------------------------------------------

// The MCP capability surface (PLAN.md §4). Phase 9 ships the first non-saple
// capability: local files. It proves June is general-purpose (a capability is a
// server, not new core code) and is local/offline-safe, so it stays on under
// Strict offline. Off by default - the filesystem is exposed only on opt-in, and
// only for the one folder chosen here. saple-bridge-control is always attached.
function CapabilitiesSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const files = settings.files;
  const setFiles = (next: Partial<JuneSettings["files"]>) => update({ ...settings, files: { ...files, ...next } });
  const rootMissing = files.enabled && !files.root.trim();

  return (
    <section className="settings-section">
      <h2>Capabilities</h2>
      <p className="settings-hint">
        Capabilities are MCP servers. <strong>saple-bridge-control</strong> is always connected; enable others below.
      </p>

      <div className="stage-card">
        <label className="wake-toggle">
          <input type="checkbox" checked={files.enabled} onChange={(e) => setFiles({ enabled: e.target.checked })} />
          <span>
            <span className="privacy-name">Files (local folder)</span>
            <span className="privacy-desc">
              Let June read and write files inside one folder you choose. Runs entirely on-device - no network - so it
              stays available in every privacy mode. Reads are automatic; writing a file always asks first.
            </span>
          </span>
        </label>

        {files.enabled && (
          <div className="stage-row">
            <span className="stage-label">Folder</span>
            <input
              className="wide"
              value={files.root}
              onChange={(e) => setFiles({ root: e.target.value })}
              placeholder="C:\Users\you\Documents\june-files"
            />
          </div>
        )}
        {rootMissing && (
          <p className="settings-hint err">Choose a folder - June needs one allowed folder before it can touch files.</p>
        )}
      </div>

      <McpServersSubsection settings={settings} update={update} />
    </section>
  );
}

// --- Custom MCP servers (Phase 13) ----------------------------------------
// Add any MCP server - a stdio command or a remote URL - and June runs it, no
// June code changes. Tools from an unknown server are approval-required by
// default (10.1's fail-closed classify); promote a whole server to a safer class
// once you have seen its tools. Networked servers are dropped under Strict
// offline via the per-server offline-safe flag.

const CLASS_OPTIONS: { value: "" | McpClass; label: string }[] = [
  { value: "", label: "Default (gated until inspected)" },
  { value: "observe", label: "Observe (read-only, auto-run)" },
  { value: "reversible", label: "Reversible (auto-run)" },
  { value: "expensive", label: "Expensive (always ask)" },
  { value: "destructive", label: "Destructive (always ask)" },
];

/** env / headers edited as `KEY=value` lines - the same shape Claude Desktop's
 *  mcp.json uses. Not for long-lived secrets in a shared file, but it is how the
 *  MCP ecosystem passes tokens today; a keychain-per-server surface is a follow-up. */
function mapToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function McpServersSubsection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const servers = settings.mcpServers;
  const setServers = (next: McpServerEntry[]) => update({ ...settings, mcpServers: next });

  const upsert = (entry: McpServerEntry) => {
    const i = servers.findIndex((s) => s.id === entry.id);
    setServers(i >= 0 ? servers.map((s, j) => (j === i ? entry : s)) : [...servers, entry]);
  };
  const remove = (id: string) => setServers(servers.filter((s) => s.id !== id));

  // A unique id for a fresh blank server (base "server", "server-2", ...).
  const freshId = (): string => {
    const base = "server";
    if (!servers.some((s) => s.id === base)) return base;
    for (let n = 2; ; n++) if (!servers.some((s) => s.id === `${base}-${n}`)) return `${base}-${n}`;
  };
  const addBlank = () => {
    const id = freshId();
    upsert({ id, label: "New server", enabled: false, offlineSafe: false, transport: { kind: "stdio", command: "npx", args: [], env: {} } });
  };
  const addPreset = (id: string) => {
    const preset = MCP_CATALOG.find((c) => c.entry.id === id);
    if (preset) upsert(preset.entry);
  };

  return (
    <>
      <h3 className="settings-subhead">Custom MCP servers</h3>
      <p className="settings-hint">
        Add any MCP server and June can use it - no June update needed. Tools from a new server always ask for approval
        until you promote the server to a safer class. Networked servers are turned off under Strict offline.
      </p>

      {servers.map((s) => (
        <McpServerCard key={s.id} entry={s} onChange={upsert} onRemove={() => remove(s.id)} />
      ))}

      <div className="settings-test">
        <button onClick={addBlank}>+ Add server</button>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) addPreset(e.target.value);
          }}
          title="Add a vetted server from the catalog"
        >
          <option value="">Add from catalog…</option>
          {MCP_CATALOG.map((c) => (
            <option key={c.entry.id} value={c.entry.id}>
              {c.entry.label} - {c.note}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function McpServerCard({
  entry,
  onChange,
  onRemove,
}: {
  entry: McpServerEntry;
  onChange: (e: McpServerEntry) => void;
  onRemove: () => void;
}) {
  const t = entry.transport;
  const setTransport = (transport: McpTransport) => onChange({ ...entry, transport });

  return (
    <div className="stage-card">
      <div className="stage-row">
        <label className="wake-toggle" style={{ flex: 1 }}>
          <input type="checkbox" checked={entry.enabled} onChange={(e) => onChange({ ...entry, enabled: e.target.checked })} />
          <input
            value={entry.label}
            onChange={(e) => onChange({ ...entry, label: e.target.value, id: entry.id || slugify(e.target.value) })}
            placeholder="Server name"
          />
        </label>
        <button onClick={onRemove} title="Remove this server">
          Remove
        </button>
      </div>

      <div className="stage-row">
        <span className="stage-label">Transport</span>
        <select
          value={t.kind}
          onChange={(e) =>
            setTransport(
              e.target.value === "http"
                ? { kind: "http", url: "", headers: {} }
                : { kind: "stdio", command: "npx", args: [], env: {} },
            )
          }
        >
          <option value="stdio">stdio (local command)</option>
          <option value="http">http (remote URL)</option>
        </select>
      </div>

      {t.kind === "stdio" ? (
        <>
          <div className="stage-row">
            <span className="stage-label">Command</span>
            <input value={t.command} onChange={(e) => setTransport({ ...t, command: e.target.value })} placeholder="npx" />
            <input
              className="wide"
              value={t.args.join(" ")}
              onChange={(e) => setTransport({ ...t, args: e.target.value.split(/\s+/).filter(Boolean) })}
              placeholder="-y @modelcontextprotocol/server-github@2025.4.8"
            />
          </div>
          <div className="stage-row">
            <span className="stage-label">Env</span>
            <textarea
              className="memory-text mcp-env wide"
              rows={2}
              value={mapToText(t.env)}
              onChange={(e) => setTransport({ ...t, env: textToMap(e.target.value) })}
              placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…"
            />
          </div>
        </>
      ) : (
        <>
          <div className="stage-row">
            <span className="stage-label">URL</span>
            <input
              className="wide"
              value={t.url}
              onChange={(e) => setTransport({ ...t, url: e.target.value })}
              placeholder="https://api.githubcopilot.com/mcp/"
            />
          </div>
          <div className="stage-row">
            <span className="stage-label">Headers</span>
            <textarea
              className="memory-text mcp-env wide"
              rows={2}
              value={mapToText(t.headers)}
              onChange={(e) => setTransport({ ...t, headers: textToMap(e.target.value) })}
              placeholder="Authorization=Bearer …"
            />
          </div>
        </>
      )}

      <div className="stage-row">
        <label className="wake-toggle">
          <input type="checkbox" checked={entry.offlineSafe} onChange={(e) => onChange({ ...entry, offlineSafe: e.target.checked })} />
          <span className="privacy-name">Offline-safe (runs fully on-device)</span>
        </label>
      </div>

      <div className="stage-row">
        <span className="stage-label">Tool class</span>
        <select
          value={entry.defaultClass ?? ""}
          onChange={(e) => {
            const v = e.target.value as "" | McpClass;
            onChange({ ...entry, defaultClass: v || undefined });
          }}
          title="Default safety class for this server's tools"
        >
          {CLASS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// --- Diagnostics ----------------------------------------------------------

function DiagnosticsSection() {
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [latency, setLatency] = useState<LatencySample[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      setHealth(await bridgeHealth());
    } catch (e) {
      setHealth({ found: false, healthy: false, version: "", endpoint: "", detail: msg(e) });
    } finally {
      setBusy(false);
    }
    // Latency is best-effort and independent of the bridge probe: no backend
    // (plain browser / tests) just leaves the readout empty.
    await latencySamples()
      .then(setLatency)
      .catch(() => {});
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className="settings-section">
      <h2>Diagnostics</h2>
      <div className="diag-row">
        <span className="stage-label">saple-bridge-control</span>
        {health && (
          <span className={`test-result ${health.healthy ? "ok" : "bad"}`}>
            {health.healthy ? "✓" : "✗"} {health.detail}
            {health.version ? ` (v${health.version})` : ""}
          </span>
        )}
        <button onClick={refresh} disabled={busy}>
          {busy ? "Checking…" : "Recheck"}
        </button>
      </div>
      <LatencyReadout samples={latency} />
      <p className="settings-hint">Per-stage latency is shown by each Test button above.</p>
    </section>
  );
}

// Voice-to-voice latency (PLAN.md Phase 11.5): P50/P95 of the recent voice turns,
// with a per-stage P50 breakdown (speech-to-text, brain, text-to-speech). Target
// line: 800ms median once the local voice stack (Phase 12) lands.
function LatencyReadout({ samples }: { samples: LatencySample[] }) {
  if (samples.length === 0) {
    return <p className="settings-hint">Voice latency: no turns recorded yet - speak a command to see P50/P95.</p>;
  }
  const totals = samples.map((s) => s.total);
  const p50 = percentile(totals, 50);
  const p95 = percentile(totals, 95);
  const stage = (pick: (s: LatencySample) => number) => percentile(samples.map(pick), 50);
  return (
    <div className="diag-latency">
      <div className="diag-row">
        <span className="stage-label">Voice-to-voice</span>
        <span className={`test-result ${p50 <= 800 ? "ok" : "bad"}`}>
          P50 {p50} ms · P95 {p95} ms
        </span>
        <span className="settings-hint">
          {samples.length} turn{samples.length === 1 ? "" : "s"} · target 800 ms
        </span>
      </div>
      <p className="settings-hint">
        Median stages: speech-to-text {stage((s) => s.stt)} ms · brain {stage((s) => s.brain)} ms · text-to-speech{" "}
        {stage((s) => s.tts)} ms
      </p>
    </div>
  );
}
