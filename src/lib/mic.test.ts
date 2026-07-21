import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicManager, type MicOpener, PreRollRing } from "./mic.ts";

/** A minimal MediaStream stand-in: one audio track whose `stop()` flips it to
 *  "ended", so the manager's live-track check and teardown are exercised. */
function fakeStream() {
  let state: "live" | "ended" = "live";
  const track = {
    get readyState() {
      return state;
    },
    stop() {
      state = "ended";
    },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    track,
  };
  return stream as unknown as MediaStream & { track: typeof track };
}

describe("PreRollRing", () => {
  it("retains only the last `capacity` samples, oldest-first", () => {
    const ring = new PreRollRing(4);
    ring.push(new Float32Array([1, 2, 3]));
    expect(Array.from(ring.read())).toEqual([1, 2, 3]);
    ring.push(new Float32Array([4, 5])); // 5 samples into a 4-slot ring: drop the oldest (1)
    expect(Array.from(ring.read())).toEqual([2, 3, 4, 5]);
  });

  it("keeps only the tail of a frame larger than the whole ring", () => {
    const ring = new PreRollRing(3);
    ring.push(new Float32Array([1, 2, 3, 4, 5]));
    expect(Array.from(ring.read())).toEqual([3, 4, 5]);
  });

  it("clear empties it", () => {
    const ring = new PreRollRing(3);
    ring.push(new Float32Array([1, 2]));
    ring.clear();
    expect(Array.from(ring.read())).toEqual([]);
  });
});

describe("MicManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens once and shares one stream across concurrent consumers", async () => {
    const stream = fakeStream();
    const opener = vi.fn((_d?: string) => Promise.resolve(stream as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    const [a, b] = await Promise.all([mic.acquire("dev"), mic.acquire("dev")]);
    expect(opener).toHaveBeenCalledTimes(1); // deduped concurrent open
    expect(a.stream).toBe(stream);
    expect(b.stream).toBe(stream);
    expect(mic.refCount).toBe(2);
  });

  it("keeps the stream live through a release+acquire handoff (no reopen)", async () => {
    const stream = fakeStream();
    const opener = vi.fn((_d?: string) => Promise.resolve(stream as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    const a = await mic.acquire("dev");
    const b = await mic.acquire("dev"); // a second consumer joins (wake -> capture)
    a.release(); // the first leaves, but b still holds it
    const c = await mic.acquire("dev");
    expect(opener).toHaveBeenCalledTimes(1);
    expect(mic.refCount).toBe(2);
    expect(stream.track.readyState).toBe("live");
    void b;
    void c;
  });

  it("closes the stream a linger after the last release", async () => {
    const stream = fakeStream();
    const opener = vi.fn((_d?: string) => Promise.resolve(stream as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    (await mic.acquire("dev")).release();
    expect(stream.track.readyState).toBe("live"); // still open during the linger
    vi.advanceTimersByTime(800);
    expect(stream.track.readyState).toBe("ended");
    expect(mic.refCount).toBe(0);
  });

  it("cancels the pending close when re-acquired within the linger", async () => {
    const stream = fakeStream();
    const opener = vi.fn((_d?: string) => Promise.resolve(stream as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    (await mic.acquire("dev")).release();
    vi.advanceTimersByTime(400); // inside the linger window
    const b = await mic.acquire("dev"); // reuse the still-open stream
    vi.advanceTimersByTime(800); // the old close must not fire
    expect(opener).toHaveBeenCalledTimes(1);
    expect(stream.track.readyState).toBe("live");
    void b;
  });

  it("release is idempotent (a double hotkey-up can't over-decrement)", async () => {
    const stream = fakeStream();
    const opener = vi.fn((_d?: string) => Promise.resolve(stream as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    const a = await mic.acquire("dev");
    const b = await mic.acquire("dev");
    a.release();
    a.release();
    expect(mic.refCount).toBe(1);
    void b;
  });

  it("swaps device when re-acquired on a different mic during the linger", async () => {
    const s1 = fakeStream();
    const s2 = fakeStream();
    const streams = [s1, s2];
    let i = 0;
    const opener = vi.fn((_d?: string) => Promise.resolve(streams[i++] as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    (await mic.acquire("dev1")).release();
    const b = await mic.acquire("dev2"); // different device before the linger closes s1
    expect(opener).toHaveBeenCalledTimes(2);
    expect(s1.track.readyState).toBe("ended");
    expect(b.stream).toBe(s2);
  });

  it("reopens when the held track has ended under it (device unplugged)", async () => {
    const s1 = fakeStream();
    const s2 = fakeStream();
    const streams = [s1, s2];
    let i = 0;
    const opener = vi.fn((_d?: string) => Promise.resolve(streams[i++] as MediaStream));
    const mic = new MicManager(opener as MicOpener, 800);
    const a = await mic.acquire("dev");
    s1.track.stop(); // an OS revoke / unplug ends the track without a release
    const b = await mic.acquire("dev");
    expect(opener).toHaveBeenCalledTimes(2);
    expect(b.stream).toBe(s2);
    void a;
  });
});
