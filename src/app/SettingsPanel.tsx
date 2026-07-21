import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { MapTextarea } from "./MapTextarea.tsx";
import {
  bridgeHealth,
  type BridgeHealth,
  buildDiagnosticsReport,
  type ProbeResult,
  testBrain,
} from "../lib/diagnostics.ts";
import { chordFromKeyEvent, hotkeyLabel } from "../lib/hotkey.ts";
import { type LatencySample, latencySamples, percentile, type UsageTotals, usageTotal } from "../lib/latency.ts";
import { type VoiceHealth, voiceHealth } from "../lib/voice-health.ts";
import {
  MCP_CATALOG,
  type McpClass,
  type McpServerEntry,
  type McpTransport,
  slugify,
} from "../lib/mcp-servers.ts";
import { PRIVACY_MODES, type PrivacyMode } from "../lib/privacy.ts";
import { type FileTrigger, type Schedule, type WatchLoop } from "../lib/schedules.ts";
import { runScheduleNow } from "../lib/session.ts";
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
  readLessons,
  readMemory,
  saveSettings,
  setKey,
  voiceAllowed,
  writeLessons,
  writeMemory,
} from "../lib/settings.ts";
import { transcribe } from "../lib/stt.ts";
import { synthesize } from "../lib/tts.ts";
import { LEVEL_GAIN, startCapture } from "../lib/voice-capture.ts";

// The full settings surface (PLAN.md §3-§4, Phase 7). This is the window's
// second face: choose the STT / brain / TTS stack, verify each stage, manage
// API keys (OS-keychain backed), pick a privacy mode, and see diagnostics.
// Selections persist to settings.json and take effect on the next turn - so
// switching a provider never disturbs an in-flight command or pending approval
// (those live in the Rust session, read fresh each turn).

const EFFORTS: Effort[] = ["low", "medium", "high"];
const TEST_SAMPLE = "June is ready when you are.";
const SAVE_DEBOUNCE_MS = 800; // B2.3: coalesce keystroke-driven saves

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

