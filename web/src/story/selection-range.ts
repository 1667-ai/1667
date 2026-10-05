/**
 * The text the writer selected in one part's prose, as UTF-16 offsets into the
 * part's text. The prose is drawn as paragraphs, and each paragraph element
 * carries its own start offset (`data-offset`, set by `Prose.tsx`); the
 * separators between paragraphs are not in the page. A selection is read in
 * its paragraph, and the offset is the paragraph's offset plus the characters
 * before the selection inside it, however many marks the paragraph holds.
 */

export interface PartSelection {
  readonly start: number;
  readonly end: number;
  /** What the selection holds in the part's own text. */
  readonly text: string;
}

function paragraphOf(node: Node, root: Element): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const found = element?.closest<HTMLElement>("[data-offset]") ?? null;
  return found !== null && root.contains(found) ? found : null;
}

/** The offset of a boundary point in the part's text, or `null` when it is not
 * inside one of the part's paragraphs. A point between paragraphs (on the
 * prose element itself) counts as the start of the next one. */
function offsetOf(container: Node, offset: number, root: Element): number | null {
  const paragraph = paragraphOf(container, root);
  if (paragraph === null) return null;
  const before = document.createRange();
  before.selectNodeContents(paragraph);
  before.setEnd(container, offset);
  return Number(paragraph.dataset.offset) + before.toString().length;
}

/** The selection inside `article` (a part's element), when both ends are in
 * its prose. `text` is the part's text, to read the selected text back from
 * it. Null for a collapsed selection, one that leaves the prose, or one that
 * reaches into another part. */
export function selectionInPart(article: Element, text: string, selection: Selection | null = window.getSelection()): PartSelection | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const prose = article.querySelector(".prose");
  if (prose === null) return null;
  const range = selection.getRangeAt(0);
  if (!prose.contains(range.startContainer) || !prose.contains(range.endContainer)) return null;
  const start = offsetOf(range.startContainer, range.startOffset, prose);
  const end = offsetOf(range.endContainer, range.endOffset, prose);
  if (start === null || end === null || end <= start) return null;
  // A triple click reaches into the next paragraph: the spaces and line breaks
  // at either edge are not part of what the writer chose.
  const raw = text.slice(start, end);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const from = start + (raw.length - raw.trimStart().length);
  return { start: from, end: from + trimmed.length, text: trimmed };
}
