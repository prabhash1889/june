import { describe, expect, it } from "vitest";

import { chordFromKeyEvent, hotkeyLabel } from "./hotkey.ts";

const ev = (code: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  metaKey: mods.meta ?? false,
  code,
});

describe("hotkeyLabel", () => {
  it("renders the default chord exactly as the old hardcoded strings did", () => {
    expect(hotkeyLabel("ctrl+shift+space")).toBe("Ctrl + Shift + Space");
  });

  it("uppercases F-keys and single letters", () => {
    expect(hotkeyLabel("ctrl+alt+f5")).toBe("Ctrl + Alt + F5");
    expect(hotkeyLabel("super+j")).toBe("Super + J");
  });

  it("survives stray separators", () => {
    expect(hotkeyLabel("ctrl++space")).toBe("Ctrl + Space");
  });
});

describe("chordFromKeyEvent", () => {
  it("builds a chord from modifiers plus a supported key", () => {
    expect(chordFromKeyEvent(ev("Space", { ctrl: true, shift: true }))).toBe("ctrl+shift+space");
    expect(chordFromKeyEvent(ev("KeyJ", { ctrl: true, alt: true }))).toBe("ctrl+alt+j");
    expect(chordFromKeyEvent(ev("Digit1", { alt: true }))).toBe("alt+1");
    expect(chordFromKeyEvent(ev("F9", { meta: true }))).toBe("super+f9");
  });

  it("rejects a bare modifier press (chord still being held down)", () => {
    expect(chordFromKeyEvent(ev("ControlLeft", { ctrl: true }))).toBeNull();
    expect(chordFromKeyEvent(ev("ShiftRight", { shift: true }))).toBeNull();
  });

  it("rejects an unmodified key - a global bare key would eat normal typing", () => {
    expect(chordFromKeyEvent(ev("KeyA"))).toBeNull();
    expect(chordFromKeyEvent(ev("Space"))).toBeNull();
  });

  it("rejects unsupported keys", () => {
    expect(chordFromKeyEvent(ev("Escape", { ctrl: true }))).toBeNull();
    expect(chordFromKeyEvent(ev("ArrowUp", { ctrl: true }))).toBeNull();
  });
});
