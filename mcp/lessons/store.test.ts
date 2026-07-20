// The lessons store's non-trivial logic (Phase 17.1/17.2): appending a lesson
// with count+byte caps, and the top-k keyword/recency recall ranker. Pure, so no
// file/server needed.

import { describe, expect, it } from "vitest";

import { appendLesson, parseLessons, recallLessons, trimToBytes } from "./store.ts";

describe("appendLesson", () => {
  it("adds a bullet, collapsing whitespace", () => {
    expect(appendLesson("", "pass   the\tmodel id", 60, 10_000)).toBe("- pass the model id");
  });

  it("appends under existing lessons", () => {
    expect(appendLesson("- first lesson", "second lesson", 60, 10_000)).toBe("- first lesson\n- second lesson");
  });

  it("caps to the newest maxCount lessons", () => {
    const existing = "- one\n- two\n- three";
    // maxCount 3 -> the oldest ("one") falls off when the fourth is added.
    expect(appendLesson(existing, "four", 3, 10_000)).toBe("- two\n- three\n- four");
  });
});

describe("trimToBytes", () => {
  it("keeps the whole text when it fits", () => {
    const text = "- a\n- b\n- c";
    expect(trimToBytes(text, 1000)).toBe(text);
  });

  it("drops the oldest lines to fit the cap, newest kept", () => {
    expect(trimToBytes("- a\n- b\n- c", 9)).toBe("- b\n- c");
  });

  it("keeps at least one line even if it alone exceeds the cap", () => {
    expect(trimToBytes("- a very long single lesson", 5)).toBe("- a very long single lesson");
  });
});

describe("parseLessons", () => {
  it("strips the bullet and drops blanks", () => {
    expect(parseLessons("- one\n\n* two\n  - three  ")).toEqual(["one", "two", "three"]);
  });
});

describe("recallLessons", () => {
  const corpus = [
    "- when spawning codex agents pass the model id or they default to a slow model",
    "- close the terminal pane before opening a new browser tab",
    "- the calendar summary reads better sorted by start time",
  ].join("\n");

  it("returns lessons that share content words with the task, most relevant first", () => {
    const out = recallLessons(corpus, "spawn two codex agents", 3);
    expect(out[0]).toContain("codex agents");
  });

  it("drops lessons with no keyword overlap", () => {
    expect(recallLessons(corpus, "spawn codex agents", 3)).not.toContain(
      "the calendar summary reads better sorted by start time",
    );
  });

  it("returns nothing for an unrelated task", () => {
    expect(recallLessons(corpus, "tell me a joke", 3)).toEqual([]);
  });

  it("caps at k and breaks ties by recency (newer wins)", () => {
    // Both lessons match "browser"; the newer (second) must come first on a tie.
    const two = "- open the browser at the docs url\n- reopen the browser tab after a crash";
    const out = recallLessons(two, "browser", 1);
    expect(out).toEqual(["reopen the browser tab after a crash"]);
  });

  it("ignores stopword-only queries", () => {
    expect(recallLessons(corpus, "can you do this for me", 3)).toEqual([]);
  });
});
