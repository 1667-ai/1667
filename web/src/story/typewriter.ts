/** Room kept above a part that is taller than the view: it shows from its top. */
const TALL_PART_MARGIN_PX = 24;

/**
 * Typewriter mode (`z`): scrolls the manuscript so the focused part sits in
 * the middle of the view, as the TUI keeps the focused row centered. A part
 * taller than the view shows from its top instead, so the reader never lands
 * in the middle of a long one. `.story-scroll-typewriter` adds the padding
 * that lets the first and last part reach the middle.
 */
export function centerPart(container: HTMLElement, partId: string): void {
  const part = container.querySelector<HTMLElement>(`[data-part-id="${CSS.escape(partId)}"]`);
  if (part === null) return;
  const box = container.getBoundingClientRect();
  const rect = part.getBoundingClientRect();
  const offset = rect.top - box.top + container.scrollTop;
  const top = rect.height + 2 * TALL_PART_MARGIN_PX >= container.clientHeight
    ? offset - TALL_PART_MARGIN_PX
    : offset + rect.height / 2 - container.clientHeight / 2;
  container.scrollTo({ top: Math.max(0, top) });
}