async function playBytes(bytes: Uint8Array, mime: string, volume = 1, sinkId = ""): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const el = new Audio(url);
  el.volume = Math.min(1, Math.max(0, volume));
  // Route the Test sample to the chosen speaker (3.9) so the test exercises the
  // same device real speech will use; ignore an unsupported/failed sink.
  if (sinkId && typeof el.setSinkId === "function") await el.setSinkId(sinkId).catch(() => {});
  await new Promise<void>((resolve) => {
    el.onended = () => resolve();
    el.onerror = () => resolve();
    void el.play().catch(() => resolve());
  }).finally(() => URL.revokeObjectURL(url));
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<JuneSettings | null>(null);
  // A failed debounced save must not be silent (improvement-5 P0.7): the user's
  // edits would quietly not persist. Cleared by the next successful save.
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .catch(() => setSettings(DEFAULT_SETTINGS));
  }, []);

  // Debounced persistence (B2.3): a text field fires update() on every keystroke,
  // and each save respawns the resident and re-broadcasts settings://changed
  // (which churns the wake mic). Coalesce to one save after typing settles; flush
  // any pending save if the window closes so a last change isn't lost.
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<JuneSettings | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current != null && pendingSave.current) {
        clearTimeout(saveTimer.current);
        void saveSettings(pendingSave.current).catch(() => {});
      }
    },
    [],
  );

  // Pick up out-of-band settings changes (B4.10): the widget can learn a transcript
  // correction and save it, or a scheduled run can edit settings. Reload so a later
  // in-panel edit doesn't save over that with a stale copy - but ONLY while no local
  // edit is pending (saveTimer null), so we never clobber what the user is typing.
  useEffect(() => {
    const unlisten = listen("settings://changed", () => {
      if (saveTimer.current != null) return; // mid-edit: our own debounce owns the state
      loadSettings()
        .then(setSettings)
        .catch(() => {});
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  if (!settings) return <div className="settings-view">Loading settings…</div>;

  const update = (next: JuneSettings) => {
    setSettings(next); // UI stays responsive immediately; the write is debounced
    pendingSave.current = next;
    if (saveTimer.current != null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      pendingSave.current = null;
      void saveSettings(next).then(
        () => setSaveFailed(false),
        () => setSaveFailed(true),
      );
    }, SAVE_DEBOUNCE_MS);
  };

  return (
    <div className="settings-view">
      {saveFailed && (
        <p className="err">Couldn't save your settings - recent changes may not persist. They'll retry on your next edit.</p>
      )}
      <ModelsSection settings={settings} update={update} />
      <KeysSection />
      <PrivacySection settings={settings} update={update} />
      <ActivationSection settings={settings} update={update} />
      <HandsFreeSection settings={settings} update={update} />
      <TranscriptSection settings={settings} update={update} />
      <ConversationSection settings={settings} update={update} />
      <MemorySection />
      <LessonsSection />
      <CapabilitiesSection settings={settings} update={update} />
      <AutomationSection settings={settings} update={update} />
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
 *  wired) are shown so the intended stack is visible but cannot be selected.
 *  `label` names the control for assistive tech (6.4) - the visual row label is
 *  a plain span, so the select must carry its own name. */
function ProviderSelect({
  stage,
  label,
  value,
  onChange,
}: {
  stage: Stage;
  label: string;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} aria-label={`${label} provider`} onChange={(e) => onChange(e.target.value)}>
      {providersFor(stage).map((p) => (
        <option key={p.id} value={p.id} disabled={!p.available}>
          {p.label}
          {p.available ? "" : " - coming soon"}
        </option>
      ))}
    </select>
  );
}

function ModelInput({
  provider,
  label,
  value,
  onChange,
}: {
  provider: Provider;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const listId = `models-${provider.id}`;
  return (
    <>
      <input
        list={listId}
        value={value}
        aria-label={`${label} model`}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model id"
      />
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

/** An audio device picker, refreshed on plug/unplug. `kind` selects input
 *  (microphone, 6.5) or output (speaker/headset, 3.9). Labels are empty until the
 *  mic permission has been granted once - fall back to a numbered name. */
function DevicePicker({
  kind,
  value,
  onChange,
}: {
  kind: "audioinput" | "audiooutput";
  value: string;
  onChange: (id: string) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const refresh = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((ds) => setDevices(ds.filter((d) => d.kind === kind && d.deviceId)))
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [kind]);
  const noun = kind === "audioinput" ? "Microphone" : "Speaker";
  return (
    <select value={value} aria-label={noun} onChange={(e) => onChange(e.target.value)}>
      <option value="">System default</option>
      {devices.map((d, i) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `${noun} ${i + 1}`}
        </option>
      ))}
    </select>
  );
}

function SttCard({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const provider = resolveProvider("stt", settings.stt.provider);
  const [busy, setBusy] = useState(false);
  // Live input level while the test records (improvement-5 P2 6.8): null when not
  // recording. Without it the 2.5s capture had no "speak now" indication at all.
  const [level, setLevel] = useState<number | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const runTest = async () => {
    setBusy(true);
    setResult(null);
    let meter: number | null = null;
    try {
      const t0 = performance.now();
      const handle = await startCapture({
        onEndpoint: () => {},
        maxMs: 3000,
        deviceId: settings.micDeviceId || undefined,
      });
      setLevel(0);
      meter = window.setInterval(() => setLevel(handle.level()), 90);
      await new Promise((r) => setTimeout(r, 2500));
      window.clearInterval(meter);
      meter = null;
      setLevel(null);
      const { audio, mime } = await handle.stop();
      if (audio.length === 0) {
        setResult({ ok: false, detail: "No audio captured - is the microphone allowed?", ms: 0 });
        return;
      }
      const text = (await transcribe(audio, mime, settings.stt)).trim();
      const ms = Math.round(performance.now() - t0);
      setResult(
        text
          ? { ok: true, detail: `Heard: "${text}"`, ms }
          : { ok: false, detail: "Transcription came back empty - try speaking during the test.", ms },
      );
    } catch (e) {
      setResult({ ok: false, detail: msg(e), ms: 0 });
    } finally {
      if (meter != null) window.clearInterval(meter);
      setLevel(null);
      setBusy(false);
    }
  };

  return (
    <div className="stage-card">
      <div className="stage-row">
        <span className="stage-label">Speech to text</span>
        <ProviderSelect
          stage="stt"
          label="Speech to text"
          value={settings.stt.provider}
          onChange={(id) => update(withProvider(settings, "stt", id))}
        />
        {provider && (
          <ModelInput
            provider={provider}
            label="Speech to text"
            value={settings.stt.model}
            onChange={(v) => update({ ...settings, stt: { ...settings.stt, model: v } })}
          />
        )}
      </div>
      <div className="stage-row">
        <span className="stage-label">Microphone</span>
        <DevicePicker kind="audioinput" value={settings.micDeviceId} onChange={(id) => update({ ...settings, micDeviceId: id })} />
      </div>
      <div className="settings-test">
        <button onClick={runTest} disabled={busy}>
          {busy ? "Testing…" : "Test"}
        </button>
        {level !== null && (
          <span className="stt-live" role="status">
            Speak now…
            <span className="stt-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(level * LEVEL_GAIN, 1) * 100}%` }} />
            </span>
          </span>
        )}
        {result && (
          <span className={`test-result ${result.ok ? "ok" : "bad"}`}>
            {result.ok ? "✓" : "✗"} {result.detail}
            {result.ms ? ` (${result.ms} ms)` : ""}
          </span>
        )}
      </div>
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
        <ProviderSelect stage="brain" label="Brain" value={settings.brain.provider} onChange={(id) => update(withProvider(settings, "brain", id))} />
        {provider && (
          <ModelInput provider={provider} label="Brain" value={settings.brain.model} onChange={(v) => update({ ...settings, brain: { ...settings.brain, model: v } })} />
        )}
        <select
          value={settings.brain.effort}
          onChange={(e) => update({ ...settings, brain: { ...settings.brain, effort: e.target.value as Effort } })}
          title="Reasoning effort"
          aria-label="Reasoning effort"
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
            aria-label="Brain endpoint URL"
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
    await playBytes(bytes, mime, settings.outputVolume, settings.outputDeviceId);
    return { ok: true, detail: `Spoke a sample in the ${settings.tts.voice} voice.`, ms };
  };

  return (
    <div className="stage-card">
      <div className="stage-row">
        <span className="stage-label">Text to speech</span>
        <ProviderSelect stage="tts" label="Text to speech" value={settings.tts.provider} onChange={(id) => update(withProvider(settings, "tts", id))} />
        {provider && <ModelInput provider={provider} label="Text to speech" value={settings.tts.model} onChange={(v) => update({ ...settings, tts: { ...settings.tts, model: v } })} />}
        <select
          value={settings.tts.voice}
          onChange={(e) => update({ ...settings, tts: { ...settings.tts, voice: e.target.value } })}
          title="Voice"
          aria-label="Voice"
        >
          {voicesFor(settings.tts.provider).map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div className="stage-row">
        <span className="stage-label">Speaker</span>
        <DevicePicker kind="audiooutput" value={settings.outputDeviceId} onChange={(id) => update({ ...settings, outputDeviceId: id })} />
      </div>
      <div className="stage-row">
        <span className="stage-label">Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.outputVolume}
          aria-label="Speech output volume"
          onChange={(e) => update({ ...settings, outputVolume: Number(e.target.value) })}
        />
        <span className="settings-hint">{Math.round(settings.outputVolume * 100)}%</span>
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
      <input
        type="password"
        placeholder={present ? "Replace key…" : "sk-…"}
        aria-label={`${label} API key`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save(); // 6.3: Enter saves, same as the button
        }}
      />
      <button className="primary" onClick={save} disabled={busy || !value.trim()}>
        Save
      </button>
      <button onClick={clear} disabled={busy || present !== true}>
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

  // Configurable PTT hotkey (improvement-5 P2 6.6). `verified` flips when the
  // chord actually arrives as a global ptt://down - the first-run verification -
  // and Rust reports registration failures (chord taken, unparseable) as
  // ptt://status, falling back to the default chord so PTT never dies.
  const [verified, setVerified] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  // Quick-capture hotkey (improvement-6 4.5): its own verify/error state, driven by
  // the parallel capture://down / capture://status events Rust emits for the second
  // chord. Empty captureHotkey means quick capture is off (no chord registered).
  const [captureVerified, setCaptureVerified] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  useEffect(() => {
    const unlisten = [
      listen("ptt://down", () => setVerified(true)),
      listen<{ ok: boolean; error?: string | null }>("ptt://status", (e) =>
        setHotkeyError(e.payload.ok ? null : (e.payload.error ?? "Couldn't register that hotkey.")),
      ),
      listen("capture://down", () => setCaptureVerified(true)),
      listen<{ ok: boolean; error?: string | null }>("capture://status", (e) =>
        setCaptureError(e.payload.ok ? null : (e.payload.error ?? "Couldn't register that hotkey.")),
      ),
    ];
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, []);

  return (
    <section className="settings-section">
      <h2>Activation</h2>

      <div className="stage-card">
        <div className="stage-row">
          <span className="stage-label">Push to talk</span>
          <input
            className="hotkey-input"
            value={hotkeyLabel(settings.pttHotkey)}
            readOnly
            aria-label="Push-to-talk hotkey. Focus this field and press a new key combination to change it."
            title="Click, then press the new key combination"
            onKeyDown={(e) => {
              if (e.key === "Tab") return; // keep keyboard navigation working
              e.preventDefault();
              const chord = chordFromKeyEvent(e);
              if (chord && chord !== settings.pttHotkey) {
                setVerified(false);
                update({ ...settings, pttHotkey: chord });
              }
            }}
          />
          <span className="settings-hint">
            {verified
              ? "✓ Verified - June heard the hotkey."
              : "Click the field and press the keys you want (a modifier plus a key), then press the hotkey anywhere to verify."}
          </span>
        </div>
        {hotkeyError && (
          <p className="err" role="alert">
            {hotkeyError}
          </p>
        )}
      </div>

      <div className="stage-card">
        <div className="stage-row">
          <span className="stage-label">Quick capture</span>
          <input
            className="hotkey-input"
            value={settings.captureHotkey ? hotkeyLabel(settings.captureHotkey) : "Off"}
            readOnly
            aria-label="Quick-capture hotkey. Focus this field and press a key combination to set it; press Backspace to turn it off."
            title="Click, then press the new key combination (or Backspace to turn off)"
            onKeyDown={(e) => {
              if (e.key === "Tab") return; // keep keyboard navigation working
              e.preventDefault();
              // Backspace/Delete turns quick capture off (clears the chord).
              if (e.key === "Backspace" || e.key === "Delete") {
                if (settings.captureHotkey !== "") {
                  setCaptureVerified(false);
                  setCaptureError(null);
                  update({ ...settings, captureHotkey: "" });
                }
                return;
              }
              const chord = chordFromKeyEvent(e);
              if (chord && chord !== settings.captureHotkey) {
                setCaptureVerified(false);
                update({ ...settings, captureHotkey: chord });
              }
            }}
          />
          <span className="settings-hint">
            {!settings.captureHotkey
              ? "Off. Click the field and press a chord (a modifier plus a key) to jot notes straight to your inbox by voice."
              : captureVerified
                ? "✓ Verified - hold it, speak, and the note lands in june-inbox.md."
                : "Hold it and speak to jot a note to june-inbox.md (no reply, just a chime). Press it anywhere to verify; Backspace turns it off."}
          </span>
        </div>
        {captureError && (
          <p className="err" role="alert">
            {captureError}
          </p>
        )}
      </div>

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
                aria-label="Wake phrase"
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
                aria-label="Wake sensitivity"
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
        Turn on <strong>dictation</strong> from the widget (the keyboard icon), then hold{" "}
        <kbd>{hotkeyLabel(settings.pttHotkey)}</kbd> to type your speech into whatever app is focused. Cleaning below
        applies to both dictation and spoken commands, and runs entirely on-device.
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
        <MapTextarea
          className="memory-text"
          rows={4}
          map={t.dictionary}
          onCommit={(m) => setT({ dictionary: m })}
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
        <MapTextarea
          className="memory-text"
          rows={4}
          map={t.snippets}
          onCommit={(m) => setT({ snippets: m })}
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
            aria-label="Minutes idle before a new conversation starts"
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

// --- Memory & Lessons -----------------------------------------------------

// One shared surface for June's two user-editable notes files: long-term memory
// (PLAN.md Phase 11.4, june-memory.md) and post-run task lessons (improvement-4
// Phase 17.1, june-lessons.md). Both are kept out of settings.json and are
// local-only (no network). The section renders its full chrome while the file
// read is in flight (improvement-5 P2 6.12) so the settings page doesn't pop and
// reflow when the reads resolve.
function NotesSection({
  title,
  hint,
  read,
  write,
  placeholder,
}: {
  title: string;
  hint: string;
  read: () => Promise<string>;
  write: (content: string) => Promise<void>;
  placeholder: string;
}) {
  const [text, setText] = useState<string | null>(null); // null = still loading
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    read()
      .then((m) => {
        setText(m);
        setSaved(m);
      })
      .catch(() => setText(""));
  }, [read]);

  const loading = text === null;
  const dirty = !loading && text !== saved;

  const save = async (value: string) => {
    setBusy(true);
    try {
      await write(value);
      setText(value);
      setSaved(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <p className="settings-hint">{hint}</p>
      <div className="stage-card">
        <textarea
          className="memory-text"
          value={text ?? ""}
          disabled={loading}
          aria-label={title}
          onChange={(e) => setText(e.target.value)}
          placeholder={loading ? "Loading…" : placeholder}
          rows={6}
        />
        <div className="settings-test">
          <button className="primary" onClick={() => text !== null && save(text)} disabled={loading || busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => save("")}
            disabled={loading || busy || ((text?.length ?? 0) === 0 && saved.length === 0)}
          >
            Clear
          </button>
        </div>
      </div>
    </section>
  );
}

function MemorySection() {
  return (
    <NotesSection
      title="Memory"
      hint="What June remembers about you across conversations. June saves durable facts here on its own; you can edit or clear them. Stored on-device only."
      read={readMemory}
      write={writeMemory}
      placeholder="June hasn't remembered anything yet."
    />
  );
}

function LessonsSection() {
  return (
    <NotesSection
      title="Lessons"
      hint="What June has learned from past tasks. June saves a short lesson after a task on its own and recalls the relevant ones next time; you can edit or clear them. Stored on-device only."
      read={readLessons}
      write={writeLessons}
      placeholder="June hasn't learned any task lessons yet."
    />
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

// env / headers are edited as `KEY=value` lines (the same shape Claude Desktop's
// mcp.json uses) via MapTextarea (./MapTextarea.tsx), which keeps a half-typed
// line alive instead of eating its first character (B2.4). Not for long-lived
// secrets in a shared file, but it is how the MCP ecosystem passes tokens today;
// a keychain-per-server surface is a follow-up.

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
            <MapTextarea
              className="memory-text mcp-env"
              rows={2}
              map={t.env}
              onCommit={(m) => setTransport({ ...t, env: m })}
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
            <MapTextarea
              className="memory-text mcp-env"
              rows={2}
              map={t.headers}
              onCommit={(m) => setTransport({ ...t, headers: m })}
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

/** Fire one schedule on demand (2.4): a one-off unattended run so the user can test
 *  a 9am briefing without waiting for 9am. Reads the SAVED schedule from disk, so a
 *  just-typed edit needs its debounced save to land first (hence the hint). Result
 *  lands in the Runs tab. Disabled for a schedule with an empty prompt (nothing to
 *  run). */
function RunNowButton({ id, disabled }: { id: string; disabled: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const run = () => {
    setNote(null);
    void runScheduleNow(id)
      .then(() => setNote("Started - watch the Runs tab."))
      .catch((e) => setNote(msg(e)));
  };
  return (
    <>
      <button onClick={run} disabled={disabled} title="Run this saved schedule once now">
        Run now
      </button>
      {note && <span className="settings-hint">{note}</span>}
    </>
  );
}

// --- Automation (Phase 18) ------------------------------------------------
// Scheduled runs and file-watch triggers. Both fire UNATTENDED: any action that
// needs approval is blocked automatically (18.2), never auto-approved, and the
// audit log records everything the run did. All opt-in, off by default.

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function AutomationSection({ settings, update }: { settings: JuneSettings; update: (s: JuneSettings) => void }) {
  const { schedules, triggers, watches } = settings;

  const setSchedules = (next: Schedule[]) => update({ ...settings, schedules: next });
  const setTriggers = (next: FileTrigger[]) => update({ ...settings, triggers: next });
  const setWatches = (next: WatchLoop[]) => update({ ...settings, watches: next });

  const freshId = (base: string, taken: { id: string }[]): string => {
    if (!taken.some((t) => t.id === base)) return base;
    for (let n = 2; ; n++) if (!taken.some((t) => t.id === `${base}-${n}`)) return `${base}-${n}`;
  };

  const addSchedule = () =>
    setSchedules([
      ...schedules,
      { id: freshId("schedule", schedules), label: "New schedule", prompt: "", kind: "daily", time: "09:00", days: [], everyMinutes: 60, at: "", enabled: false },
    ]);
  const addTrigger = () =>
    setTriggers([
      ...triggers,
      { id: freshId("trigger", triggers), label: "New trigger", path: "", prompt: "", enabled: false },
    ]);
  const addWatch = () =>
    setWatches([
      ...watches,
      { id: freshId("watch", watches), label: "New watch", prompt: "", everyMinutes: 10, untilCondition: "", enabled: false },
    ]);

  const patchSchedule = (id: string, p: Partial<Schedule>) =>
    setSchedules(schedules.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const patchTrigger = (id: string, p: Partial<FileTrigger>) =>
    setTriggers(triggers.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const patchWatch = (id: string, p: Partial<WatchLoop>) =>
    setWatches(watches.map((w) => (w.id === id ? { ...w, ...p } : w)));

  return (
    <section className="settings-section">
      <h2>Automation</h2>
      <p className="settings-hint">
        June can run on a schedule or when a file changes - <strong>unattended</strong>. Any action that needs approval is
        blocked automatically and you're notified; June never approves its own actions. Every run is in the audit log.
      </p>

      <h3 className="settings-subhead">Scheduled runs</h3>
      {schedules.map((s) => (
        <div key={s.id} className="stage-card">
          <div className="stage-row">
            <input
              className="wide"
              value={s.label}
              onChange={(e) => patchSchedule(s.id, { label: e.target.value })}
              placeholder="Morning briefing"
            />
            <label className="wake-toggle">
              <input type="checkbox" checked={s.enabled} onChange={(e) => patchSchedule(s.id, { enabled: e.target.checked })} />
              <span>Enabled</span>
            </label>
            <RunNowButton id={s.id} disabled={!s.prompt.trim()} />
            <button onClick={() => setSchedules(schedules.filter((x) => x.id !== s.id))}>Remove</button>
          </div>
          {/* A `once` reminder (improvement-6 4.1) is created by voice and retires
              itself after firing, so it is read-only here - only its one-time fire
              time is shown, not the recurring daily/every controls. */}
          {s.kind === "once" ? (
            <div className="stage-row">
              <span className="stage-label">Reminder</span>
              <span className="settings-hint">one-time at {s.at || "—"} (created by voice)</span>
            </div>
          ) : (
            <div className="stage-row">
              <span className="stage-label">Repeat</span>
              <select
                value={s.kind}
                onChange={(e) => patchSchedule(s.id, { kind: e.target.value === "every" ? "every" : "daily" })}
                title="How this schedule recurs"
                aria-label="How this schedule recurs"
              >
                <option value="daily">Daily at a time</option>
                <option value="every">Every N minutes</option>
              </select>
            </div>
          )}
          {s.kind === "once" ? null : s.kind === "every" ? (
            <div className="stage-row">
              <span className="stage-label">Every</span>
              <input
                type="number"
                min={1}
                className="num"
                value={s.everyMinutes}
                onChange={(e) => patchSchedule(s.id, { everyMinutes: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              <span className="settings-hint">minutes</span>
            </div>
          ) : (
            <div className="stage-row">
              <span className="stage-label">At</span>
              <input
                type="time"
                value={s.time}
                aria-label="Time of day"
                onChange={(e) => patchSchedule(s.id, { time: e.target.value || "09:00" })}
              />
              <span className="settings-hint">
                {DAY_LABELS.map((lbl, d) => {
                  const on = s.days.includes(d);
                  return (
                    <button
                      key={d}
                      className={on ? "day-on" : "day-off"}
                      aria-pressed={on}
                      aria-label={DAY_NAMES[d]}
                      onClick={() =>
                        patchSchedule(s.id, {
                          days: on ? s.days.filter((x) => x !== d) : [...s.days, d].sort((a, b) => a - b),
                        })
                      }
                    >
                      {lbl}
                    </button>
                  );
                })}
                {s.days.length === 0 ? " every day" : ""}
              </span>
            </div>
          )}
          <textarea
            className="memory-text"
            value={s.prompt}
            onChange={(e) => patchSchedule(s.id, { prompt: e.target.value })}
            placeholder="Give me a short briefing of today's calendar and any unread priority mail."
            rows={2}
          />
        </div>
      ))}
      <div className="settings-test">
        <button onClick={addSchedule}>Add schedule</button>
      </div>

      <h3 className="settings-subhead">File triggers</h3>
      <p className="settings-hint">
        When the watched file changes, June opens an investigation with the file's new contents as context. That content is
        treated as <strong>untrusted</strong> - information only, never instructions - and can never authorize an action.
      </p>
      {triggers.map((t) => (
        <div key={t.id} className="stage-card">
          <div className="stage-row">
            <input
              className="wide"
              value={t.label}
              onChange={(e) => patchTrigger(t.id, { label: e.target.value })}
              placeholder="Error log watch"
            />
            <label className="wake-toggle">
              <input type="checkbox" checked={t.enabled} onChange={(e) => patchTrigger(t.id, { enabled: e.target.checked })} />
              <span>Enabled</span>
            </label>
            <button onClick={() => setTriggers(triggers.filter((x) => x.id !== t.id))}>Remove</button>
          </div>
          <div className="stage-row">
            <span className="stage-label">Watch file</span>
            <input
              className="wide"
              value={t.path}
              onChange={(e) => patchTrigger(t.id, { path: e.target.value })}
              placeholder="C:\logs\app\error.log"
            />
          </div>
          <textarea
            className="memory-text"
            value={t.prompt}
            onChange={(e) => patchTrigger(t.id, { prompt: e.target.value })}
            placeholder="Summarize the newest error and suggest a likely cause."
            rows={2}
          />
        </div>
      ))}
      <div className="settings-test">
        <button onClick={addTrigger}>Add trigger</button>
      </div>

      <h3 className="settings-subhead">Watch loops</h3>
      <p className="settings-hint">
        June re-checks something on an interval and stops when a condition holds - "check the build every ten minutes until
        it's green". Each check is <strong>unattended</strong> (observe-only), and June stops after {30} checks even if the
        condition never comes true.
      </p>
      {watches.map((w) => (
        <div key={w.id} className="stage-card">
          <div className="stage-row">
            <input
              className="wide"
              value={w.label}
              onChange={(e) => patchWatch(w.id, { label: e.target.value })}
              placeholder="Build watch"
            />
            <label className="wake-toggle">
              <input type="checkbox" checked={w.enabled} onChange={(e) => patchWatch(w.id, { enabled: e.target.checked })} />
              <span>Enabled</span>
            </label>
            <button onClick={() => setWatches(watches.filter((x) => x.id !== w.id))}>Remove</button>
          </div>
          <div className="stage-row">
            <span className="stage-label">Every</span>
            <input
              type="number"
              min={1}
              className="num"
              value={w.everyMinutes}
              onChange={(e) => patchWatch(w.id, { everyMinutes: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            />
            <span className="settings-hint">minutes</span>
          </div>
          <textarea
            className="memory-text"
            value={w.prompt}
            onChange={(e) => patchWatch(w.id, { prompt: e.target.value })}
            placeholder="Check whether the CI build for the main branch has finished."
            rows={2}
          />
          <div className="stage-row">
            <span className="stage-label">Until</span>
            <input
              className="wide"
              value={w.untilCondition}
              onChange={(e) => patchWatch(w.id, { untilCondition: e.target.value })}
              placeholder="the build is green"
            />
          </div>
        </div>
      ))}
      <div className="settings-test">
        <button onClick={addWatch}>Add watch loop</button>
      </div>
    </section>
  );
}

// --- Diagnostics ----------------------------------------------------------

function DiagnosticsSection() {
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [latency, setLatency] = useState<LatencySample[]>([]);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [voice, setVoice] = useState<VoiceHealth>({});
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
    // Latency and usage are best-effort and independent of the bridge probe: no
    // backend (plain browser / tests) just leaves the readouts empty.
    await latencySamples()
      .then(setLatency)
      .catch(() => {});
    await usageTotal()
      .then(setUsage)
      .catch(() => {});
    await voiceHealth()
      .then(setVoice)
      .catch(() => {});
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Export a redacted diagnostics bundle for support (16.5). Everything shown here
  // is already redacted (no endpoint/token/detail, no transcript); we just serialize
  // it and hand the user a downloadable JSON via a blob URL.
  const exportReport = () => {
    const report = buildDiagnosticsReport(health, latency, new Date().toISOString());
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `june-diagnostics-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
      <UsageReadout usage={usage} />
      <VoiceHealthReadout health={voice} />
      <div className="diag-row">
        <button onClick={exportReport}>Export diagnostics</button>
        <span className="settings-hint">Redacted JSON (versions + latency, no keys or transcript) for support.</span>
      </div>
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
  // Acceptance targets (improvement-4 §6): P50 under 1s, P95 under 2s. P50 also
  // tracks the tighter 800ms voice-to-voice line (11.5). Both percentiles are
  // colored against their own target so the dashboard reads pass/fail at a glance.
  return (
    <div className="diag-latency">
      <div className="diag-row">
        <span className="stage-label">Voice-to-voice</span>
        <span className={`test-result ${p50 <= 800 ? "ok" : "bad"}`}>P50 {p50} ms</span>
        <span className={`test-result ${p95 <= 2000 ? "ok" : "bad"}`}>P95 {p95} ms</span>
        <span className="settings-hint">
          {samples.length} turn{samples.length === 1 ? "" : "s"} · targets P50 ≤ 800 ms · P95 ≤ 2000 ms
        </span>
      </div>
      <p className="settings-hint">
        Median stages: speech-to-text {stage((s) => s.stt)} ms · brain {stage((s) => s.brain)} ms · text-to-speech{" "}
        {stage((s) => s.tts)} ms
      </p>
    </div>
  );
}

// Cumulative token/cost for the session (2.6): both brains report tokens; only
// Claude prices the call, so the cost line shows only when a dollar figure landed.
function UsageReadout({ usage }: { usage: UsageTotals | null }) {
  if (!usage || usage.turns === 0) {
    return <p className="settings-hint">Token usage: no turns this session yet.</p>;
  }
  const fmt = (n: number) => n.toLocaleString();
  return (
    <div className="diag-row">
      <span className="stage-label">Session usage</span>
      <span className="test-result">
        {fmt(usage.inputTokens)} in · {fmt(usage.outputTokens)} out
      </span>
      {usage.costUsd > 0 && <span className="test-result">${usage.costUsd.toFixed(4)}</span>}
      <span className="settings-hint">
        {usage.turns} turn{usage.turns === 1 ? "" : "s"} this session
      </span>
    </div>
  );
}

// Voice-stack health (2.7): which path each VAD/wake subsystem is actually running,
// so a silent Silero/openWakeWord asset-load failure (degraded to RMS / cloud-burst /
// off) is visible instead of an unexplained accuracy drop. Only the local-first
// paths (silero/local) read "ok"; a fallback reads "bad" with its load error.
function VoiceHealthReadout({ health }: { health: VoiceHealth }) {
  const rows = Object.entries(health);
  if (rows.length === 0) {
    return <p className="settings-hint">Voice stack: no turns this session yet - speak to see VAD/wake health.</p>;
  }
  const label: Record<string, string> = { barge: "Barge-in VAD", endpointing: "Endpointing VAD", wake: "Wake word" };
  const good = new Set(["silero", "local"]);
  return (
    <div className="diag-latency">
      {rows.map(([id, s]) => (
        <div className="diag-row" key={id}>
          <span className="stage-label">{label[id] ?? id}</span>
          <span className={`test-result ${good.has(s.path) ? "ok" : "bad"}`}>{s.path}</span>
          {s.error && <span className="settings-hint">fell back: {s.error}</span>}
        </div>
      ))}
    </div>
  );
}
