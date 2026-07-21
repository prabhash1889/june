// Progress reporting for on-device model downloads (improvement-5 P0.5,
// aggregated in improvement-7 1.5). A first run of local STT (Moonshine, ~190MB)
// or local TTS (Kokoro, ~86MB) downloads weights from Hugging Face inside the
// transcribe/speak call; transformers.js and kokoro-js fire per-file progress
// callbacks while fetching. local-stt/local-tts forward those here.
//
// 1.5: instead of a bare per-model percentage, the per-file `loaded`/`total`
// bytes are summed into ONE aggregate row ("Setting up on-device voice
// (34/120 MB)") across every model currently downloading. Dispatched as a window
// event for same-webview listeners (the widget's VoicePanel, the settings stage
// cards) AND broadcast over Tauri so the other face - notably the onboarding
// card in the app window - shows the same row.

export const MODEL_PROGRESS_EVENT = "june://model-progress";

/** What listeners receive: the aggregate download under way, or null once every
 *  loader settled (ready or failed). */
export type ModelProgress = {
  label: string;
  pct: number | null;
  /** Aggregate bytes across every model file currently downloading (1.5).
   *  Zero until the first byte counts arrive. */
  loadedBytes: number;
  totalBytes: number;
} | null;

/** The subset of a transformers.js progress event this module reads. */
export interface XformersProgress {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

/** "34/120 MB" for a progress row, or "" until byte counts are known. */
export function formatModelProgress(p: NonNullable<ModelProgress>): string {
  if (p.totalBytes <= 0) return "";
  const mb = (n: number) => Math.max(1, Math.round(n / 1048576));
  return `${Math.min(mb(p.loadedBytes), mb(p.totalBytes))}/${mb(p.totalBytes)} MB`;
}

// One aggregate session: per-file byte counts (keyed `label:file`) and the set
// of labels ("speech-to-text model" / "voice model") still loading.
const files = new Map<string, { loaded: number; total: number }>();
const active = new Set<string>();

function dispatch(detail: ModelProgress): void {
  window.dispatchEvent(new CustomEvent<ModelProgress>(MODEL_PROGRESS_EVENT, { detail }));
  // Cross-webview (1.5): the download runs in whichever face first needed the
  // model, but onboarding lives in the app window - broadcast so both see one
  // row. Best-effort; outside Tauri (unit tests) this simply rejects.
  import("@tauri-apps/api/event")
    .then((ev) => ev.emit(MODEL_PROGRESS_EVENT, detail))
    .catch(() => {});
}

function aggregate(label: string): NonNullable<ModelProgress> {
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  return {
    // Two models at once -> the generic name; one -> its own.
    label: active.size > 1 ? "on-device voice models" : label,
    pct: total > 0 ? Math.round((100 * loaded) / total) : null,
    loadedBytes: loaded,
    totalBytes: total,
  };
}

/** One loader (`label`) finished - ready or failed. Clears its share of the
 *  aggregate; the row disappears once every loader settled. */
function settle(label: string): void {
  active.delete(label);
  for (const key of [...files.keys()]) {
    if (key.startsWith(`${label}:`)) files.delete(key);
  }
  if (active.size === 0) {
    files.clear();
    dispatch(null);
  } else {
    dispatch(aggregate([...active][0]));
  }
}

/** Forward one transformers.js progress event to the UI. `label` names the model
 *  in user terms ("speech-to-text model"). Only .onnx files drive the numbers -
 *  the sidecar files (tokenizer, config) are tiny and would bounce them around. */
export function reportModelProgress(label: string, info: XformersProgress): void {
  if (info.status === "ready") {
    settle(label);
    return;
  }
  if (!info.file?.endsWith(".onnx")) return;
  if (info.status === "progress" || info.status === "initiate" || info.status === "download") {
    active.add(label);
    if (info.status === "progress") {
      files.set(`${label}:${info.file}`, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
    }
    dispatch(aggregate(label));
  }
}

/** Clear one loader's share of the download row (a load that failed never fires
 *  "ready"), or - with no label - the whole row. */
export function clearModelProgress(label?: string): void {
  if (label !== undefined) {
    settle(label);
    return;
  }
  active.clear();
  files.clear();
  dispatch(null);
}
