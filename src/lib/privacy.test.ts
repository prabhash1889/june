import { describe, expect, it } from "vitest";

import { providerAllowed } from "./privacy.ts";
import { resolveProvider } from "./providers.ts";

// The privacy model reduces to one rule (providerAllowed); these pin the three
// tiers against real registry providers so a metadata change can't silently
// weaken enforcement (PLAN.md §5).
const cloudBrain = resolveProvider("brain", "openai")!;
const localBrain = resolveProvider("brain", "ollama")!;
const cloudStt = resolveProvider("stt", "openai")!;
const cloudTts = resolveProvider("tts", "openai")!;

describe("privacy modes", () => {
  it("standard allows any provider at any stage", () => {
    expect(providerAllowed("standard", "brain", cloudBrain)).toBe(true);
    expect(providerAllowed("standard", "stt", cloudStt)).toBe(true);
    expect(providerAllowed("standard", "tts", cloudTts)).toBe(true);
  });

  it("local-voice blocks cloud voice but still allows a cloud brain", () => {
    expect(providerAllowed("local-voice", "stt", cloudStt)).toBe(false);
    expect(providerAllowed("local-voice", "tts", cloudTts)).toBe(false);
    expect(providerAllowed("local-voice", "brain", cloudBrain)).toBe(true);
  });

  it("strict-offline blocks every cloud stage but allows a local brain", () => {
    expect(providerAllowed("strict-offline", "brain", cloudBrain)).toBe(false);
    expect(providerAllowed("strict-offline", "stt", cloudStt)).toBe(false);
    expect(providerAllowed("strict-offline", "brain", localBrain)).toBe(true);
  });
});
