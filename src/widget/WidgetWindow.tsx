import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { VoicePanel } from "../voice/VoicePanel.tsx";

// The always-on floating widget (PLAN.md Phase 6, per the user's spec):
// frameless, transparent, always-on-top. At rest it's a bare orb; while June is
// doing anything it expands into a card above the orb, then collapses back. The
// orb sits at the bottom-right in both faces and the window resize is anchored
// to the bottom-right corner, so the orb never visibly moves when the card
// opens. Free-drag anywhere (the frame and card header are drag handles);
// position is remembered by the window-state plugin. The pipeline lives in
// VoicePanel - the shell only toggles the window face.
export function WidgetWindow() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Non-Tauri context (plain `vite dev` in a browser): no window to size.
    invoke("set_widget_expanded", { expanded: active }).catch(() => {});
  }, [active]);

  return (
    <div className={`widget ${active ? "widget--active" : ""}`} data-tauri-drag-region>
      <VoicePanel onActiveChange={setActive} />
    </div>
  );
}
