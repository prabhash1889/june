import { invoke } from "@tauri-apps/api/core";

import { resolveProvider } from "./providers.ts";

// Text-to-speech surface for the webview (PLAN.md Phase 5). Rust holds the
// OpenAI key and returns encoded audio; this module splits June's reply into
// sentences, synthesizes them, and plays them in order so June starts speaking
// before the whole answer is generated. `SpeechQueue.stop()` is the barge-in.
//
// Phase 12.4: when the selected TTS provider is local, synthesis runs in the
// webview (local-tts.ts, Kokoro via kokoro-js) instead of Rust - the reply text
// never leaves the machine. Local Kokoro returns WAV, cloud OpenAI returns mp3, so
// synthesize reports the mime alongside the bytes and playback uses it.

/** The TTS stack a caller wants: provider + model + voice (settings.tts). */
export interface TtsChoice {
  provider: string;
  model?: string;
  voice?: string;
}

/** Encoded speech audio plus its container type, so the player tags the blob
 *  correctly (mp3 from cloud OpenAI, wav from local Kokoro). */
export interface SpeechAudio {
  bytes: Uint8Array;
  mime: string;
}

// Output volume (improvement-5 P2 6.5): one per-webview knob applied to every
// sentence the SpeechQueue plays. Set from settings by the voice surface.
let outputVolume = 1;

