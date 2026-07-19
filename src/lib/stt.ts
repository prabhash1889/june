import { invoke } from "@tauri-apps/api/core";

// Thin webview wrappers over the Rust STT + agent commands (PLAN.md Phase 4).
// The webview captures audio and holds no secrets; Rust adds the OpenAI key and
// makes the Whisper call, and runs the agent core, so keys never cross IPC.

/** Transcribe a captured clip. `audio` is the raw encoded bytes from
 *  MediaRecorder; `mime` is its container type. Returns the transcript (may be
 *  empty for silence). Rejects with a human-readable message on failure. */
export function transcribe(audio: Uint8Array, mime: string): Promise<string> {
  return invoke<string>("transcribe", { audio: Array.from(audio), mime });
}

/** Feed an accepted transcript to the agent core and return June's reply. Text
 *  deltas stream out as `agent://text` events tagged with `turn`, so a caller
 *  that barges in can drop deltas from the interrupted turn. */
export function runAgent(transcript: string, turn: number): Promise<string> {
  return invoke<string>("run_agent", { transcript, turn });
}

/** Whether an OpenAI key is present, so the UI can prompt for one up front. */
export function hasOpenAiKey(): Promise<boolean> {
  return invoke<boolean>("has_api_key", { service: "june_provider_openai_api_key" });
}

/** Store the OpenAI key in the OS keychain (never written to settings.json). */
export function setOpenAiKey(key: string): Promise<void> {
  return invoke("set_api_key", { service: "june_provider_openai_api_key", key });
}
