/**
 * Keep notes-focused Side Note selection aligned with history scroll.
 */

/**
 * Choose the note cursor after a history scroll while notes own focus.
 * `noteContentEnds[i]` is the exclusive end of note i's content rows
 * (separator blanks are excluded from visibility).
 */
export function noteCursorAfterHistoryScroll(
  noteCount: number,
  noteStarts: readonly number[],
  noteContentEnds: readonly number[],
  bodyLength: number,
  scrollTop: number | null,
  bodyRows: number,
  currentCursor: number,
  delta: number
): number {
  if (noteCount === 0 || delta === 0 || bodyRows <= 0) return currentCursor;
  const height = Math.max(0, Math.floor(bodyRows));
  if (height === 0) return currentCursor;
  const max = Math.max(0, bodyLength - height);
  const start = scrollTop === null
    ? max
    : Math.max(0, Math.min(max, scrollTop));
  const end = start + height;

  const rangeOf = (index: number): { start: number; end: number } => {
    const noteStart = noteStarts[index] ?? 0;
    const contentEnd = noteContentEnds[index] ?? noteStart;
    // Content only: trailing separator blanks are not note visibility.
    return { start: noteStart, end: Math.max(noteStart, contentEnd) };
  };
  const intersects = (index: number): boolean => {
    const range = rangeOf(index);
    return range.start < end && range.end > start;
  };

  const safeCursor = Math.max(0, Math.min(noteCount - 1, currentCursor));
  if (intersects(safeCursor)) return safeCursor;

  const visible: number[] = [];
  for (let index = 0; index < noteCount; index += 1) {
    if (intersects(index)) visible.push(index);
  }
  if (visible.length > 0) {
    // Scroll down shows newer rows: first visible note.
    // Scroll up shows older rows: last visible note.
    return delta > 0 ? visible[0]! : visible[visible.length - 1]!;
  }
  if (delta > 0) {
    for (let index = 0; index < noteCount; index += 1) {
      if ((noteStarts[index] ?? 0) >= start) return index;
    }
    return noteCount - 1;
  }
  for (let index = noteCount - 1; index >= 0; index -= 1) {
    if (rangeOf(index).end <= end) return index;
  }
  return 0;
}
