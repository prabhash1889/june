// Phase 12.2 - local wake word ("Hey June") via openWakeWord, run in the webview
// through onnxruntime-web. This kills the cloud phrase-spotting the first cut used
// (wake.ts's burst -> Whisper): no audio leaves the machine and wake works with
// the network disabled.
//
// openWakeWord is a three-model chain over 16kHz audio:
//   melspectrogram.onnx : raw audio -> mel frames (32 bins each)
//   embedding_model.onnx: a 76-frame mel window -> a 96-dim speech embedding
//   <phrase>.onnx       : the last 16 embeddings -> a 0..1 wake score
// The melspectrogram + embedding models are shared; the classifier is the only
// per-phrase file, so a trained "hey june" model drops in beside the "hey jarvis"
// stand-in with no code change (createWakeRunners is the only seam that names it).
//
// The streaming buffer maths below is a faithful port of openWakeWord's
// `AudioFeatures._streaming_features` (v0.5.1) - audio is accumulated into 1280-
// sample (80ms) chunks, each chunk adds 8 mel frames, and every 8 new mel frames
// yields one embedding via a 76-frame window stepped by 8. Getting that stepping
// exactly right is what makes the score meaningful, so the accounting is kept
// identical to the reference and exercised by wakeword.test.ts with fake runners.

import { WakeGate, wakeThreshold } from "./wake-gate.ts";
// vad.ts (which pulls in onnxruntime-web's wasm build) is imported dynamically in
// startLocalWake only, so unit tests can import WakeModel/WakeGate without loading
// ORT in jsdom.

const SAMPLE_RATE = 16_000;
const CHUNK = 1280; // 80ms @ 16kHz - openWakeWord's accumulation unit
const MEL_CONTEXT = 160 * 3; // extra samples the melspec model needs for its window
const MEL_BINS = 32;
const EMB_WINDOW = 76; // mel frames per embedding
const EMB_STEP = 8; // mel frames advanced per embedding (= frames added per chunk)
const EMB_DIM = 96;
const CLASSIFIER_FRAMES = 16; // embeddings the classifier scores over
const MEL_BUFFER_MAX = 10 * 97; // ~10s of mel frames
const FEATURE_BUFFER_MAX = 120; // ~10s of embeddings
const RAW_BUFFER_MAX = SAMPLE_RATE * 10;
const INT16_MAX = 32767;

/** Runs the melspectrogram model: `samples` (int16-magnitude float32) -> a flat
 *  array of `frames * 32` mel values already in openWakeWord's `x/10 + 2` scale. */
export type MelRun = (samples: Float32Array) => Promise<Float32Array>;
/** Runs the embedding model: a 76*32 mel window -> a 96-dim embedding. */
export type EmbedRun = (window: Float32Array) => Promise<Float32Array>;
/** Runs the classifier: 16*96 embeddings -> a 0..1 wake score. */
export type ClassifyRun = (features: Float32Array) => Promise<number>;

export interface WakeRunners {
  mel: MelRun;
  embed: EmbedRun;
  classify: ClassifyRun;
  release?: () => Promise<void>;
}

/** The streaming feature + scoring pipeline, independent of onnxruntime so its
 *  buffer accounting is unit-testable with fake runners. Feed 16kHz mono frames
 *  (any length); `feed` returns the newest wake score once at least 16 embeddings
 *  have accumulated, else null (warming up). */
export class WakeModel {
  #raw: number[] = [];
  #remainder: number[] = [];
  #accumulated = 0;
  #mel: number[] = []; // flat, MEL_BINS per frame
  #feat: number[] = []; // flat, EMB_DIM per embedding

  constructor(private readonly runners: WakeRunners) {}

