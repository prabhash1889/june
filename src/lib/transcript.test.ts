import { describe, expect, it } from "vitest";

import { captureCorrections, cleanTranscript } from "./transcript.ts";

// The cleaner is the whole of 15.1-15.3 (pure, offline). These pin the three
// transforms and the correction-learning heuristic that makes a fixed name stick.
describe("cleanTranscript", () => {
  it("strips fillers, fixes spacing/punctuation, and capitalizes under autoEdit", () => {
    expect(cleanTranscript("um open  two agents", { autoEdit: true })).toBe("Open two agents.");
    expect(cleanTranscript("you know send it , please", { autoEdit: true })).toBe("Send it, please.");
    expect(cleanTranscript("what is the status", { autoEdit: true })).toBe("What is the status.");
  });

  it("leaves the words untouched (only trims) when autoEdit is off", () => {
    expect(cleanTranscript("um open  two agents")).toBe("um open two agents");
  });

  it("does not strip meaningful words that resemble fillers", () => {
    // "like"/"actually" carry meaning and must survive the filler pass.
    expect(cleanTranscript("I actually like this", { autoEdit: true })).toBe("I actually like this.");
  });

  it("applies the personal dictionary whole-word, case-insensitively", () => {
    const dictionary = { june: "June", saple: "SAPLE" };
    expect(cleanTranscript("open june on saple", { dictionary })).toBe("open June on SAPLE");
    // whole-word only: never rewrite a substring inside another word.
    expect(cleanTranscript("junebug", { dictionary })).toBe("junebug");
  });

  it("inserts dictionary/snippet values literally, so `$&` is not a back-reference (B4.9)", () => {
    // A value containing a `$&` (or `$1`) must appear verbatim, never expand to the
    // matched text - otherwise a user's term/snippet could rewrite itself.
    expect(cleanTranscript("say total", { dictionary: { total: "$&100" } })).toBe("say $&100");
    expect(cleanTranscript("insert sig", { snippets: { sig: "Best $&" } })).toBe("insert Best $&");
  });

  it("expands voice snippets from a spoken cue", () => {
    const snippets = { "insert my intro": "Hi, I'm June's owner." };
    expect(cleanTranscript("insert my intro", { snippets })).toBe("Hi, I'm June's owner.");
    expect(cleanTranscript("please insert my intro now", { snippets })).toBe("please Hi, I'm June's owner. now");
  });

  it("expands snippets before applying the dictionary", () => {
    const snippets = { greeting: "hello june" };
    const dictionary = { june: "June" };
    expect(cleanTranscript("greeting", { snippets, dictionary })).toBe("hello June");
  });
});

describe("captureCorrections", () => {
  it("learns a single-word correction from a review edit", () => {
    const dict = captureCorrections("Open june.", "Open June.", {});
    expect(dict).toEqual({ june: "June" });
  });

  it("learns a mid-sentence name fix but not first-word capitalization", () => {
    // "open" -> "Open" at the start is grammar and must not be learned; "june" ->
    // "June" mid-sentence is the real correction the exit criterion needs to stick.
    const dict = captureCorrections("open june", "Open June", {});
    expect(dict).toEqual({ june: "June" });
  });

  it("returns the same map (no persist) when nothing changed", () => {
    const before = {};
    expect(captureCorrections("Open the app.", "Open the app.", before)).toBe(before);
  });

  it("skips ambiguous edits that add or remove words", () => {
    const before = {};
    expect(captureCorrections("open it", "open it now please", before)).toBe(before);
  });

  it("does not learn multi-word or punctuation-only changes", () => {
    // A phrase swap (still 1:1 tokens) only learns the single-word cells.
    const dict = captureCorrections("send teh msg", "send the message", {});
    expect(dict).toEqual({ teh: "the", msg: "message" });
  });

  it("caps the dictionary to the newest entries", () => {
    const dict = captureCorrections("aa bb", "xx yy", {}, 1);
    expect(Object.keys(dict)).toHaveLength(1);
  });
});
