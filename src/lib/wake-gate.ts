// Phase 12.2 - the firing decision for the local wake word, kept pure and apart
// from the ONNX inference so it is the runnable check for the wake logic.
//
// openWakeWord emits one score in 0..1 per ~80ms of audio. A bare `score >=
// threshold` would re-fire every frame for as long as the phrase's tail keeps the
// score high, so June would wake several times per "Hey June". This gate fires
// once per crossing: after a fire it disarms and only re-arms once the score
// falls back under a release level (hysteresis). Firing is also gated on Silero
// reporting speech, so a score blip during silence can never wake June (the "gated
// by Silero" rule from the doc).

/** Maps the user's 0..1 wake sensitivity to an openWakeWord score threshold.
 *  Higher sensitivity = stricter = a higher score required (fewer false
 *  triggers, lower recall) - matching the WakeConfig contract. 0.5 (the default)
 *  lands on openWakeWord's own 0.5 recommendation. Pure. */
export function wakeThreshold(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, sensitivity));
  return 0.3 + s * 0.4; // 0.30 (loose) .. 0.70 (strict), 0.50 at the default
}

export class WakeGate {
  #armed = true;
  private readonly release: number;

  /** @param threshold score at/above which the phrase is accepted.
   *  @param release score the model must fall back under before the gate re-arms
   *         (hysteresis); defaults to 60% of the threshold. */
  constructor(
    private readonly threshold: number,
    release?: number,
  ) {
    this.release = release ?? threshold * 0.6;
  }

  /** Feed one openWakeWord score. `speechActive` is Silero's current verdict.
   *  Returns true exactly once per detection, on the frame the score first
   *  crosses the threshold while armed and speech is present. */
  push(score: number, speechActive: boolean): boolean {
    if (score < this.release) this.#armed = true;
    if (!this.#armed || !speechActive) return false;
    if (score >= this.threshold) {
      this.#armed = false;
      return true;
    }
    return false;
  }
}
