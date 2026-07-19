// The provider registry (PLAN.md §3, Phase 7) - the single source of truth for
// what June can run at each pipeline stage. The settings UI renders from this,
// privacy enforcement reads the `offlineSafe` metadata from it, and the agent
// resolves a brain from it. Adding a provider is a config entry here, never new
// wiring - that is the whole point of the per-stage interface seam (§3).
//
// Honesty rule (matches every prior phase): a provider is only `available: true`
// if June can actually run it today. Local voice (faster-whisper, Kokoro) is the
// design target but not yet wired, so it is listed - so the intended stack is
// visible - but not selectable. We never offer a stage that would error.

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
      id: "faster-whisper",
      label: "faster-whisper (local)",
      kind: "local",
      offlineSafe: true,
      available: false, // Phase 7 tail - local STT not yet wired
      models: [
        { id: "base", label: "base" },
        { id: "small", label: "small" },
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
      available: false, // Phase 7 tail - local TTS not yet wired
      models: [{ id: "kokoro", label: "kokoro" }],
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
