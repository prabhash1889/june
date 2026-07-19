import { invoke } from "@tauri-apps/api/core";

import { type PrivacyMode, providerAllowed } from "./privacy.ts";
import { PROVIDERS, resolveProvider, type Stage } from "./providers.ts";

// June's typed settings (PLAN.md §4, Phase 7). Persisted to
// `<app_data_dir>/settings.json` by the Rust side (src-tauri/src/settings.rs) as
// a plain JSON bag. This module is the typed view over that bag: it reads with
// defaults (so an old or partial file still loads) and writes by MERGING over the
// raw bag, so keys June's typed schema doesn't know about (e.g. window-state's
// own fields) are never clobbered.

export type Effort = "low" | "medium" | "high";

export interface StageChoice {
  provider: string;
  model: string;
}

/** Hands-free activation (PLAN.md Phase 8). Off by default: PTT is the
 *  zero-false-trigger baseline; wake word is opt-in. */
export interface WakeConfig {
  enabled: boolean;
  phrase: string;
  /** 0..1; higher = stricter phrase match (fewer false triggers, lower recall). */
  sensitivity: number;
}

/** The local files capability (PLAN.md Phase 9) - a non-saple MCP server proving
 *  June is general-purpose. Off by default: the filesystem is only exposed once
 *  the user opts in and scopes it to a folder. Local/offline-safe. */
export interface FilesConfig {
  enabled: boolean;
  /** Absolute path to the one folder June may read/write. */
  root: string;
}

export interface JuneSettings {
  stt: StageChoice;
  brain: StageChoice & { effort: Effort };
  tts: StageChoice & { voice: string };
  /** Base URL for the brain when its provider allows a custom endpoint. */
  brainBaseUrl: string;
  /** Start a fresh conversation after this many idle minutes (Phase 11.2).
   *  0 = never auto-reset; the conversation persists until "new conversation". */
  conversationIdleMinutes: number;
  privacyMode: PrivacyMode;
  wake: WakeConfig;
  files: FilesConfig;
}

export const DEFAULT_SETTINGS: JuneSettings = {
  stt: { provider: "openai", model: "whisper-1" },
  brain: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
  tts: { provider: "openai", model: "tts-1", voice: "alloy" },
  brainBaseUrl: "",
  conversationIdleMinutes: 10,
  privacyMode: "standard",
  wake: { enabled: false, phrase: "hey june", sensitivity: 0.5 },
  files: { enabled: false, root: "" },
};

/** Raw bag persisted by Rust. Kept alongside the typed view so a save can merge
 *  over it and never drop unknown keys. */
