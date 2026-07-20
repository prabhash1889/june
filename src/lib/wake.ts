// Hands-free wake word (PLAN.md Phase 8): listen ambiently for the wake phrase
// and fire the same activation a push-to-talk press does, so the user never has
// to touch the keyboard.
//
// Phase 12.2: the primary path is now a fully-local openWakeWord ONNX model
// (wakeword.ts), gated by Silero (12.1) - no audio leaves the machine and wake
// works offline. The cloud-STT burst path below is kept as the fallback for when
// the local models can't load AND the privacy mode still permits cloud voice; it
// segments short speech bursts with an energy VAD and phrase-matches the
// transcript. `onWake` is the shared seam, so callers never change.
//
// Stand-in note: the bundled classifier is openWakeWord's "hey jarvis" (the
// only ready-made model); a trained "hey june" classifier drops into
// wakeword.ts's `createWakeRunners` with no code change. Until then the local
// wake phrase is "hey jarvis".

import type { StageChoice } from "./settings.ts";
import { transcribe } from "./stt.ts";
import { classifyGetUserMediaError, pickMimeType, rms, SilenceDetector } from "./voice-capture.ts";
// wakeword.ts (local openWakeWord) is imported dynamically in startWakeListener so
// tests can import phraseMatches/wakeBackoffUntil without pulling in ORT.
import type { WakeHandle as LocalWakeHandle } from "./wakeword.ts";

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

/** Backoff after repeated wake-burst transcription failures (10.8). The first
 *  two failures retry on the next onset; from the third, bursts pause for a
 *  growing spell (capped at 30s) so a dead network or a revoked key can't spam
 *  cloud STT on every noise onset. Returns the timestamp (same clock as `now`)
 *  at which bursts may resume - `now` itself when no wait is needed. Pure, so it
 *  is the runnable check for the backoff schedule. */
export function wakeBackoffUntil(failures: number, now: number): number {
  if (failures < 3) return now;
  return now + Math.min(30_000, 1000 * 2 ** (failures - 3));
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
 *  command, then restarts it when it returns to rest.
 *
 *  Primary path is local openWakeWord (offline, 12.2). If its models can't load,
 *  falls back to the cloud-STT burst path only when `allowCloudFallback` is set
 *  (i.e. the privacy mode permits cloud voice); otherwise wake is unavailable. */
export async function startWakeListener(opts: {
  phrase: string;
  sensitivity: number;
  onWake: () => void;
  allowCloudFallback?: boolean;
  /** The user's chosen STT stack (B4.6): the burst fallback transcribes with it, so
   *  a user on a local STT provider never has the wake fallback silently hit cloud
   *  Whisper. Omitted defaults to cloud Whisper (unchanged prior behaviour). */
  stt?: StageChoice;
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

  // Local openWakeWord first (offline). It borrows the stream via Silero.
  let local: LocalWakeHandle | null = null;
  try {
    const { startLocalWake } = await import("./wakeword.ts");
    local = await startLocalWake({ stream, sensitivity: opts.sensitivity, onWake: opts.onWake });
  } catch {
    local = null;
  }
  if (local) {
    return {
      stop: () => {
        local.stop();
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  // Local models unavailable. Only stream to the cloud if the mode allows it.
  if (!opts.allowCloudFallback) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("Local wake models are unavailable and cloud voice is blocked by the privacy mode.");
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
  let failures = 0; // consecutive burst-transcription failures, for backoff (10.8)
  let resumeAt = 0; // performance.now() before which onsets are ignored (backoff)

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
        .then((ab) => (ab.byteLength > 0 ? transcribe(new Uint8Array(ab), mime, opts.stt) : ""))
        .then((text) => {
          failures = 0; // a completed transcription (even empty) clears the backoff
          if (!stopped && phraseMatches(text, opts.phrase, opts.sensitivity)) opts.onWake();
        })
        .catch(() => {
          // A failed transcription (network down, revoked key) just means no wake
          // this burst - but back off so we stop hammering cloud STT (10.8).
          failures += 1;
          resumeAt = wakeBackoffUntil(failures, performance.now());
        })
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
      // Hold off new bursts while backing off from repeated STT failures (10.8).
      if (level >= ONSET_RMS && performance.now() >= resumeAt) beginBurst();
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
