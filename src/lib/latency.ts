import { invoke } from "@tauri-apps/api/core";

// Voice-turn latency instrumentation (PLAN.md Phase 11.5). The widget owns the
// pipeline; the full app shows diagnostics - two separate webviews - so each
// finished turn's stage breakdown is stored in the Rust session (shared, capped)
// and the Diagnostics panel reads it back and reports P50/P95. Target line:
// 800ms median voice-to-voice once the local voice stack (Phase 12) lands.

/** One voice turn's stage breakdown, in milliseconds. `total` is the
 *  voice-to-voice time - the sum of the three machine stages, so the human
 *  review pause (transcript shown -> user hits Send) is excluded. */
export interface LatencySample {
  stt: number; // capture-end -> transcript ready
  brain: number; // command sent -> first reply token
  tts: number; // first token -> first audio out
  total: number; // stt + brain + tts (voice-to-voice)
}

/** Accumulates one turn's milestone marks and, when June's first audio plays,
 *  produces the stage breakdown. Milestones land in different callbacks
 *  (transcribe, accept, the text-delta listener, the speech queue), so the
 *  marks are recorded onto one instance held for the turn. All marks are
 *  idempotent-safe: `firstToken`/`firstAudio` keep only the earliest. */
export class TurnTimer {
  // -1 means "not yet marked" - a real timestamp can legitimately be 0.
  #captureEnd = -1;
  #transcript = -1;
  #send = -1;
  #firstToken = -1;
  #firstAudio = -1;

  /** Capture stopped: the user finished speaking. Start of the STT stage. */
  captureEnded(): void {
    this.#captureEnd = performance.now();
  }

  /** Transcript is ready (review card shown). End of STT. */
  gotTranscript(): void {
    this.#transcript = performance.now();
  }

  /** The accepted transcript was dispatched to the agent. Start of the brain
   *  stage - set here, not at `gotTranscript`, so the review pause is excluded. */
  sent(): void {
    this.#send = performance.now();
  }

  /** First reply token arrived (or the reply resolved with no deltas). */
  firstToken(): void {
    if (this.#firstToken < 0) this.#firstToken = performance.now();
  }

  /** First audio started playing: end of the turn's voice-to-voice path.
   *  Returns the completed sample once (null on a repeat call or if the turn
   *  never reached a transcript/send, e.g. a silent or abandoned turn). */
  firstAudio(): LatencySample | null {
    if (this.#firstAudio >= 0 || this.#captureEnd < 0 || this.#transcript < 0 || this.#send < 0) return null;
    this.#firstAudio = performance.now();
    const ft = this.#firstToken < 0 ? this.#firstAudio : this.#firstToken;
    const stt = Math.max(0, Math.round(this.#transcript - this.#captureEnd));
    const brain = Math.max(0, Math.round(ft - this.#send));
    const tts = Math.max(0, Math.round(this.#firstAudio - ft));
    return { stt, brain, tts, total: stt + brain + tts };
  }
}

/** Nearest-rank percentile of an unsorted list (0 for an empty list). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Store a finished turn's latency in the shared Rust session (fire-and-forget;
 *  diagnostics must never disturb the voice pipeline). */
export function recordLatency(sample: LatencySample): Promise<void> {
  return invoke("record_latency", { sample });
}

/** Read the recent latency samples (newest last) for the Diagnostics panel. */
export function latencySamples(): Promise<LatencySample[]> {
  return invoke<LatencySample[]>("latency_samples");
}

/** Cumulative token/cost this app session (2.6). `costUsd` is 0 for brains that
 *  don't price the call (OpenAI-compatible / local); Claude reports real dollars. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

/** Read the session's cumulative token/cost for the Diagnostics readout (2.6). */
export function usageTotal(): Promise<UsageTotals> {
  return invoke<UsageTotals>("usage_total");
}
