// The provider registry (PLAN.md §3, Phase 7) - the single source of truth for
// what June can run at each pipeline stage. The settings UI renders from this,
// privacy enforcement reads the `offlineSafe` metadata from it, and the agent
// resolves a brain from it. Adding a provider is a config entry here, never new
// wiring - that is the whole point of the per-stage interface seam (§3).
//
// Honesty rule (matches every prior phase): a provider is only `available: true`
// if June can actually run it today. Since Phase 12.3/12.4 the local voice stack
// (Moonshine STT, Kokoro TTS) runs in the webview via transformers.js, so it is
// available and offline-safe. We never offer a stage that would error.

export type Stage = "stt" | "brain" | "tts";
export type ProviderKind = "local" | "api";

export interface ProviderModel {
  id: string;
  label: string;
}

export interface Provider {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Keychain service holding this provider's API key, if it needs one. */
  keyService?: string;
  /** Default OpenAI-compatible base URL for brain providers that route through
   *  the shared OpenAI-compat brain (OpenAI, Gemini, Ollama, LM Studio, custom). */
  baseUrl?: string;
  /** The base URL is user-editable (self-hosted / custom endpoints). */
  editableBaseUrl?: boolean;
  /** Runs entirely on-device - no audio or text leaves the machine. Drives the
   *  privacy modes (§5). An API provider is never offline-safe. */
  offlineSafe: boolean;
  /** June can actually run this provider now. Unavailable providers are shown
   *  (so the intended stack is visible) but cannot be selected. */
  available: boolean;
  /** Suggested models. The UI treats these as a datalist, not a hard list, so a
   *  newer model id the user types is never blocked by a stale catalog. */
  models: ProviderModel[];
}

const CLAUDE_KEY = "june_provider_anthropic_api_key";
const OPENAI_KEY = "june_provider_openai_api_key";
const GOOGLE_KEY = "june_provider_google_api_key";
const CUSTOM_KEY = "june_provider_custom_api_key";

