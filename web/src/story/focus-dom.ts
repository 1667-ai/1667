/**
 * Imperative DOM focus for the manuscript (#409 step 4). `StoryView.tsx`
 * calls `focusPartElement` from an effect whenever the effective focused
 * part id changes; it is the one place that touches `HTMLElement.focus()`
 * directly, so the rule "never steal focus from search" lives in one spot.
 */

/** True unless the keyboard is already somewhere that must keep it: the
 * search box, a dialog, or anywhere else outside `container` and not the
 * body itself. Moving focus into the manuscript from any of those would
 * steal a keystroke the owner is mid-typing elsewhere. */
export function canMoveFocusInto(container: HTMLElement): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || container.contains(active);
}

/** Focuses the part's own roving-tabIndex element and brings it into view
 * without scrolling the whole page (`preventScroll`) — `scrollIntoView`
 * handles bringing it into the manuscript's own scroll container, honoring
 * `.part`'s `scroll-margin-block` (`styles/manuscript.css`) so a sticky
 * header/instruction never covers it. */
export function focusPartElement(container: HTMLElement, partId: string): void {
  if (!canMoveFocusInto(container)) return;
  const target = container.querySelector<HTMLElement>(
    `[data-part-id="${CSS.escape(partId)}"]`
  );
  if (target === null) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest" });
}

/** A click should only move reading focus when it was a plain click, not the
 * end of a text selection drag — checked on `mouseup` (after the browser has
 * settled the selection), never `mousedown` or `click`. */
export function isClickSelectionCollapsed(): boolean {
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}
