import { invoke } from "@tauri-apps/api/core";

import { resolveProvider } from "./providers.ts";
import type { StageChoice } from "./settings.ts";

// Thin webview wrappers over the Rust STT + agent commands (PLAN.md Phase 4).
// The webview captures audio and holds no secrets; Rust adds the OpenAI key and
// makes the cloud Whisper call, and runs the agent core, so keys never cross IPC.
//
// Phase 12.3: when the selected STT provider is local, transcription runs entirely
// in the webview (local-stt.ts, Moonshine via transformers.js) instead of Rust -
// nothing leaves the machine. The dynamic import keeps transformers.js out of the
// cloud path. Callers that don't pass a `choice` (the wake cloud fallback) keep the
// cloud Whisper behaviour.

/** Transcribe a captured clip. `audio` is the raw encoded bytes from
 *  MediaRecorder; `mime` is its container type. `choice` is the caller's selected
 *  STT stack - a local provider routes to on-device inference, everything else to
 *  cloud Whisper in Rust. Returns the transcript (may be empty for silence).
 *  Rejects with a human-readable message on failure. */
export async function transcribe(audio: Uint8Array, mime: string, choice?: StageChoice): Promise<string> {
  if (choice && resolveProvider("stt", choice.provider)?.kind === "local") {
    const { transcribeLocal } = await import("./local-stt.ts");
    return transcribeLocal(audio, choice.model);
  }
  return invoke<string>("transcribe", { audio: Array.from(audio), mime });
}

/** Feed an accepted transcript to the agent core and return June's reply. Text
 *  deltas stream out as `agent://text` events tagged with `turn`, so a caller
 *  that barges in can drop deltas from the interrupted turn. */
export function runAgent(transcript: string, turn: number): Promise<string> {
  return invoke<string>("run_agent", { transcript, turn });
}

/** Dictation injection (Phase 15.4): type the cleaned transcript into the focused
 *  app. Called ONLY from the user-held PTT dictation path in the widget - never by
 *  the agent - so June is the keyboard, not an actor. Rejects with a readable
 *  message if the OS input path is unavailable. */
export function injectText(text: string): Promise<void> {
  return invoke("inject_text", { text });
}

/** Whether an OpenAI key is present, so the UI can prompt for one up front. */
export function hasOpenAiKey(): Promise<boolean> {
  return invoke<boolean>("has_api_key", { service: "june_provider_openai_api_key" });
}

/** Store the OpenAI key in the OS keychain (never written to settings.json). */
export function setOpenAiKey(key: string): Promise<void> {
  return invoke("set_api_key", { service: "june_provider_openai_api_key", key });
}
