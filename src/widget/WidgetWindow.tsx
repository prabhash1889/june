import { useCallback, useEffect, useState } from "react";
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
//
// improvement-5 P2 6.11: the expanded window is sized to the card's content
// (VoicePanel reports its scrollHeight every render) instead of a fixed 440px
// slab, so one-line content no longer floats in a mostly-empty dark rectangle.

const EXPANDED_MAX = 440; // the old fixed height stays the ceiling
const EXPANDED_MIN = 172; // room for the card header + one status line + orb
// Everything around the card, in CSS px: 12px window frame top and bottom, the
// 12px card->orb gap, and the 64px orb. Must match the CSS layout.
const CHROME = 12 + 12 + 64 + 12;
// Quantize the requested height so streamed text doesn't resize the window on
// every delta - only when it crosses a step.
const STEP = 24;

export function WidgetWindow() {
  const [active, setActive] = useState(false);
  // Start every expansion from the minimum and grow to content: the card is
  // still display:none on the first active render (this shell's class lags a
  // render), so the first measurement is 0 - growing from small looks right,
  // where opening at the previous size then snapping down would flash a slab.
  const [height, setHeight] = useState(EXPANDED_MIN);

  const onActiveChange = useCallback((a: boolean, cardPx: number) => {
    setActive(a);
    if (!a) setHeight(EXPANDED_MIN);
    else if (cardPx > 0) {
      const want = Math.min(EXPANDED_MAX, Math.max(EXPANDED_MIN, Math.ceil((cardPx + CHROME) / STEP) * STEP));
      setHeight(want);
    }
  }, []);

  useEffect(() => {
    // Non-Tauri context (plain `vite dev` in a browser): no window to size.
    invoke("set_widget_expanded", { expanded: active, height: active ? height : null }).catch(() => {});
  }, [active, height]);

  return (
    <div className={`widget ${active ? "widget--active" : ""}`} data-tauri-drag-region>
      <VoicePanel onActiveChange={onActiveChange} />
    </div>
  );
}
