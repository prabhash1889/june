// Theme selection (3.4). June hardpinned dark; this adds a light palette and a
// three-way choice - Dark, Light, or System (follow the OS). The palette itself
// lives in CSS variables (styles.css); this module only decides which set is
// active by stamping `data-theme` on the document root.
//
// For "system" we resolve the OS preference to a concrete `data-theme` and keep it
// in sync with a matchMedia listener, so the CSS needs one light override block
// (`:root[data-theme="light"]`) rather than duplicating it under a media query.

export type ThemeMode = "system" | "light" | "dark";

export const THEMES: { id: ThemeMode; label: string; desc: string }[] = [
  { id: "system", label: "System", desc: "Follow your operating system's light or dark setting." },
  { id: "light", label: "Light", desc: "Always use the light palette." },
  { id: "dark", label: "Dark", desc: "Always use the dark palette." },
];

// Live listener for "system" mode, torn down whenever the theme changes so we never
// stack listeners across successive applyTheme calls.
let mediaCleanup: (() => void) | null = null;

/** Apply a theme to the current window's document. "system" tracks the OS setting
 *  live; "light"/"dark" pin it. Safe to call repeatedly (e.g. on settings change). */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  mediaCleanup?.();
  mediaCleanup = null;

  if (mode !== "system") {
    root.dataset.theme = mode;
    return;
  }

  // System: resolve now and follow OS changes. matchMedia is absent in some test
  // environments - fall back to dark (the historical default) there.
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  const sync = () => {
    root.dataset.theme = mq?.matches ? "light" : "dark";
  };
  sync();
  if (mq) {
    mq.addEventListener("change", sync);
    mediaCleanup = () => mq.removeEventListener("change", sync);
  }
}
