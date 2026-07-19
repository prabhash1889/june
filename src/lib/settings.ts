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

export interface JuneSettings {
  stt: StageChoice;
  brain: StageChoice & { effort: Effort };
  tts: StageChoice & { voice: string };
  /** Base URL for the brain when its provider allows a custom endpoint. */
  brainBaseUrl: string;
  privacyMode: PrivacyMode;
}

export const DEFAULT_SETTINGS: JuneSettings = {
  stt: { provider: "openai", model: "whisper-1" },
  brain: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
  tts: { provider: "openai", model: "tts-1", voice: "alloy" },
  brainBaseUrl: "",
  privacyMode: "standard",
};

/** Raw bag persisted by Rust. Kept alongside the typed view so a save can merge
 *  over it and never drop unknown keys. */
type RawSettings = Record<string, unknown>;

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
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
  return {
    stt: stage("stt", d.stt),
    brain: {
      ...stage("brain", d.brain),
      effort: efforts.includes(brainEffort as Effort) ? (brainEffort as Effort) : d.brain.effort,
    },
    tts: { ...stage("tts", d.tts), voice: str(obj("tts").voice, d.tts.voice) },
    brainBaseUrl: str(raw.brainBaseUrl, d.brainBaseUrl),
    privacyMode: modes.includes(mode as PrivacyMode) ? (mode as PrivacyMode) : d.privacyMode,
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

export { PROVIDERS };
