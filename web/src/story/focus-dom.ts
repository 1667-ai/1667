import { fieldHasFocus } from "../app/keymap-dom.js";

/**
 * Imperative DOM focus for the manuscript (#409 step 4). `StoryView.tsx`
 * calls `focusPartElement` from an effect whenever the effective focused
 * part id changes; it is the one place that touches `HTMLElement.focus()`
 * directly, so the rule "never steal focus from search" lives in one spot.
 */

/** False only while the keyboard belongs to something the reader is using:
 * a field (the search box or an editor's text), a dialog, or a popover that
 * owns its keys.
 * Focus on a plain button elsewhere (the sidebar row that opened this story,
 * the Continue button) does not block it, or ↑/↓ would move the highlight
 * without ever bringing the part into view. */
export function canMoveFocusInto(container: HTMLElement): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  // A field, or a region that owns its keys (the inline editor), keeps focus
  // even inside the manuscript: clicking into an open editor's text must not
  // be answered by moving focus back to its part.
  return !fieldHasFocus();
}

/** Brings the part into view in the manuscript's own scroll container
 * (honoring `.part`'s `scroll-margin-block`), always, and moves keyboard
 * focus onto it when `canMoveFocusInto` allows. */
export function focusPartElement(container: HTMLElement, partId: string): void {
  const target = container.querySelector<HTMLElement>(
    `[data-part-id="${CSS.escape(partId)}"]`
  );
  if (target === null) return;
  if (canMoveFocusInto(container)) target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest" });
}

/** A click should only move reading focus when it was a plain click, not the
 * end of a text selection drag — checked on `mouseup` (after the browser has
 * settled the selection), never `mousedown` or `click`. */
export function isClickSelectionCollapsed(): boolean {
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}

/** Puts keyboard focus back on the part that holds reading focus — where the
 * composer or an editor hands the keyboard back. Does nothing when no part
 * carries it. */
export function focusCurrentPart(): void {
  document.querySelector<HTMLElement>('.story-scroll [data-part-id][aria-current="true"]')
    ?.focus({ preventScroll: true });
}
