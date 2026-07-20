// Phase 12.1 - Silero VAD v5 in the webview, replacing the RMS energy gate for
// endpointing and barge-in (voice-capture.ts) and feeding the local wake word
// (wakeword.ts). Runs through onnxruntime-web on the assets staged locally by
// scripts/fetch-models.mjs, so it works with the network disabled - no CDN, no
// cloud. `@ricky0123/vad-web` owns the hard parts (resampling to 16kHz, the
// 512-sample framing, the Silero recurrent state), so we don't reinvent DSP; this
// module is just the June-shaped wrapper over its MicVAD.
//
// The mic stream is opened once by the caller and shared: MediaRecorder records
// the clip for Whisper while MicVAD reads the same stream for speech detection, so
// there is never a second getUserMedia contending for the device. MicVAD must
// therefore never stop that stream - pauseStream/resumeStream are no-ops and the
// caller owns teardown.

import { MicVAD, type RealTimeVADOptions } from "@ricky0123/vad-web";

const VAD_ASSET_PATH = "/models/vad/"; // silero_vad_v5.onnx + the audio worklet
const ORT_WASM_PATH = "/models/ort/"; // onnxruntime-web wasm

export interface SileroCallbacks {
  /** Speech onset confirmed (survived `minSpeechMs`) - the barge-in / wake-arm signal. */
  onSpeechStart?: () => void;
  /** End of utterance: `redemptionMs` of silence after speech. `audio` is the
   *  16kHz speech segment. This is the endpoint that ends a capture. */
  onSpeechEnd?: (audio: Float32Array) => void;
  /** Every processed 16kHz frame: `isSpeech` in 0..1 and the raw 512-sample frame
   *  (drives the live level meter and the wake-word feed). */
  onFrame?: (isSpeech: number, frame: Float32Array) => void;
}

/** Endpointing tuned for a spoken command: forgive short pauses mid-sentence,
 *  end shortly after the user stops. `redemptionMs` is the Silero analogue of the
 *  old RMS hangover, but driven by real speech probability rather than energy. */
export const ENDPOINT_VAD: Partial<RealTimeVADOptions> = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionMs: 700,
  minSpeechMs: 200,
  preSpeechPadMs: 200,
};

/** Barge-in tuned to trip fast on real speech while rejecting clicks/blips - the
 *  Silero replacement for the adaptive-RMS monitor. June's own audio is removed
 *  by the browser's echo cancellation before it reaches the model. */
export const BARGE_VAD: Partial<RealTimeVADOptions> = {
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.4,
  redemptionMs: 300,
  minSpeechMs: 200,
  preSpeechPadMs: 0,
};

export interface SileroHandle {
  stop: () => Promise<void>;
}

/** Start Silero on an already-open mic `stream`. Rejects if the model/wasm can't
 *  load (missing assets, unsupported webview) so callers can fall back to the RMS
 *  gate. The stream is left running on stop - the caller owns it. */
export async function startSilero(
  stream: MediaStream,
  cb: SileroCallbacks,
  cfg: Partial<RealTimeVADOptions> = ENDPOINT_VAD,
): Promise<SileroHandle> {
  const vad = await MicVAD.new({
    ...cfg,
    getStream: async () => stream,
    pauseStream: async () => {}, // never stop the caller's shared stream
    resumeStream: async (s) => s,
    startOnLoad: true,
    model: "v5",
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: ORT_WASM_PATH,
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1; // no cross-origin isolation in the webview
    },
    // Fire onset only once the segment survives `minSpeechMs` (SpeechRealStart),
    // so a click or a lip smack can't trip barge-in or arm the wake word.
    onSpeechRealStart: () => cb.onSpeechStart?.(),
    onSpeechEnd: (audio) => cb.onSpeechEnd?.(audio),
    onFrameProcessed: (probs, frame) => cb.onFrame?.(probs.isSpeech, frame),
  });
  if (vad.errored) throw new Error(`Silero VAD failed to load: ${vad.errored}`);

  return {
    stop: async () => {
      await vad.destroy();
    },
  };
}
