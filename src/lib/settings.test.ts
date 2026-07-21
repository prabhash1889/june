import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, privacyViolations, voiceAllowed } from "./settings.ts";

describe("defaults", () => {
  it("ships the default PTT chord, system-default mic, and full volume", () => {
    expect(DEFAULT_SETTINGS.pttHotkey).toBe("ctrl+shift+space");
    expect(DEFAULT_SETTINGS.micDeviceId).toBe("");
    expect(DEFAULT_SETTINGS.outputDeviceId).toBe("");
    expect(DEFAULT_SETTINGS.outputVolume).toBe(1);
  });
});

// privacyViolations is the pure check the settings UI warns from AND the run
// path enforces, so it is worth pinning against each mode (PLAN.md §5).
describe("privacy violations", () => {
  it("the default stack is compliant under standard", () => {
    expect(privacyViolations(DEFAULT_SETTINGS)).toEqual([]);
    expect(voiceAllowed(DEFAULT_SETTINGS)).toBe(true);
  });

  it("strict-offline flags the cloud brain and cloud voice at every stage", () => {
    const s = { ...DEFAULT_SETTINGS, privacyMode: "strict-offline" as const };
    expect(privacyViolations(s).map((v) => v.stage).sort()).toEqual(["brain", "stt", "tts"]);
    expect(voiceAllowed(s)).toBe(false);
  });

  it("local-voice flags only the voice stages, not the brain", () => {
    const s = { ...DEFAULT_SETTINGS, privacyMode: "local-voice" as const };
    expect(privacyViolations(s).map((v) => v.stage).sort()).toEqual(["stt", "tts"]);
    expect(voiceAllowed(s)).toBe(false);
  });
});
