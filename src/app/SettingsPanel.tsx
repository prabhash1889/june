import { useEffect, useState } from "react";

import { bridgeHealth, type BridgeHealth, type ProbeResult, testBrain } from "../lib/diagnostics.ts";
import { PRIVACY_MODES, type PrivacyMode } from "../lib/privacy.ts";
import {
  keyedProviders,
  type Provider,
  providersFor,
  resolveProvider,
  type Stage,
  TTS_VOICES,
} from "../lib/providers.ts";
import {
  DEFAULT_SETTINGS,
  deleteKey,
  type Effort,
  hasKey,
  type JuneSettings,
  loadSettings,
  privacyViolations,
  saveSettings,
  setKey,
  voiceAllowed,
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

async function playBytes(bytes: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
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
    const text = (await transcribe(audio, mime)).trim();
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
    const bytes = await synthesize(TEST_SAMPLE, settings.tts.voice, settings.tts.model);
    const ms = Math.round(performance.now() - t0);
    if (bytes.length === 0) return { ok: false, detail: "No audio returned.", ms };
    await playBytes(bytes);
    return { ok: true, detail: `Spoke a sample in the ${settings.tts.voice} voice.`, ms };
  };

  return (
    <div className="stage-card">
      <div className="stage-row">
        <span className="stage-label">Text to speech</span>
        <ProviderSelect stage="tts" value={settings.tts.provider} onChange={(id) => update(withProvider(settings, "tts", id))} />
        {provider && <ModelInput provider={provider} value={settings.tts.model} onChange={(v) => update({ ...settings, tts: { ...settings.tts, model: v } })} />}
        <select value={settings.tts.voice} onChange={(e) => update({ ...settings, tts: { ...settings.tts, voice: e.target.value } })} title="Voice">
          {TTS_VOICES.map((v) => (
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
 *  suggestion (avoids leaving a model id that doesn't belong to the provider). */
function withProvider(settings: JuneSettings, stage: Stage, providerId: string): JuneSettings {
  const p = resolveProvider(stage, providerId);
  const model = p?.models[0]?.id ?? "";
  const cur = settings[stage];
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
              Say the phrase to start a command without touching the keyboard. Uses cloud speech-to-text to listen for the
              phrase, so it stays off in privacy modes that keep voice on-device.
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

// --- Diagnostics ----------------------------------------------------------

function DiagnosticsSection() {
  const [health, setHealth] = useState<BridgeHealth | null>(null);
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
      <p className="settings-hint">Per-stage latency is shown by each Test button above.</p>
    </section>
  );
}
