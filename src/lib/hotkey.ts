import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { DEFAULT_SETTINGS, loadSettings } from "./settings.ts";

// The configurable push-to-talk chord (improvement-5 P2 6.6). The stored form is
// global-shortcut syntax ("ctrl+shift+space"), parsed by Rust's global-shortcut
// plugin; this module renders it for humans and captures a new one from a
// keydown. One source of truth ends the four hardcoded "Ctrl + Shift + Space"
// strings that drifted across both faces.

/** Human label for a stored chord: "ctrl+shift+space" -> "Ctrl + Shift + Space". */
export function hotkeyLabel(hotkey: string): string {
  return hotkey
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^f\d{1,2}$/i.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" + ");
}

/** The token global-shortcut understands for a KeyboardEvent.code, or null for
 *  keys we don't allow as a PTT trigger (bare modifiers, navigation keys, …).
 *  Letters, digits, F-keys and Space cover every sane hold-to-talk chord. */
function keyToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  if (code === "Space") return "space";
  return null;
}

/** Build a chord from a captured keydown, or null when it can't be one: a bare
 *  modifier press, no modifier at all (a global un-modified key would eat normal
 *  typing system-wide), or an unsupported key. */
export function chordFromKeyEvent(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  code: string;
}): string | null {
  const key = keyToken(e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "super"].filter(
    (m): m is string => typeof m === "string",
  );
  if (mods.length === 0) return null;
  return [...mods, key].join("+");
}

/** The current PTT chord's human label, live across settings changes - for
 *  surfaces (the app window) that don't otherwise load settings. */
export function usePttLabel(): string {
  const [label, setLabel] = useState(hotkeyLabel(DEFAULT_SETTINGS.pttHotkey));
  useEffect(() => {
    const refresh = () =>
      loadSettings()
        .then((s) => setLabel(hotkeyLabel(s.pttHotkey)))
        .catch(() => {});
    void refresh();
    const unlisten = listen("settings://changed", () => void refresh());
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);
  return label;
}
