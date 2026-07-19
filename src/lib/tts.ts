import { invoke } from "@tauri-apps/api/core";

// Text-to-speech surface for the webview (PLAN.md Phase 5). Rust holds the
// OpenAI key and returns encoded audio; this module splits June's reply into
// sentences, synthesizes them, and plays them in order so June starts speaking
// before the whole answer is generated. `SpeechQueue.stop()` is the barge-in.

/** Synthesize one chunk of text to mp3 bytes via Rust. `voice`/`model` come from
 *  settings (§4 Voice); Rust validates them and falls back if unset. Empty text
 *  yields no audio. Rejects with a human-readable message on failure. */
export async function synthesize(text: string, voice?: string, model?: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("synthesize", { text, voice, model });
  return new Uint8Array(bytes);
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
  #pending: Promise<Uint8Array>[] = [];
  #playing = false;
  #stopped = false;
  #audio: HTMLAudioElement | null = null;
  readonly #onIdle: () => void;
  readonly #voice?: string;
  readonly #model?: string;

  /** @param onIdle fired whenever the queue drains. The queue can drain
   *  mid-turn (speech outpacing the token stream), so the caller decides
   *  whether a drain means the turn is over - see VoicePanel.accept.
   *  @param voice/model the user's TTS choice (§4); passed to each synthesis. */
  constructor(onIdle: () => void = () => {}, voice?: string, model?: string) {
    this.#onIdle = onIdle;
    this.#voice = voice;
    this.#model = model;
  }

  /** True when nothing is playing and nothing is queued. */
  get idle(): boolean {
    return !this.#playing && this.#pending.length === 0;
  }

  enqueue(text: string): void {
    if (this.#stopped || !text.trim()) return;
    const audio = synthesize(text, this.#voice, this.#model);
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
      const bytes = await next;
      if (this.#stopped) return;
      if (bytes.length > 0) {
        await this.#play(bytes);
      }
    } catch {
      // A single sentence failing to synthesize/play shouldn't abort the reply.
    } finally {
      this.#playing = false;
      if (!this.#stopped) void this.#pump();
    }
  }

  #play(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const el = new Audio(url);
      this.#audio = el;
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.#audio === el) this.#audio = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      void el.play().catch(done);
    });
  }

  /** Barge-in: stop now, drop everything pending, speak nothing more. */
  stop(): void {
    this.#stopped = true;
    this.#pending = [];
    if (this.#audio) {
      this.#audio.pause();
      this.#audio = null;
    }
  }
}
