// Single owned microphone stream (3.3). Every phase transition used to reopen
// getUserMedia (100-400ms on Windows) - command capture, barge-in, follow-up and
// the wake listener each opened their own device. They now share one stream that
// stays live across the whole active session and closes shortly after the last
// consumer releases, so a wake -> capture handoff never re-opens the mic (the
// linger bridges the moment where wake releases just as capture acquires).
//
// Ref-counted, not always-on: the stream opens on the first consumer and closes
// on the last release (+ linger), so a push-to-talk-only user never has a hot mic
// while June is idle. Every June consumer requests the user's single chosen mic,
// so the manager serves one device at a time.
//
// The pre-roll ring buffer keeps the most recent ~1s of 16kHz speech frames, for
// un-clipping the first words of a wake-started capture.
// ponytail: the ring buffer is populated but not yet PREPENDED to a capture clip -
// that needs replacing MediaRecorder(webm) with PCM+WAV capture, tuned on a real
// Windows mic (first-word clipping is not measurable in CI). Wire the prepend in
// during a device session; the buffer and its retention are ready and tested here.

/** A borrow of the shared mic stream. Never stop the stream's tracks directly -
 *  call {@link release}; the manager owns the device lifecycle. */
export interface MicLease {
  /** The shared, live MediaStream. Attach MediaRecorder / MicVAD to it. */
  stream: MediaStream;
  /** Release this borrow. The stream closes once every lease is released (after a
   *  short linger so a phase handoff reuses it rather than reopening). Idempotent. */
  release: () => void;
}

/** Rolling buffer of the most recent ~1s of 16kHz mono PCM (16000 samples), for
 *  wake/follow-up pre-roll. A plain wrap-around ring: `push` appends frames and
 *  drops the oldest samples past capacity, `read` returns them oldest-first. Pure
 *  and self-contained, so the wrap-around retention is the unit-tested check. */
export class PreRollRing {
  #buf: Float32Array;
  #write = 0; // next write index (wraps)
  #filled = 0; // valid samples held (<= capacity)

  constructor(private readonly capacity = 16_000) {
    this.#buf = new Float32Array(capacity);
  }

  push(frame: Float32Array): void {
    // A frame longer than the whole ring: keep only its last `capacity` samples.
    const src = frame.length > this.capacity ? frame.subarray(frame.length - this.capacity) : frame;
    for (let i = 0; i < src.length; i++) {
      this.#buf[this.#write] = src[i];
      this.#write = (this.#write + 1) % this.capacity;
    }
    this.#filled = Math.min(this.capacity, this.#filled + src.length);
  }

  /** The retained samples in chronological (oldest-first) order. */
  read(): Float32Array {
    const out = new Float32Array(this.#filled);
    // Oldest sample sits `#filled` slots behind the write head (mod capacity).
    const start = (this.#write - this.#filled + this.capacity) % this.capacity;
    for (let i = 0; i < this.#filled; i++) out[i] = this.#buf[(start + i) % this.capacity];
    return out;
  }

  clear(): void {
    this.#write = 0;
    this.#filled = 0;
  }
}

/** Opens a MediaStream for a chosen device. Injected so the ref-count state
 *  machine is unit-testable without a real getUserMedia (absent under jsdom). */
export type MicOpener = (deviceId?: string) => Promise<MediaStream>;

/** Ref-counted owner of one shared mic stream + its pre-roll ring. */
export class MicManager {
  #stream: MediaStream | null = null;
  #deviceId: string | undefined;
  #refs = 0;
  #opening: Promise<MediaStream> | null = null;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly ring: PreRollRing;

  constructor(
    private readonly opener: MicOpener,
    private readonly lingerMs = 800,
  ) {
    this.ring = new PreRollRing();
  }

  /** Whether we hold a stream whose audio track is still live (a device unplug or
   *  an OS revoke ends the track without telling us). */
  #live(): boolean {
    const track = this.#stream?.getAudioTracks()[0];
    return !!this.#stream && track?.readyState === "live";
  }

  /** Borrow the shared stream, opening it if needed. While anyone else holds it
   *  the current device is served regardless of `deviceId` (a mismatch means a
   *  stale settings read, not two devices); an idle-but-lingering stream on a
   *  different device is swapped out. */
  async acquire(deviceId?: string): Promise<MicLease> {
    this.#cancelClose();
    if (this.#live() && this.#refs === 0 && deviceId !== undefined && deviceId !== this.#deviceId) {
      this.#hardClose(); // idle stream on the wrong device: reopen on the new one
    }
    const dev = this.#refs > 0 ? this.#deviceId : deviceId; // an in-use device wins
    await this.#ensureStream(dev);
    this.#refs += 1;
    return this.#lease();
  }

  async #ensureStream(deviceId?: string): Promise<MediaStream> {
    if (this.#live()) return this.#stream as MediaStream;
    if (!this.#opening) {
      this.#deviceId = deviceId;
      this.#opening = (async () => {
        try {
          const s = await this.opener(deviceId);
          this.#stream = s;
          return s;
        } finally {
          this.#opening = null;
        }
      })();
    }
    return this.#opening;
  }

  #lease(): MicLease {
    let released = false;
    return {
      stream: this.#stream as MediaStream,
      release: () => {
        if (released) return;
        released = true;
        this.#refs = Math.max(0, this.#refs - 1);
        if (this.#refs === 0) this.#scheduleClose();
      },
    };
  }

  #scheduleClose(): void {
    this.#cancelClose();
    this.#closeTimer = setTimeout(() => {
      this.#closeTimer = null;
      if (this.#refs === 0) this.#hardClose();
    }, this.lingerMs);
  }

  #cancelClose(): void {
    if (this.#closeTimer !== null) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
  }

  #hardClose(): void {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#refs = 0;
    this.ring.clear();
  }

  /** Test/inspection: how many live leases the manager currently serves. */
  get refCount(): number {
    return this.#refs;
  }
}

/** The default opener: the user's chosen mic with echo cancellation, noise
 *  suppression and auto gain - the union of what every consumer asked for (these
 *  are the getUserMedia defaults too, so one shared stream matches prior
 *  behaviour). `ideal`, not `exact`, so an unplugged chosen mic falls back to the
 *  system default instead of erroring. */
const defaultOpener: MicOpener = (deviceId) =>
  navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    },
  });

/** The process-wide shared mic. */
export const mic = new MicManager(defaultOpener);

/** Borrow the shared stream (see {@link MicManager.acquire}). */
export function acquireMic(deviceId?: string): Promise<MicLease> {
  return mic.acquire(deviceId);
}

/** Feed one 16kHz speech frame into the pre-roll ring (from a Silero `onFrame`). */
export function pushMicFrame(frame: Float32Array): void {
  mic.ring.push(frame);
}
