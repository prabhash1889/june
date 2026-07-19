// Hands-free wake word (PLAN.md Phase 8): listen ambiently for "Hey June" and
// fire the same activation a push-to-talk press does, so the user never has to
// touch the keyboard.
//
// ponytail: this is the committed first cut. It reuses the already-wired cloud
// STT: an on-device energy VAD segments short speech bursts and only those get
// transcribed and phrase-matched, so June isn't streaming the room to the cloud
// continuously - but it IS a cloud activity (honest cost/privacy note surfaced in
// settings), and it is disabled under any privacy mode that blocks cloud voice
// (there is no local voice provider yet). A fully-local openWakeWord ONNX
// "Hey June" model swaps in behind the same `onWake` callback once a trained
// model exists - the callback is the seam, so the caller never changes.

import { transcribe } from "./stt.ts";
import { classifyGetUserMediaError, pickMimeType, rms, SilenceDetector } from "./voice-capture.ts";

/** Lowercase, drop punctuation, collapse whitespace - so "Hey, June!" and
 *  "hey june" compare equal. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein edit distance between two strings (small strings only). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Does `transcript` contain the wake `phrase`, tolerant of STT slop?
 *
 *  A clean `includes` catches the common case ("Hey, June." -> matches). For
 *  mishears ("hey joon", "a june") we slide a same-word-count window across the
 *  transcript and accept the closest one within an edit budget. `sensitivity`
 *  (0..1) sets that budget: 1.0 requires the phrase verbatim; lower values
 *  tolerate more slop (higher recall, more false triggers). Pure - this is the
 *  runnable check for the wake logic. */
export function phraseMatches(transcript: string, phrase: string, sensitivity = 0.5): boolean {
  const t = normalize(transcript);
  const p = normalize(phrase);
  if (!p) return false;
  if (t.includes(p)) return true;
  if (!t) return false;

  // Edit budget scaled by both phrase length and sensitivity. "hey june" (8 chars)
  // allows ~2 edits at sensitivity 0.5, 0 at 1.0.
  const budget = Math.round((1 - sensitivity) * p.length * 0.34);
  if (budget <= 0) return false;

  const words = p.split(" ").length;
  const toks = t.split(" ");
  for (let i = 0; i + words <= toks.length; i++) {
    const window = toks.slice(i, i + words).join(" ");
    if (editDistance(window, p) <= budget) return true;
  }
  return false;
}

export interface WakeHandle {
  /** Stop listening and release the microphone. */
  stop: () => void;
}

const ONSET_RMS = 0.02; // energy that starts recording a candidate wake burst
const MAX_BURST_MS = 2500; // a wake phrase is short - cap the clip (and the STT cost)
const FRAME_MS = 100;
const STOP_FAILSAFE_MS = 2000; // WebView2 can drop MediaRecorder.onstop; don't wedge

/** Start listening for the wake phrase. Rejects with a {@link
 *  import("./voice-capture.ts").CaptureError} if the mic can't be opened - a
 *  denied/absent mic just means hands-free is unavailable, PTT still works, so
 *  callers fail soft. Fires `onWake` each time the phrase is heard; the caller
 *  typically tears the listener down (via `stop`) as it begins capturing the
 *  command, then restarts it when it returns to rest. */
export async function startWakeListener(opts: {
  phrase: string;
  sensitivity: number;
  onWake: () => void;
}): Promise<WakeHandle> {
  let stream: MediaStream;
  try {
    // Echo-cancelled + noise-suppressed so June's own speech and steady room
    // noise don't trip the onset gate (mirrors the barge-in monitor).
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw classifyGetUserMediaError(err);
  }

  const mime = pickMimeType();
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let stopped = false;
  let busy = false; // recording or transcribing a burst - ignore new onsets meanwhile
  let recorder: MediaRecorder | null = null;
  let detector: SilenceDetector | null = null;
  let burstMs = 0;

  const beginBurst = (): void => {
    busy = true;
    burstMs = 0;
    detector = new SilenceDetector();
    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    recorder = rec;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(failSafe);
      recorder = null;
      detector = null;
      const audioBlob = new Blob(chunks, { type: mime });
      void audioBlob
        .arrayBuffer()
        .then((ab) => (ab.byteLength > 0 ? transcribe(new Uint8Array(ab), mime) : ""))
        .then((text) => {
          if (!stopped && phraseMatches(text, opts.phrase, opts.sensitivity)) opts.onWake();
        })
        .catch(() => {}) // a failed transcription just means no wake this burst
        .finally(() => {
          busy = false;
        });
    };
    const failSafe = window.setTimeout(finish, STOP_FAILSAFE_MS);
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = finish;
    rec.start();
  };

  const endBurst = (): void => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else recorder = null;
  };

  const tick = window.setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);
    const level = rms(buf);
    if (!busy) {
      if (level >= ONSET_RMS) beginBurst();
      return;
    }
    // A burst is recording: advance the VAD and cap the length.
    burstMs += FRAME_MS;
    const ended = (detector?.push(level, FRAME_MS) ?? false) || burstMs >= MAX_BURST_MS;
    if (ended) endBurst();
  }, FRAME_MS);

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(tick);
      if (recorder && recorder.state !== "inactive") recorder.stop();
      recorder = null;
      stream.getTracks().forEach((t) => t.stop());
      void audioCtx.close();
    },
  };
}
