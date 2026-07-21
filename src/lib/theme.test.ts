import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme } from "./theme.ts";

// 3.4: applyTheme stamps `data-theme` on the document root. "light"/"dark" pin it;
// "system" resolves the OS preference (and follows changes), so the CSS needs only
// the one `[data-theme="light"]` override block.
describe("applyTheme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
  });

  it("pins an explicit light/dark choice", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves system to the OS preference", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("light"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to dark under system when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