  /** Feed one frame of normalized (-1..1) 16kHz audio. Returns the latest score
   *  after any new embeddings, or null while there are fewer than 16 embeddings. */
  async feed(frame: Float32Array): Promise<number | null> {
    let x = frame;
    if (this.#remainder.length) {
      x = Float32Array.from([...this.#remainder, ...frame]);
      this.#remainder = [];
    }

    // Buffer only whole 80ms chunks; stash the tail for next time (the reference
    // keeps `raw_data_remainder` so chunk boundaries never drift).
    if (this.#accumulated + x.length >= CHUNK) {
      const remainder = (this.#accumulated + x.length) % CHUNK;
      const even = remainder ? x.subarray(0, x.length - remainder) : x;
      this.#bufferRaw(even);
      this.#accumulated += even.length;
      this.#remainder = remainder ? Array.from(x.subarray(x.length - remainder)) : [];
    } else {
      this.#bufferRaw(x);
      this.#accumulated += x.length;
    }

    if (this.#accumulated < CHUNK || this.#accumulated % CHUNK !== 0) return this.#score(false);

    // New melspectrogram over the just-accumulated audio (+ context), appended.
    const take = this.#accumulated + MEL_CONTEXT;
    const slice = this.#raw.slice(Math.max(0, this.#raw.length - take));
    const samples = Float32Array.from(slice, (v) => Math.max(-INT16_MAX - 1, Math.min(INT16_MAX, v * INT16_MAX)));
    const melFrames = await this.runners.mel(samples);
    for (let i = 0; i < melFrames.length; i++) this.#mel.push(melFrames[i]);
    this.#trim(this.#mel, MEL_BUFFER_MAX * MEL_BINS);

    // One embedding per 8 new mel frames, oldest-first, over a 76-frame window.
    const chunks = this.#accumulated / CHUNK;
    const melFrameCount = this.#mel.length / MEL_BINS;
    let added = false;
    for (let i = chunks - 1; i >= 0; i--) {
      const end = i === 0 ? melFrameCount : melFrameCount - EMB_STEP * i;
      const start = end - EMB_WINDOW;
      if (start < 0) continue;
      const window = Float32Array.from(this.#mel.slice(start * MEL_BINS, end * MEL_BINS));
      const emb = await this.runners.embed(window);
      for (let j = 0; j < emb.length; j++) this.#feat.push(emb[j]);
      added = true;
    }
    if (added) this.#trim(this.#feat, FEATURE_BUFFER_MAX * EMB_DIM);
    this.#accumulated = 0;

    return this.#score(added);
  }

  #bufferRaw(x: Float32Array): void {
    for (let i = 0; i < x.length; i++) this.#raw.push(x[i]);
    this.#trim(this.#raw, RAW_BUFFER_MAX);
  }

  #trim(buf: number[], max: number): void {
    if (buf.length > max) buf.splice(0, buf.length - max);
  }

  /** Score the last 16 embeddings, or null if there aren't 16 yet or nothing new. */
  async #score(hasNew: boolean): Promise<number | null> {
    if (!hasNew) return null;
    const frames = this.#feat.length / EMB_DIM;
    if (frames < CLASSIFIER_FRAMES) return null;
    const features = Float32Array.from(this.#feat.slice((frames - CLASSIFIER_FRAMES) * EMB_DIM));
    return this.runners.classify(features);
  }
}

export interface WakeHandle {
  stop: () => void;
}

/** Build the three onnxruntime-web sessions from the locally-staged models. The
 *  classifier path is the only per-phrase name here - swap in a trained
 *  "hey_june" model and nothing else changes. Loaded lazily (dynamic import) so
 *  the ORT wasm never enters the unit-test / non-voice code path. */
export async function createWakeRunners(
  classifierFile = "hey_jarvis_v0.1.onnx",
): Promise<WakeRunners> {
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = "/models/ort/";
  ort.env.wasm.numThreads = 1; // the webview has no cross-origin isolation (no SharedArrayBuffer)

  const base = "/models/wake/";
  const [mel, embed, clf] = await Promise.all([
    ort.InferenceSession.create(`${base}melspectrogram.onnx`),
    ort.InferenceSession.create(`${base}embedding_model.onnx`),
    ort.InferenceSession.create(`${base}${classifierFile}`),
  ]);

  const run = async (s: import("onnxruntime-web").InferenceSession, t: unknown): Promise<Float32Array> => {
    const out = await s.run({ [s.inputNames[0]]: t as never });
    return out[s.outputNames[0]].data as Float32Array;
  };

  return {
    mel: async (samples) => {
      const scaled = await run(mel, new ort.Tensor("float32", samples, [1, samples.length]));
      return scaled.map((v) => v / 10 + 2); // openWakeWord's melspec transform
    },
    embed: (window) => run(embed, new ort.Tensor("float32", window, [1, EMB_WINDOW, MEL_BINS, 1])),
    classify: async (features) => (await run(clf, new ort.Tensor("float32", features, [1, CLASSIFIER_FRAMES, EMB_DIM])))[0],
    release: async () => {
      await Promise.all([mel.release(), embed.release(), clf.release()]);
    },
  };
}

/** Start listening for the local wake phrase on `stream`. Silero (12.1) supplies
 *  the 16kHz frames and the speech gate; the openWakeWord chain scores them. Fires
 *  `onWake` once per detection. Rejects if the models or mic can't be brought up,
 *  so the caller can fall back (wake.ts keeps the cloud path for that). */
export async function startLocalWake(opts: {
  stream: MediaStream;
  sensitivity: number;
  onWake: () => void;
  runners?: WakeRunners; // injectable for tests
}): Promise<WakeHandle> {
  const runners = opts.runners ?? (await createWakeRunners());
  const model = new WakeModel(runners);
  const gate = new WakeGate(wakeThreshold(opts.sensitivity));
  let speechActive = false;
  let stopped = false;

  const { startSilero } = await import("./vad.ts");
  const silero = await startSilero(opts.stream, {
    onSpeechStart: () => (speechActive = true),
    onSpeechEnd: () => (speechActive = false),
    onFrame: (isSpeech, frame) => {
      if (stopped) return;
      void model.feed(frame).then((score) => {
        if (!stopped && score !== null && gate.push(score, speechActive || isSpeech > 0.5)) opts.onWake();
      });
    },
  });

  return {
    stop: () => {
      stopped = true;
      void silero.stop();
      void runners.release?.();
    },
  };
}