/** Set the playback volume (0..1) for all subsequent speech. */
export function setOutputVolume(v: number): void {
  outputVolume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

// Output device (3.9): the speaker/headset TTS plays on. "" = system default.
// Applied via HTMLAudioElement.setSinkId so June speaks on the same device its
// echo-cancelled monitor mic listens to. Set from settings by the voice surface.
let outputSinkId = "";

/** Route all subsequent speech to this output deviceId ("" = system default). */
export function setOutputDevice(id: string): void {
  outputSinkId = id;
}

/** Fixed backchannel/approval phrases June speaks constantly. These - and only
 *  these - are memoized by `synthesize` (3.5): re-running the cloud round-trip or a
 *  Kokoro pass for "On it." on every turn is pure waste. Callers reference these
 *  constants so the cache key stays in sync with what's actually spoken; arbitrary
 *  reply text is never cached, so the memo can't grow unbounded. */
export const CANNED_PHRASES = {
  onIt: "On it.",
  cancelled: "Okay, cancelled.",
  noYesCancel: "I didn't catch a yes, so I cancelled that.",
  micFailCancel: "I couldn't open the microphone, so I cancelled that.",
} as const;

const cannedSet = new Set<string>(Object.values(CANNED_PHRASES));
// Keyed by the full TTS stack (provider|model|voice|text) so a voice/provider
// change re-synthesizes rather than replaying the old voice.
const cannedCache = new Map<string, Promise<SpeechAudio>>();

/** Per-synth barge-in control (3.11): a `SpeechQueue`'s `stop()` cancels the cloud
 *  request in flight (via `cancelToken`) and skips a not-yet-started local Kokoro
 *  run (via `signal`). Absent = uncancelable (canned phrases, one-off tests). */
export interface SynthCancel {
  signal?: AbortSignal;
  cancelToken?: number;
}

// Monotonic token generator: one per SpeechQueue, so a barge-in cancels only that
// queue's cloud synths and never a sibling queue's (e.g. the real reply's sentences).
let nextCancelToken = 1;
/** A fresh cancel token for one SpeechQueue. */
export function newCancelToken(): number {
  return nextCancelToken++;
}

/** Synthesize one chunk of text. A local `choice.provider` runs on-device
 *  (local-tts.ts); everything else calls cloud OpenAI in Rust, which validates
 *  voice/model and falls back if unset. Empty text yields no audio. Rejects with a
 *  human-readable message on failure. Canned phrases (§CANNED_PHRASES) are memoized
 *  (and never carry a cancel token - they're tiny and shared across queues). */
export function synthesize(text: string, choice?: TtsChoice, cancel?: SynthCancel): Promise<SpeechAudio> {
  const trimmed = text.trim();
  if (!cannedSet.has(trimmed)) return synthesizeRaw(text, choice, cancel);
  const key = `${choice?.provider ?? ""}|${choice?.model ?? ""}|${choice?.voice ?? ""}|${trimmed}`;
  let hit = cannedCache.get(key);
  if (!hit) {
    hit = synthesizeRaw(trimmed, choice);
    hit.catch(() => cannedCache.delete(key)); // never cache a failed synthesis
    cannedCache.set(key, hit);
  }
  return hit;
}

async function synthesizeRaw(text: string, choice?: TtsChoice, cancel?: SynthCancel): Promise<SpeechAudio> {
  if (choice && resolveProvider("tts", choice.provider)?.kind === "local") {
    // Kokoro can't be interrupted mid-run, but a queued sentence whose generation
    // hasn't started yet is skipped on barge-in rather than burning the worker.
    if (cancel?.signal?.aborted) return { bytes: new Uint8Array(), mime: "audio/wav" };
    const { synthesizeLocal } = await import("./local-tts.ts");
    return { bytes: await synthesizeLocal(text, choice.voice, choice.model ?? "", cancel?.signal), mime: "audio/wav" };
  }
  const bytes = await invoke<number[]>("synthesize", {
    text,
    voice: choice?.voice,
    model: choice?.model,
    cancelToken: cancel?.cancelToken,
  });
  return { bytes: new Uint8Array(bytes), mime: "audio/mpeg" };
}

/** Accumulates streamed text deltas and flushes complete sentences as soon as
 *  they form, so the first sentence can be spoken while later ones still stream.
 *
 *  ponytail: a naive terminator split (. ! ? or newline followed by space). June's
 *  prompt spells numbers out and emits no markdown, so decimals/abbreviations that
 *  would fool it don't occur; a real sentence tokenizer isn't warranted. */
export class SentenceBuffer {
  #buf = "";

  /** Feed a delta; returns any newly-complete sentences (may be empty). */
  push(delta: string): string[] {
    this.#buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = boundary(this.#buf);
      if (cut < 0) break;
      const sentence = this.#buf.slice(0, cut).trim();
      this.#buf = this.#buf.slice(cut);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Emit whatever remains (the trailing sentence with no terminator). */
  flush(): string {
    const rest = this.#buf.trim();
    this.#buf = "";
    return rest;
  }
}

/** Index just past a sentence boundary, or -1 if the buffer holds no complete
 *  sentence yet. A terminator with nothing after it waits for more input (it
 *  might be mid-token, e.g. an ellipsis); a newline always ends a sentence. */
function boundary(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") return i + 1;
    if (c === "." || c === "!" || c === "?") {
      const next = s[i + 1];
      if (next === undefined) return -1;
      if (/\s/.test(next)) return i + 1;
    }
  }
  return -1;
}

/** Speaks enqueued sentences in order. Each sentence's synthesis starts when it
 *  is enqueued (so network round-trips overlap playback); playback stays ordered.
 *  `stop()` halts immediately and drops everything pending - this is barge-in. */
export class SpeechQueue {
  #pending: Promise<SpeechAudio>[] = [];
  #playing = false;
  #stopped = false;
  #spoke = false;
  #erred = false;
  #audio: HTMLAudioElement | null = null;
  // Barge-in cancellation (3.11): one token per queue cancels its in-flight cloud
  // synths in Rust; the signal skips a not-yet-started local Kokoro run.
  readonly #cancelToken = newCancelToken();
  readonly #abort = new AbortController();
  readonly #onIdle: () => void;
  readonly #onFirstAudio: () => void;
  readonly #onError: (e: unknown) => void;
  readonly #tts?: TtsChoice;

  /** @param onIdle fired whenever the queue drains. The queue can drain
   *  mid-turn (speech outpacing the token stream), so the caller decides
   *  whether a drain means the turn is over - see VoicePanel.accept.
   *  @param tts the user's TTS stack (§4); passed to each synthesis so a local
   *  provider speaks on-device.
   *  @param onFirstAudio fired once, when the first sentence begins playing -
   *  the voice-to-voice latency mark (Phase 11.5).
   *  @param onError fired at most once, on the first sentence that fails to
   *  synthesize or play (improvement-5 P0.7): the reply keeps going as text, but
   *  a dead TTS stack must not be a silent no-audio mystery. */
  constructor(
    onIdle: () => void = () => {},
    tts?: TtsChoice,
    onFirstAudio: () => void = () => {},
    onError: (e: unknown) => void = () => {},
  ) {
    this.#onIdle = onIdle;
    this.#onFirstAudio = onFirstAudio;
    this.#onError = onError;
    this.#tts = tts;
  }

  /** Report the first failure once; later ones repeat the same story. */
  #fail(e: unknown): void {
    if (this.#erred || this.#stopped) return;
    this.#erred = true;
    this.#onError(e);
  }

  /** True when nothing is playing and nothing is queued. */
  get idle(): boolean {
    return !this.#playing && this.#pending.length === 0;
  }

  enqueue(text: string): void {
    if (this.#stopped || !text.trim()) return;
    const audio = synthesize(text, this.#tts, { signal: this.#abort.signal, cancelToken: this.#cancelToken });
    audio.catch(() => {}); // failures are handled at play time; don't leak rejections
    this.#pending.push(audio);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#playing || this.#stopped) return;
    const next = this.#pending.shift();
    if (!next) {
      // Unconditional: a queue whose only sentence failed to synthesize must
      // still report the drain, or the caller waits forever for speech that
      // will never happen.
      this.#onIdle();
      return;
    }
    this.#playing = true;
    try {
      const { bytes, mime } = await next;
      if (this.#stopped) return;
      if (bytes.length > 0) {
        await this.#play(bytes, mime);
      }
    } catch (e) {
      // A single sentence failing to synthesize/play shouldn't abort the reply -
      // but the first failure is surfaced via onError so it isn't silent.
      this.#fail(e);
    } finally {
      this.#playing = false;
      if (!this.#stopped) void this.#pump();
    }
  }

  #play(bytes: Uint8Array, mime: string): Promise<void> {
    if (!this.#spoke) {
      this.#spoke = true;
      this.#onFirstAudio();
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const el = new Audio(url);
      el.volume = outputVolume;
      // Route to the chosen output device (3.9). setSinkId is async and unsupported
      // on some engines; a failure or absent API falls back to the system default
      // rather than dropping the sentence. Playback below doesn't await it - WebView2
      // applies the sink before audio actually starts.
      if (outputSinkId && typeof el.setSinkId === "function") {
        void el.setSinkId(outputSinkId).catch(() => {});
      }
      this.#audio = el;
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.#audio === el) this.#audio = null;
        resolve();
      };
      el.onended = done;
      el.onerror = () => {
        this.#fail(new Error("audio playback failed"));
        done();
      };
      void el.play().catch((e) => {
        this.#fail(e);
        done();
      });
    });
  }

  /** Barge-in: stop now, drop everything pending, speak nothing more. Also cancels
   *  synthesis already in flight (3.11) - the cloud request in Rust and any queued
   *  local run - so it stops spending the moment the next capture needs the machine. */
  stop(): void {
    this.#stopped = true;
    this.#pending = [];
    this.#abort.abort();
    void invoke("cancel_synthesis", { token: this.#cancelToken }).catch(() => {});
    if (this.#audio) {
      this.#audio.pause();
      this.#audio = null;
    }
  }
}
