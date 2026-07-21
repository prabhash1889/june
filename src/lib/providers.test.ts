// @vitest-environment node
// Node env (not the repo-default jsdom): 7.13's cross-source pin reads the Rust
// source off disk. The pure-function tests below have no DOM deps, so node is fine.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultVoiceFor, PROVIDERS, resolveProvider, type Stage, voicesFor } from "./providers.ts";

// Phase 12.3/12.4 flipped the local voice providers from "coming soon" to real.
// Pin that they are selectable AND offline-safe (both matter: available drives the
// picker, offlineSafe drives privacy enforcement).

it("local Moonshine STT and Kokoro TTS are available and offline-safe", () => {
  const stt = resolveProvider("stt", "moonshine")!;
  const tts = resolveProvider("tts", "kokoro")!;
  expect(stt.available && stt.offlineSafe && stt.kind === "local").toBe(true);
  expect(tts.available && tts.offlineSafe && tts.kind === "local").toBe(true);
});

it("voice options and defaults follow the TTS provider", () => {
  // Kokoro and OpenAI have disjoint voice tables; the picker and the reset-on-
  // switch default must track the selected provider so a voice never dangles.
  expect(defaultVoiceFor("kokoro")).toBe("af_heart");
  expect(defaultVoiceFor("openai")).toBe("alloy");
  expect(voicesFor("kokoro").map((v) => v.id)).toContain("af_heart");
  expect(voicesFor("openai").map((v) => v.id)).toContain("alloy");
  expect(voicesFor("kokoro").some((v) => v.id === "alloy")).toBe(false);
});

// 7.13: the provider -> keychain-service mapping is duplicated across TS
// (PROVIDERS[].keyService) and Rust (diagnostics.rs `key_service_for`), with only a
// comment keeping them honest. This greps the Rust source and pins the two to each
// other, so a rename or an added/removed keyed provider on either side fails CI
// instead of silently drifting (a mismatch = a probe reading the wrong keychain entry).

/** Parse `key_service_for`'s match arms out of the Rust source into {provider: service}.
 *  The `_ => ""` fallback (local providers, no key) is skipped - its empty value never
 *  matches the "1+ char" service pattern. */
function rustKeyServices(): Record<string, string> {
  const src = readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/diagnostics.rs", import.meta.url)),
    "utf8",
  );
  const body = src.match(/fn key_service_for[\s\S]*?\n}/);
  if (!body) throw new Error("key_service_for not found in diagnostics.rs - did it move?");
  const map: Record<string, string> = {};
  for (const m of body[0].matchAll(/"([a-z0-9_]+)"\s*=>\s*"([a-z0-9_]+)"/g)) {
    map[m[1]] = m[2];
  }
  return map;
}

/** The TS provider -> keyService mapping, deduped across stages (a keyed id like
 *  "openai" appears in several stages, always with the same service). */
function tsKeyServices(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const stage of Object.keys(PROVIDERS) as Stage[]) {
    for (const p of PROVIDERS[stage]) {
      if (p.keyService) map[p.id] = p.keyService;
    }
  }
  return map;
}

describe("provider keychain-service metadata stays in step across Rust and TS (7.13)", () => {
  const rust = rustKeyServices();
  const ts = tsKeyServices();

  it("parses at least the four keyed providers from the Rust source", () => {
    // Guards against a silently-empty parse (e.g. the fn was renamed) that would make
    // every other assertion trivially pass.
    expect(Object.keys(rust).length).toBeGreaterThanOrEqual(4);
  });

  it("every Rust key_service_for arm matches the TS provider's keyService", () => {
    for (const [provider, service] of Object.entries(rust)) {
      expect(ts[provider], `TS PROVIDERS is missing keyService "${service}" for "${provider}"`).toBe(service);
    }
  });

  it("every keyed TS provider is mapped by Rust key_service_for", () => {
    for (const [provider, service] of Object.entries(ts)) {
      expect(rust[provider], `Rust key_service_for is missing "${provider}"`).toBe(service);
    }
  });
});
