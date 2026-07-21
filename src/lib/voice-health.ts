import { invoke } from "@tauri-apps/api/core";

// Voice-stack health (2.7). Silero VAD and the local openWakeWord model both fall
// back silently when their ONNX assets can't load - broken assets permanently
// downgrade endpointing/barge/wake to the RMS/cloud path with NO signal to the
// user. Each fallback site reports which path went live plus the load error into
// the shared Rust session (widget webview writes; the app's Diagnostics panel
// reads it back - separate webviews, same pattern as latency samples).

/** Which implementation a voice subsystem is actually running. `silero`/`local`
 *  are the intended local-first paths; `rms`/`cloud-burst` are the degraded
 *  fallbacks; `unavailable` means the subsystem is off entirely. */
export type VoicePath = "silero" | "rms" | "local" | "cloud-burst" | "unavailable";

export interface VoiceSubsystem {
  path: VoicePath;
  /** The load error that forced a fallback, when the primary path was unavailable. */
  error?: string;
}

/** subsystem id (`barge` | `endpointing` | `wake`) -> its live path + load error. */
export type VoiceHealth = Record<string, VoiceSubsystem>;

/** Report one subsystem's live path (and any load error) - fire-and-forget, so a
 *  diagnostics write can never disturb the voice pipeline. A no-op with no backend
 *  (plain browser / tests). */
export function reportVoiceHealth(subsystem: string, status: VoiceSubsystem): void {
  void invoke("record_voice_health", { subsystem, status }).catch(() => {});
}

/** Read the current voice-stack health for the Diagnostics panel (2.7). */
export function voiceHealth(): Promise<VoiceHealth> {
  return invoke<VoiceHealth>("voice_health");
}
