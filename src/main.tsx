import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { WidgetWindow } from "./widget/WidgetWindow.tsx";
import { AppWindow } from "./app/AppWindow.tsx";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Face />
  </React.StrictMode>,
);
