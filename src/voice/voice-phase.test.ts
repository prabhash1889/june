import { afterEach, describe, expect, it, vi } from "vitest";

import {
  autoExpireMs,
  isActivePhase,
  isBusy,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  type Phase,
  type PhaseName,
  phaseReducer,
  speakingText,
  statusHint,
} from "./voice-phase.ts";

const ALL_PHASES: PhaseName[] = [
  "need-key",
  "idle",
  "listening",
  "transcribing",
  "review",
  "thinking",
  "speaking",
  "reply",
  "dictated",
  "captured",
  "error",
];

afterEach(() => vi.restoreAllMocks());

describe("isLegalTransition", () => {
  it("allows every self-transition (an idempotent re-set is always fine)", () => {
    for (const p of ALL_PHASES) expect(isLegalTransition(p, p)).toBe(true);
  });

  it("encodes the real forward flow of the pipeline", () => {
    expect(isLegalTransition("idle", "listening")).toBe(true);
    expect(isLegalTransition("listening", "transcribing")).toBe(true);
    expect(isLegalTransition("transcribing", "review")).toBe(true);
    expect(isLegalTransition("review", "thinking")).toBe(true);
    expect(isLegalTransition("thinking", "speaking")).toBe(true);
    expect(isLegalTransition("speaking", "reply")).toBe(true);
    // reply comes from thinking too (an empty/drained reply skips speaking).
    expect(isLegalTransition("thinking", "reply")).toBe(true);
  });

  it("keeps idle and error reachable from nearly everywhere (cancel / open-app)", () => {
    for (const p of ALL_PHASES) {
      if (p !== "idle") expect(isLegalTransition(p, "idle")).toBe(true);
      if (p !== "error") expect(isLegalTransition(p, "error")).toBe(true);
    }
  });

  it("flags transitions that never happen in the code", () => {
    // The key gate is only entered from a resting phase (B2.8), never mid-turn.
    expect(isLegalTransition("thinking", "need-key")).toBe(false);
    expect(isLegalTransition("reply", "need-key")).toBe(false);
    // Nothing jumps straight from rest into the middle of a turn.
    expect(isLegalTransition("idle", "thinking")).toBe(false);
    expect(isLegalTransition("idle", "speaking")).toBe(false);
    expect(isLegalTransition("review", "speaking")).toBe(false);
  });

  it("has a table entry for every phase", () => {
    for (const p of ALL_PHASES) expect(LEGAL_TRANSITIONS[p]).toBeDefined();
  });
});

describe("phaseReducer", () => {
  it("applies a plain next phase", () => {
    expect(phaseReducer({ s: "idle" }, { s: "listening" })).toEqual({ s: "listening" });
  });

  it("resolves a functional update against the previous phase", () => {
    const next = phaseReducer({ s: "review", transcript: "hi" }, (prev) =>
      prev.s === "review" ? { s: "thinking" } : prev,
    );
    expect(next).toEqual({ s: "thinking" });
  });

  it("is fail-open: an illegal transition is still applied, not blocked", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // idle -> speaking is not a legal transition, but the reducer must not strand
    // the UI by rejecting it - it applies and warns.
    expect(phaseReducer({ s: "idle" }, { s: "speaking", text: "x" })).toEqual({
      s: "speaking",
      text: "x",
    });
  });

  it("warns in dev on an unexpected transition", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    phaseReducer({ s: "idle" }, { s: "speaking", text: "x" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("stays quiet on a legal transition", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    phaseReducer({ s: "idle" }, { s: "listening" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("statusHint", () => {
  const opts = { dictation: false, pttLabel: "Ctrl + Shift + Space" };

  it("returns the hotkey prompt at rest", () => {
    expect(statusHint("idle", opts)).toContain("Ctrl + Shift + Space");
  });

  it("rewords the resting/listening prompts in dictation mode", () => {
    expect(statusHint("idle", { ...opts, dictation: true })).toContain("focused app");
    expect(statusHint("listening", { ...opts, dictation: true })).toBe("Dictating…");
    expect(statusHint("listening", opts)).toBe("Listening…");
  });

  it("has no status line for terminal/gate phases", () => {
    for (const p of ["need-key", "reply", "dictated", "captured", "error"] as PhaseName[]) {
      expect(statusHint(p, opts)).toBe("");
    }
  });
});

describe("isBusy", () => {
  it("is true only while the pipeline is actively working", () => {
    for (const p of ["listening", "transcribing", "thinking", "speaking"] as PhaseName[]) {
      expect(isBusy(p)).toBe(true);
    }
    for (const p of [
      "need-key",
      "idle",
      "review",
      "reply",
      "dictated",
      "captured",
      "error",
    ] as PhaseName[]) {
      expect(isBusy(p)).toBe(false);
    }
  });
});

describe("speakingText", () => {
  it("returns the text for speaking and reply, empty otherwise", () => {
    expect(speakingText({ s: "speaking", text: "streaming" })).toBe("streaming");
    expect(speakingText({ s: "reply", text: "final" })).toBe("final");
    expect(speakingText({ s: "idle" })).toBe("");
    expect(speakingText({ s: "review", transcript: "t" })).toBe("");
  });
});

describe("isActivePhase", () => {
  const rest = { hasApproval: false, missionActive: false, dictation: false };

  it("is inactive only at idle with nothing else going on", () => {
    expect(isActivePhase("idle", rest)).toBe(false);
  });

  it("is active in any non-idle phase", () => {
    expect(isActivePhase("thinking", rest)).toBe(true);
  });

  it("stays active while idle if an approval, mission, or dictation holds the card open", () => {
    expect(isActivePhase("idle", { ...rest, hasApproval: true })).toBe(true);
    expect(isActivePhase("idle", { ...rest, missionActive: true })).toBe(true);
    expect(isActivePhase("idle", { ...rest, dictation: true })).toBe(true);
  });
});

describe("autoExpireMs", () => {
  it("expires the lingering phases to idle, and only those", () => {
    expect(autoExpireMs("dictated")).toBe(2_500);
    expect(autoExpireMs("captured")).toBe(2_500);
    expect(autoExpireMs("error")).toBe(4_000);
    expect(autoExpireMs("reply")).toBe(12_000);
    for (const p of [
      "need-key",
      "idle",
      "listening",
      "transcribing",
      "review",
      "thinking",
      "speaking",
    ] as PhaseName[]) {
      expect(autoExpireMs(p)).toBeNull();
    }
  });

  it("keeps reply longer than the follow-up window so follow-up mode gets its full window", () => {
    // FOLLOWUP_WINDOW_MS is 6_000 in VoicePanel; the reply must outlast it.
    expect(autoExpireMs("reply")).toBeGreaterThan(6_000);
  });
});

// Type-only: Phase is re-exported and usable here.
const _sample: Phase = { s: "idle" };
void _sample;
