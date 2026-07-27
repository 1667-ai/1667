export type TakeDensity = "spaced" | "condensed" | "gauge";

export interface TakeStrip {
  density: TakeDensity;
  /** One glyph per take at `spaced`/`condensed`; empty at `gauge`, where the
   *  strip is a rule rather than a row of takes. */
  cells: readonly string[];
  text: string;
  currentOffset: number;
  counter: string;
}

/** Decision 18 on the page: a take that branches into subtakes of its own wears
 *  the ring `◎`, a childless one stays `○`. The take you are reading is never
 *  ringed — its subtakes are the parts below it, so the ring would only repeat
 *  what the page already shows — and renders `●` whether or not it branches. */
export function takeStrip(index: number, count: number, subtakes: readonly boolean[] = []): TakeStrip {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error("Take index must be within the sibling count.");
  }
  const counter = `‹ take ${index}/${count} ›`;
  const glyph = (offset: number): string =>
    offset === index - 1 ? "●" : subtakes[offset] === true ? "◎" : "○";
  if (count <= 6) {
    const cells = Array.from({ length: count }, (_, offset) => glyph(offset));
    return { density: "spaced", cells, text: cells.join(" "), currentOffset: (index - 1) * 2, counter };
  }
  if (count <= 12) {
    const cells = Array.from({ length: count }, (_, offset) => glyph(offset));
    return { density: "condensed", cells, text: cells.join(""), currentOffset: index - 1, counter };
  }
  const currentOffset = Math.floor(((index - 1) / (count - 1)) * 13);
  return {
    density: "gauge",
    cells: [],
    text: `${"─".repeat(currentOffset)}●${"─".repeat(13 - currentOffset)}`,
    currentOffset,
    counter
  };
}
