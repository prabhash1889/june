// Mic capture + end-of-utterance detection for June's push-to-talk (PLAN.md
// Phase 4). getUserMedia + MediaRecorder do the platform-native capture (device
// pick, permission prompt, resampling) so we don't reinvent any of it in Rust.

/** End-of-utterance detector: energy-threshold VAD with a silence hangover.
 *
 *  ponytail: a simple RMS-energy gate, not Silero. For push-to-talk it only has
 *  to decide "the user stopped talking" as a convenience auto-stop (the hotkey
 *  release is the real end signal). Swap in Silero VAD here if barge-in or
 *  open-mic (Phase 8) needs robust speech/noise discrimination. */
export class SilenceDetector {
  #speechSeen = false;
  #silenceMs = 0;

  /** @param threshold RMS (0..1) above which a frame counts as speech.
   *  @param hangoverMs trailing silence, after speech, that ends the utterance. */
  constructor(
    private readonly threshold = 0.015,
    private readonly hangoverMs = 1200,
  ) {}

  /** Feed one frame. Returns true once end-of-utterance is reached. Silence
   *  before any speech never ends the utterance (avoids cutting off a slow
   *  starter); only trailing silence after speech does. */
  push(rms: number, dtMs: number): boolean {
    if (rms >= this.threshold) {
      this.#speechSeen = true;
      this.#silenceMs = 0;
      return false;
    }
    if (!this.#speechSeen) return false;
    this.#silenceMs += dtMs;
    return this.#silenceMs >= this.hangoverMs;
  }

  /** True once any speech-level frame has been seen (UI: distinguish "waiting"
   *  from "heard you"). */
  get heardSpeech(): boolean {
    return this.#speechSeen;
  }
}

/** RMS (0..1) of a float time-domain frame from an AnalyserNode. */
export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** A distinct failure the UI must handle (PLAN.md Phase 4: permission denial,
 *  missing device, timeout, cancellation, empty transcript). */
export type CaptureError =
  | { kind: "permission-denied"; message: string }
  | { kind: "no-device"; message: string }
  | { kind: "capture-failed"; message: string };

/** Map a getUserMedia rejection to one of our handled capture errors. */
export function classifyGetUserMediaError(err: unknown): CaptureError {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return { kind: "permission-denied", message: "Microphone access was denied. Allow it to talk to June." };
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return { kind: "no-device", message: "No microphone was found. Plug one in and try again." };
  return { kind: "capture-failed", message: err instanceof Error ? err.message : "Could not start the microphone." };
}

/** Pick a MediaRecorder mime type the current WebView actually supports. */
export function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  const supported =
    typeof MediaRecorder !== "undefined"
      ? candidates.find((c) => MediaRecorder.isTypeSupported(c))
      : undefined;
  return supported ?? "audio/webm";
}

export interface CaptureHandle {
  /** Live 0..1 input level for a meter. */
  level: () => number;
  /** Stop capture and resolve with the recorded clip (empty if nothing came). */
  stop: () => Promise<{ audio: Uint8Array; mime: string }>;
  /** Abort without producing a clip (cancellation). */
  cancel: () => void;
}

export interface CaptureOptions {
  /** Called once end-of-utterance silence is detected, so the caller can stop. */
  onEndpoint?: () => void;
  /** Hard cap on capture length; fires onEndpoint if speech never ends. */
  maxMs?: number;
}

/** Start capturing the mic. Rejects with a {@link CaptureError} if the mic can't
 *  be opened. The returned handle stops/cancels and reads the live level. */
export async function startCapture(opts: CaptureOptions = {}): Promise<CaptureHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw classifyGetUserMediaError(err);
  }

  const mime = pickMimeType();
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();

  // Energy metering / VAD via Web Audio, independent of the recorder encoding.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const detector = new SilenceDetector();
  let lastLevel = 0;
  const FRAME_MS = 100;
  const started = performance.now();
  let ended = false;
  const tick = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const level = rms(buf);
    lastLevel = level;
    const overTime = opts.maxMs !== undefined && performance.now() - started >= opts.maxMs;
    if (!ended && (detector.push(level, FRAME_MS) || overTime)) {
      ended = true;
      opts.onEndpoint?.();
    }
  }, FRAME_MS);

  function teardown(): void {
    window.clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    void audioCtx.close();
  }

  return {
    level: () => lastLevel,
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      teardown();
    },
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          teardown();
          const blob = new Blob(chunks, { type: mime });
          blob.arrayBuffer().then((ab) => resolve({ audio: new Uint8Array(ab), mime }));
        };
        if (recorder.state !== "inactive") recorder.stop();
        else resolve({ audio: new Uint8Array(), mime });
      }),
  };
}