export const PROVIDERS: Record<Stage, Provider[]> = {
  stt: [
    {
      id: "openai",
      label: "OpenAI Whisper",
      kind: "api",
      keyService: OPENAI_KEY,
      offlineSafe: false,
      available: true,
      models: [{ id: "whisper-1", label: "whisper-1" }],
    },
    {
      id: "moonshine",
      label: "Moonshine (local)",
      kind: "local",
      offlineSafe: true,
      available: true, // Phase 12.3 - runs in the webview via transformers.js
      models: [
        { id: "onnx-community/moonshine-base-ONNX", label: "Moonshine base" },
        { id: "onnx-community/moonshine-tiny-ONNX", label: "Moonshine tiny (faster)" },
        { id: "onnx-community/whisper-base", label: "Whisper base (alternate)" },
      ],
    },
  ],
  brain: [
    {
      id: "claude",
      label: "Claude (Anthropic)",
      kind: "api",
      keyService: CLAUDE_KEY, // optional: the SDK also uses local `claude` auth
      offlineSafe: false,
      available: true,
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8 (default)" },
        { id: "claude-fable-5", label: "Fable 5" },
        { id: "claude-sonnet-5", label: "Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ],
    },
    {
      id: "openai",
      label: "OpenAI GPT",
      kind: "api",
      keyService: OPENAI_KEY,
      baseUrl: "https://api.openai.com/v1",
      offlineSafe: false,
      available: true,
      models: [
        { id: "gpt-4o", label: "gpt-4o" },
        { id: "gpt-4o-mini", label: "gpt-4o-mini" },
        { id: "gpt-4.1", label: "gpt-4.1" },
      ],
    },
    {
      id: "gemini",
      label: "Google Gemini",
      kind: "api",
      keyService: GOOGLE_KEY,
      // Gemini's OpenAI-compatible endpoint - same brain code path as the rest.
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      offlineSafe: false,
      available: true,
      models: [
        { id: "gemini-2.0-flash", label: "gemini-2.0-flash" },
        { id: "gemini-1.5-pro", label: "gemini-1.5-pro" },
      ],
    },
    {
      id: "ollama",
      label: "Ollama (local)",
      kind: "local",
      baseUrl: "http://localhost:11434/v1",
      offlineSafe: true,
      available: true, // OpenAI-compatible; runs locally, no key
      models: [
        { id: "llama3.1", label: "llama3.1" },
        { id: "qwen2.5", label: "qwen2.5" },
      ],
    },
    {
      id: "lmstudio",
      label: "LM Studio (local)",
      kind: "local",
      baseUrl: "http://localhost:1234/v1",
      offlineSafe: true,
      available: true,
      models: [{ id: "local-model", label: "local-model" }],
    },
    {
      id: "custom",
      label: "Custom (OpenAI-compatible)",
      kind: "api",
      keyService: CUSTOM_KEY,
      baseUrl: "https://",
      editableBaseUrl: true,
      offlineSafe: false, // unknown endpoint - treat as networked
      available: true,
      models: [],
    },
  ],
  tts: [
    {
      id: "openai",
      label: "OpenAI TTS",
      kind: "api",
      keyService: OPENAI_KEY,
      offlineSafe: false,
      available: true,
      models: [
        { id: "tts-1", label: "tts-1 (fast)" },
        { id: "tts-1-hd", label: "tts-1-hd" },
      ],
    },
    {
      id: "kokoro",
      label: "Kokoro-82M (local)",
      kind: "local",
      offlineSafe: true,
      available: true, // Phase 12.4 - runs in the webview via kokoro-js
      models: [{ id: "onnx-community/Kokoro-82M-v1.0-ONNX", label: "Kokoro 82M" }],
    },
  ],
};

/** OpenAI TTS voices (§4 Voice). Only the TTS stage exposes a voice. */
export const TTS_VOICES: ProviderModel[] = [
  { id: "alloy", label: "Alloy" },
  { id: "echo", label: "Echo" },
  { id: "fable", label: "Fable" },
  { id: "onyx", label: "Onyx" },
  { id: "nova", label: "Nova" },
  { id: "shimmer", label: "Shimmer" },
];

/** A representative slice of Kokoro's voice table for the local TTS picker (12.4).
 *  Not exhaustive - the model ships dozens - and validated at synthesis time
 *  against the loaded model's real set (local-tts.ts), so an unlisted id the user
 *  types still works and a stale one falls back safely. */
export const KOKORO_VOICES: ProviderModel[] = [
  { id: "af_heart", label: "Heart (US, warm)" },
  { id: "af_bella", label: "Bella (US)" },
  { id: "af_nicole", label: "Nicole (US)" },
  { id: "am_michael", label: "Michael (US)" },
  { id: "am_adam", label: "Adam (US)" },
  { id: "bf_emma", label: "Emma (UK)" },
  { id: "bm_george", label: "George (UK)" },
];

/** The default voice for a TTS provider, used when the user switches providers so
 *  the voice never dangles as one the new engine doesn't have (§4). */
export function defaultVoiceFor(providerId: string): string {
  return providerId === "kokoro" ? "af_heart" : "alloy";
}

/** The voice options a TTS provider offers, for the settings picker. */
export function voicesFor(providerId: string): ProviderModel[] {
  return providerId === "kokoro" ? KOKORO_VOICES : TTS_VOICES;
}

export function providersFor(stage: Stage): Provider[] {
  return PROVIDERS[stage];
}

/** Resolve a provider by id for a stage, or undefined if unknown. */
export function resolveProvider(stage: Stage, id: string): Provider | undefined {
  return PROVIDERS[stage].find((p) => p.id === id);
}

/** Every distinct API-key-bearing provider, for the "API keys" settings section
 *  (deduplicated by keychain service - OpenAI is shared across STT/TTS/brain). */
export function keyedProviders(): { id: string; label: string; keyService: string }[] {
  const seen = new Set<string>();
  const out: { id: string; label: string; keyService: string }[] = [];
  for (const stage of ["brain", "stt", "tts"] as Stage[]) {
    for (const p of PROVIDERS[stage]) {
      if (p.keyService && !seen.has(p.keyService)) {
        seen.add(p.keyService);
        out.push({ id: p.id, label: p.label, keyService: p.keyService });
      }
    }
  }
  return out;
}
