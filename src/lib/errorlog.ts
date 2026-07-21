import { invoke } from "@tauri-apps/api/core";

// Renderer -> file-log bridge (improvement-6 2.2). A render throw, a rejected
// promise, or an error in an event handler would otherwise blank the always-on-top
// widget with no trace ("June died"). These forward into the Rust file log
// (june.log, 2.1) so a failure on a user machine leaves something to diagnose.

/** Forward one message to the file log. Best-effort: no backend (plain browser /
 *  tests) or a logging failure must never cascade into a second error. */
export function reportError(message: string): void {
  try {
    void invoke("log_message", { message }).catch(() => {});
  } catch {
    // invoke can throw synchronously outside a Tauri context - swallow.
  }
}

let installed = false;

/** Install window-level `error` + `unhandledrejection` hooks that forward into the
 *  file log, catching throws an ErrorBoundary can't (async work, event handlers,
 *  rejected promises). Idempotent, and a no-op outside a browser (tests). */
export function installGlobalErrorHooks(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    reportError(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    reportError(`unhandledrejection: ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`);
  });
}
