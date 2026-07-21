import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ErrorBoundary } from "./app/ErrorBoundary.tsx";
import { installGlobalErrorHooks } from "./lib/errorlog.ts";
import { loadSettings } from "./lib/settings.ts";
import { applyTheme } from "./lib/theme.ts";
import "./styles.css";

// One bundle, two faces (PLAN.md Phase 6): the `app` window is the full
// application; every other window (the default `main`) is the floating widget.
function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main"; // non-Tauri context (plain vite dev): default to the widget
  }
}

// 7.3: lazy-load only the face this window shows so the 88x88 widget never parses
// AppWindow's SettingsPanel/MissionBoard/RunsPanel code (a large slice of the entry
// chunk it never renders). React.lazy + a per-label dynamic import splits each face
// into its own chunk; only the needed one is fetched.
const Face =
  currentLabel() === "app"
    ? React.lazy(() => import("./app/AppWindow.tsx").then((m) => ({ default: m.AppWindow })))
    : React.lazy(() => import("./widget/WidgetWindow.tsx").then((m) => ({ default: m.WidgetWindow })));

// Catch async / event-handler / promise throws the ErrorBoundary can't (2.2).
installGlobalErrorHooks();

// Apply the saved colour theme as early as possible (3.4), in both windows. Async
// (settings come from the Rust side); a "system" user sees at worst a brief dark
// frame before this resolves, which the CSS default already matches.
void loadSettings()
  .then((s) => applyTheme(s.theme))
  .catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>
        <Face />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
