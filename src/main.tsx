import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { WidgetWindow } from "./widget/WidgetWindow.tsx";
import { AppWindow } from "./app/AppWindow.tsx";
import { ErrorBoundary } from "./app/ErrorBoundary.tsx";
import { installGlobalErrorHooks } from "./lib/errorlog.ts";
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

const Face = currentLabel() === "app" ? AppWindow : WidgetWindow;

// Catch async / event-handler / promise throws the ErrorBoundary can't (2.2).
installGlobalErrorHooks();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Face />
    </ErrorBoundary>
  </React.StrictMode>,
);
