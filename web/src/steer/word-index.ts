/**
 * The number of words before a point: the knob goes to after the last word
 * that starts above the point's line, or on that line and left of the point.
 * Words past the knob are hidden but keep their place, so their boxes are
 * where the words will show.
 */
export function wordCountAt(container: HTMLElement, x: number, y: number): number {
  let count = 0;
  for (const word of container.querySelectorAll<HTMLElement>("[data-word]")) {
    const box = word.getBoundingClientRect();
    const before = box.bottom <= y || (box.top <= y && box.left + box.width / 2 <= x);
    if (!before) break;
    count += 1;
  }
  return count;
}