type RawSettings = Record<string, unknown>;

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** Clamp an arbitrary value to a 0..1 number, falling back when it isn't one. */
function unit(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Coerce to a non-negative whole number, falling back when it isn't one. */
function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Coerce an arbitrary bag into a valid JuneSettings, falling back per-field to
 *  the defaults. A provider/model that no longer exists in the registry falls
 *  back so the UI never renders a dangling selection. */
function coerce(raw: RawSettings): JuneSettings {
  const d = DEFAULT_SETTINGS;
  const obj = (k: string): RawSettings => (typeof raw[k] === "object" && raw[k] !== null ? (raw[k] as RawSettings) : {});
  const stage = (k: Stage, fallback: StageChoice): StageChoice => {
    const s = obj(k);
    const provider = resolveProvider(k, str(s.provider, fallback.provider)) ? str(s.provider, fallback.provider) : fallback.provider;
    return { provider, model: str(s.model, fallback.model) };
  };
  const efforts: Effort[] = ["low", "medium", "high"];
  const modes: PrivacyMode[] = ["standard", "local-voice", "strict-offline"];
  const brainEffort = obj("brain").effort;
  const mode = raw.privacyMode;
  const wake = obj("wake");
  const files = obj("files");
  return {
    stt: stage("stt", d.stt),
    brain: {
      ...stage("brain", d.brain),
      effort: efforts.includes(brainEffort as Effort) ? (brainEffort as Effort) : d.brain.effort,
    },
    tts: { ...stage("tts", d.tts), voice: str(obj("tts").voice, d.tts.voice) },
    brainBaseUrl: str(raw.brainBaseUrl, d.brainBaseUrl),
    conversationIdleMinutes: nonNegInt(raw.conversationIdleMinutes, d.conversationIdleMinutes),
    privacyMode: modes.includes(mode as PrivacyMode) ? (mode as PrivacyMode) : d.privacyMode,
    wake: {
      enabled: typeof wake.enabled === "boolean" ? wake.enabled : d.wake.enabled,
      phrase: str(wake.phrase, d.wake.phrase),
      sensitivity: unit(wake.sensitivity, d.wake.sensitivity),
    },
    files: {
      enabled: typeof files.enabled === "boolean" ? files.enabled : d.files.enabled,
      root: str(files.root, d.files.root),
    },
  };
}

export async function loadSettings(): Promise<JuneSettings> {
  const raw = await invoke<RawSettings>("load_settings").catch(() => ({}));
  return coerce(raw ?? {});
}

/** Persist the typed settings, merged over the current raw bag so unknown keys
 *  survive. Reads the bag fresh to avoid clobbering a concurrent writer's keys. */
export async function saveSettings(settings: JuneSettings): Promise<void> {
  const raw = (await invoke<RawSettings>("load_settings").catch(() => ({}))) ?? {};
  await invoke("save_settings", { settings: { ...raw, ...settings } });
}

// --- Keychain (secrets never touch settings.json; they live in the OS keychain) ---

export function hasKey(service: string): Promise<boolean> {
  return invoke<boolean>("has_api_key", { service });
}

export function setKey(service: string, key: string): Promise<void> {
  return invoke("set_api_key", { service, key });
}

export function deleteKey(service: string): Promise<void> {
  return invoke("delete_api_key", { service });
}

// --- Long-term memory (Phase 11.4) ---
// June's one user-editable memory file, kept out of settings.json - it is its own
// `june-memory.md` in the app data dir. `writeMemory("")` is the "clear" action.

export function readMemory(): Promise<string> {
  return invoke<string>("read_memory");
}

export function writeMemory(content: string): Promise<void> {
  return invoke("write_memory", { content });
}

/** A stage whose chosen provider is not allowed under the current privacy mode.
 *  Drives both the settings warning and the runtime block. */
export interface Violation {
  stage: Stage;
  providerLabel: string;
  message: string;
}

/** All stages whose selected provider violates the current privacy mode. Empty
 *  when the stack is compliant. Pure - the same result the run path enforces. */
export function privacyViolations(settings: JuneSettings): Violation[] {
  const out: Violation[] = [];
  const stageChoice: Record<Stage, string> = {
    stt: settings.stt.provider,
    brain: settings.brain.provider,
    tts: settings.tts.provider,
  };
  for (const stage of ["stt", "brain", "tts"] as Stage[]) {
    const provider = resolveProvider(stage, stageChoice[stage]);
    if (!provider) continue;
    if (!providerAllowed(settings.privacyMode, stage, provider)) {
      out.push({
        stage,
        providerLabel: provider.label,
        message: `${provider.label} sends data over the network, which this privacy mode blocks for the ${stage} stage.`,
      });
    }
  }
  return out;
}

/** Whether the voice stack (STT + TTS) may run under the current mode - used by
 *  the voice surface to disable the mic rather than fail mid-capture. */
export function voiceAllowed(settings: JuneSettings): boolean {
  return !privacyViolations(settings).some((v) => v.stage === "stt" || v.stage === "tts");
}

const OPENAI_KEY_SERVICE = "june_provider_openai_api_key";

/** Whether the selected voice stack (STT or TTS) actually needs the OpenAI key.
 *  The widget uses this to only demand a key when the chosen stack uses it, and
 *  never when voice is off for the mode (10.6) - so picking a local/keyless stack
 *  or a strict privacy mode doesn't nag for a key it will never call. */
export function voiceNeedsOpenAiKey(settings: JuneSettings): boolean {
  return (["stt", "tts"] as Stage[]).some((stage) => {
    const p = resolveProvider(stage, settings[stage].provider);
    return p?.keyService === OPENAI_KEY_SERVICE;
  });
}

export { PROVIDERS };
