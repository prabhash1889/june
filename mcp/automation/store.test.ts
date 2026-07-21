import { describe, expect, it } from "vitest";

import {
  removeAutomation,
  setAutomationEnabled,
  summarizeAutomations,
  validateSchedule,
  validateWatch,
  withSchedule,
  withWatch,
} from "./store.ts";

describe("validateSchedule (P1.5)", () => {
  it("accepts a valid daily schedule and fills defaults", () => {
    const s = validateSchedule({ label: "Brief", prompt: "brief me", kind: "daily", time: "09:00", enabled: true });
    expect(s).toMatchObject({ id: "brief", kind: "daily", time: "09:00", everyMinutes: 60 });
  });

  it("accepts a valid interval schedule", () => {
    const s = validateSchedule({ label: "Poll", prompt: "check", kind: "every", everyMinutes: 15 });
    expect(s).toMatchObject({ kind: "every", everyMinutes: 15 });
  });

  it("rejects a daily with no time and an every with no interval", () => {
    expect(validateSchedule({ label: "x", kind: "daily", time: "nope" })).toBeNull();
    expect(validateSchedule({ label: "x", kind: "every" })).toBeNull();
  });

  it("accepts a valid once reminder and rejects one with no valid absolute time (4.1)", () => {
    expect(validateSchedule({ label: "Call mom", prompt: "call mom", kind: "once", at: "2026-07-21T15:00" })).toMatchObject({
      kind: "once",
      at: "2026-07-21T15:00",
    });
    expect(validateSchedule({ label: "x", kind: "once", at: "later" })).toBeNull();
    expect(validateSchedule({ label: "x", kind: "once" })).toBeNull();
  });
});

describe("validateWatch (P1.5)", () => {
  it("accepts a valid watch, rejects one with no interval", () => {
    expect(validateWatch({ label: "Build", prompt: "check ci", everyMinutes: 10, untilCondition: "green" })).toMatchObject({
      everyMinutes: 10,
      untilCondition: "green",
    });
    expect(validateWatch({ label: "x", prompt: "y" })).toBeNull();
  });
});

describe("withSchedule / withWatch (P1.5)", () => {
  it("appends to the existing list and preserves other settings keys", () => {
    const bag = { brain: { provider: "claude" }, schedules: [{ id: "a", label: "A", prompt: "", kind: "daily", time: "08:00", days: [], everyMinutes: 60, enabled: true }] };
    const s = validateSchedule({ label: "B", prompt: "x", kind: "daily", time: "09:00" })!;
    const next = withSchedule(bag, s) as { brain: unknown; schedules: { id: string }[] };
    expect(next.brain).toEqual({ provider: "claude" }); // untouched
    expect(next.schedules.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("de-duplicates a colliding id on append", () => {
    const bag = { schedules: [{ id: "brief", label: "Brief", prompt: "", kind: "daily", time: "08:00", days: [], everyMinutes: 60, enabled: true }] };
    const s = validateSchedule({ label: "Brief", prompt: "x", kind: "daily", time: "09:00" })!;
    const next = withSchedule(bag, s) as { schedules: { id: string }[] };
    expect(next.schedules.map((x) => x.id)).toEqual(["brief", "brief-2"]);
  });

  it("appends a watch to an empty bag", () => {
    const w = validateWatch({ label: "Build", prompt: "check", everyMinutes: 5 })!;
    const next = withWatch({}, w) as { watches: { id: string }[] };
    expect(next.watches).toHaveLength(1);
  });
});

describe("summarizeAutomations (P1.5)", () => {
  it("reports nothing when empty", () => {
    expect(summarizeAutomations({})).toContain("no automations");
  });

  it("summarizes schedules and watches", () => {
    const bag = {
      schedules: [{ label: "Brief", prompt: "x", kind: "daily", time: "09:00", days: [], enabled: true }],
      watches: [{ label: "Build", prompt: "y", everyMinutes: 10, untilCondition: "green", enabled: true }],
    };
    const out = summarizeAutomations(bag);
    expect(out).toContain("Brief");
    expect(out).toContain("daily at 09:00");
    expect(out).toContain("Build");
    expect(out).toContain("every 10 min");
  });

  it("summarizes a once reminder (4.1)", () => {
    const out = summarizeAutomations({
      schedules: [{ label: "Call mom", prompt: "call mom", kind: "once", at: "2026-07-21T15:00", enabled: true }],
    });
    expect(out).toContain("Call mom");
    expect(out).toContain("once at 2026-07-21T15:00");
  });
});

describe("setAutomationEnabled / removeAutomation (4.2)", () => {
  const bag = () => ({
    other: { keep: true },
    schedules: [{ id: "brief", label: "Morning briefing", enabled: true }],
    watches: [{ id: "build", label: "Build watch", enabled: true }],
    triggers: [{ id: "err", label: "Error log", enabled: false }],
  });

  it("disables a watch by label (case-insensitive) and preserves everything else", () => {
    const { bag: next, result } = setAutomationEnabled(bag(), "build watch", false);
    expect(result).toEqual({ kind: "watch", id: "build", label: "Build watch" });
    expect(next.watches[0].enabled).toBe(false);
    expect(next.schedules[0].enabled).toBe(true); // untouched
    expect(next.other).toEqual({ keep: true }); // untouched
  });

  it("enables a trigger by id", () => {
    const { bag: next, result } = setAutomationEnabled(bag(), "err", true);
    expect(result?.kind).toBe("trigger");
    expect(next.triggers[0].enabled).toBe(true);
  });

  it("removes a schedule by label and leaves the others", () => {
    const { bag: next, result } = removeAutomation(bag(), "Morning briefing");
    expect(result).toEqual({ kind: "schedule", id: "brief", label: "Morning briefing" });
    expect(next.schedules).toHaveLength(0);
    expect(next.watches).toHaveLength(1);
  });

  it("returns a null result and an unchanged bag when nothing matches", () => {
    const original = bag();
    const enable = setAutomationEnabled(original, "nope", false);
    expect(enable.result).toBeNull();
    expect(enable.bag).toBe(original);
    const remove = removeAutomation(original, "nope");
    expect(remove.result).toBeNull();
    expect(remove.bag).toBe(original);
  });
});
