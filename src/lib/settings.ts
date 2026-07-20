import { invoke } from "@tauri-apps/api/core";

import { coerceMcpServers, type McpServerEntry } from "./mcp-servers.ts";
import { type PrivacyMode, providerAllowed } from "./privacy.ts";
import { PROVIDERS, resolveProvider, type Stage } from "./providers.ts";
import type { TermMap } from "./transcript.ts";

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

/** Hands-free & conversational voice UX (PLAN.md Phase 14). Every field is
 *  opt-in: manual review + click-to-approve stays the default, so June never
 *  auto-acts until the user turns one of these on. */
export interface HandsFreeConfig {
  /** 14.1: the review card auto-sends after a short countdown; any edit pauses it. */
  autoAccept: boolean;
  /** 14.2: June speaks the repeat-back and takes a spoken yes/no - but only for
   *  EXPENSIVE actions. Destructive/external effects still require a click. */
  spokenApprovals: boolean;
  /** 14.3: after each reply the mic reopens briefly (no wake word) for a natural
   *  back-and-forth. */
  followUp: boolean;
  /** 14.4: a brief spoken "on it" when a turn starts tool calls. */
  backchannel: boolean;
}

/** Transcript quality & dictation (PLAN.md Phase 15). All local, no network: the
 *  cleaner (transcript.ts) runs on-device, so these apply in every privacy mode.
 *  `dictionary` and `snippets` are lowercased-key -> replacement maps, editable in
 *  settings and grown automatically from review-gate corrections (15.2). */
export interface TranscriptConfig {
  /** 15.1: run the cosmetic cleanup (strip fillers, fix punctuation) before the
   *  review gate and before dictation injection. Off by default. */
  autoEdit: boolean;
  /** 15.2: heard-term -> correction, applied whole-word to every transcript. */
  dictionary: TermMap;
  /** 15.3: spoken cue -> saved expansion ("insert my intro"). */
  snippets: TermMap;
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
  handsFree: HandsFreeConfig;
  transcript: TranscriptConfig;
  files: FilesConfig;
  /** User-added MCP capability servers (Phase 13). Empty by default: June ships
   *  with only its built-in capabilities; the user adds any others here. */
  mcpServers: McpServerEntry[];
}

export const DEFAULT_SETTINGS: JuneSettings = {
  stt: { provider: "openai", model: "whisper-1" },
  brain: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
  tts: { provider: "openai", model: "tts-1", voice: "alloy" },
  brainBaseUrl: "",
  conversationIdleMinutes: 10,
  privacyMode: "standard",
  wake: { enabled: false, phrase: "hey june", sensitivity: 0.5 },
  handsFree: { autoAccept: false, spokenApprovals: false, followUp: false, backchannel: false },
  transcript: { autoEdit: false, dictionary: {}, snippets: {} },
  files: { enabled: false, root: "" },
  mcpServers: [],
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

/** Coerce an arbitrary value into a string->string term map (dictionary/snippets),
 *  dropping non-string cells and capping the entry count so a corrupt or runaway
 *  file can't bloat the settings bag. Keys are lowercased so matching is stable. */
function termMap(v: unknown, cap = 200): TermMap {
  if (typeof v !== "object" || v === null) return {};
  const out: TermMap = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (!key || typeof val !== "string") continue;
    out[key] = val;
    if (++n >= cap) break;
  }
  return out;
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
  const hands = obj("handsFree");
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const files = obj("files");
  const transcript = obj("transcript");
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
    handsFree: {
      autoAccept: bool(hands.autoAccept, d.handsFree.autoAccept),
      spokenApprovals: bool(hands.spokenApprovals, d.handsFree.spokenApprovals),
      followUp: bool(hands.followUp, d.handsFree.followUp),
      backchannel: bool(hands.backchannel, d.handsFree.backchannel),
    },
    transcript: {
      autoEdit: bool(transcript.autoEdit, d.transcript.autoEdit),
      dictionary: termMap(transcript.dictionary),
      snippets: termMap(transcript.snippets),
    },
    files: {
      enabled: typeof files.enabled === "boolean" ? files.enabled : d.files.enabled,
      root: str(files.root, d.files.root),
    },
    mcpServers: coerceMcpServers(raw.mcpServers),
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

// --- Post-run lessons (Phase 17.1) ---
// June's task-lessons file (`june-lessons.md`), next to june-memory.md and, like
// it, kept out of settings.json. `writeLessons("")` is the "clear" action.

export function readLessons(): Promise<string> {
  return invoke<string>("read_lessons");
}

export function writeLessons(content: string): Promise<void> {
  return invoke("write_lessons", { content });
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
