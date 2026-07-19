// Privacy modes (PLAN.md §5) - honest tiers, not one toggle. Enforcement is
// driven entirely by each provider's `offlineSafe` metadata (providers.ts), so
// adding a provider never means touching this logic:
//
//   standard      - any selected provider may be used.
//   local-voice   - mic/STT/TTS stay on-device; the brain may still use the
//                   network. NEVER described as fully offline.
//   strict-offline- only offline-safe providers at every stage; network brains
//                   and cloud voice are rejected.
//
// The same pure check gates both the UI (grey out / warn) and the run path
// (refuse a disallowed brain before a turn runs), so a mode can't be bypassed by
// editing settings.json - the check runs at execution time, not just in the form.

import { type Provider, type Stage } from "./providers.ts";

export type PrivacyMode = "standard" | "local-voice" | "strict-offline";

export const PRIVACY_MODES: { id: PrivacyMode; label: string; desc: string }[] = [
  { id: "standard", label: "Standard", desc: "Selected cloud and local providers may be used." },
  {
    id: "local-voice",
    label: "Local voice",
    desc: "Your voice, transcription, and speech stay on-device. The brain and coding agents may still use the network - this is not fully offline.",
  },
  {
    id: "strict-offline",
    label: "Strict offline",
    desc: "Only local, offline-safe providers are enabled. Cloud brains and cloud voice are blocked.",
  },
];

/** Stages that must be offline-safe under a mode. */
function offlineStages(mode: PrivacyMode): Stage[] {
  switch (mode) {
    case "strict-offline":
      return ["stt", "brain", "tts"];
    case "local-voice":
      return ["stt", "tts"];
    default:
      return [];
  }
}

/** Whether `provider` may serve `stage` under `mode`. The one rule the whole
 *  privacy model reduces to. */
export function providerAllowed(mode: PrivacyMode, stage: Stage, provider: Provider): boolean {
  return !offlineStages(mode).includes(stage) || provider.offlineSafe;
}

export function modeLabel(mode: PrivacyMode): string {
  return PRIVACY_MODES.find((m) => m.id === mode)?.label ?? mode;
}
