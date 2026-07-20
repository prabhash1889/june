// Progress reporting for on-device model downloads (improvement-5 P0.5). A first
// run of local STT (Moonshine, ~190MB) or local TTS (Kokoro, ~86MB) downloads
// weights from Hugging Face inside the transcribe/speak call; transformers.js and
// kokoro-js fire per-file progress callbacks while fetching. local-stt/local-tts
// forward those here, and the widget listens so the user sees "Downloading…"
// instead of a silent hang (the deferred 12.x progress UI).
//
// A window event (not React state) because the loaders are plain modules loaded
// lazily, and the one listener lives in VoicePanel.

export const MODEL_PROGRESS_EVENT = "june://model-progress";

/** What the listener receives: the download under way, or null once loading
 *  settled (ready or failed). */
export type ModelProgress = { label: string; pct: number | null } | null;

/** The subset of a transformers.js progress event this module reads. */
export interface XformersProgress {
  status?: string;
  file?: string;
  progress?: number;
}

function dispatch(detail: ModelProgress): void {
  window.dispatchEvent(new CustomEvent<ModelProgress>(MODEL_PROGRESS_EVENT, { detail }));
}

/** Forward one transformers.js progress event to the UI. `label` names the model
 *  in user terms ("speech-to-text model"). Only .onnx files drive the percentage -
 *  the sidecar files (tokenizer, config) are tiny and would bounce it around. */
export function reportModelProgress(label: string, info: XformersProgress): void {
  if (info.status === "ready") {
    dispatch(null);
    return;
  }
  if (!info.file?.endsWith(".onnx")) return;
  if (info.status === "progress") dispatch({ label, pct: Math.round(info.progress ?? 0) });
  else if (info.status === "initiate" || info.status === "download") dispatch({ label, pct: null });
}

/** Clear the download line (a load that failed never fires "ready"). */
export function clearModelProgress(): void {
  dispatch(null);
}
