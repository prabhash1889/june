// Chat-style scroll follow (improvement-5 P0.8): keep the view pinned to the
// bottom while content streams in, but never yank a user who scrolled up to read
// history back down. Instant (not smooth) on purpose - repeated smooth scrolls
// restart their animation on every streamed delta and lag the stream.

/** How close to the bottom (px) still counts as "following". Big enough that one
 *  appended reply chunk doesn't strand the reader, small enough that scrolling up
 *  a screenful clearly opts out. */
const NEAR_BOTTOM_PX = 160;

/** Scroll `el` to its bottom, but only if the user is already near it. Safe on
 *  null and on test environments without scrollTo. */
export function followBottom(el: HTMLElement | null): void {
  if (!el || typeof el.scrollTo !== "function") return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_BOTTOM_PX) return;
  el.scrollTo({ top: el.scrollHeight });
}
