import { takeStripCells, type TakeDensity } from "../../../../shared/take-strip.js";

export type { TakeDensity };

export interface TakeStrip {
  density: TakeDensity;
  /** One glyph per take at `spaced`/`condensed`; empty at `gauge`, where the
   *  strip is a rule rather than a row of takes. */
  cells: readonly string[];
  text: string;
  currentOffset: number;
  counter: string;
}

const GAUGE_WIDTH = 13;

/** Decision 18 on the page: a take that branches into subtakes of its own wears
 *  the ring `◎`, a childless one stays `○`. The take you are reading is never
 *  ringed — its subtakes are the parts below it already, so the ring would only
 *  repeat what the page already shows — and renders `●` whether or not it
 *  branches. The glyph/gauge computation itself is shared with the web
 *  manuscript's own take strip (`shared/take-strip.ts`); this only turns it
 *  into the TUI's text rendering. */
export function takeStrip(index: number, count: number, subtakes: readonly boolean[] = []): TakeStrip {
  const cells = takeStripCells(index, count, subtakes);
  const counter = `‹ take ${index}/${count} ›`;
  if (cells.density !== "gauge") {
    const glyphs = cells.glyphs;
    return {
      density: cells.density,
      cells: glyphs,
      text: cells.density === "spaced" ? glyphs.join(" ") : glyphs.join(""),
      currentOffset: cells.density === "spaced" ? (index - 1) * 2 : index - 1,
      counter
    };
  }
  const currentOffset = Math.floor((cells.gaugeFraction ?? 0) * GAUGE_WIDTH);
  return {
    density: "gauge",
    cells: [],
    text: `${"─".repeat(currentOffset)}●${"─".repeat(GAUGE_WIDTH - currentOffset)}`,
    currentOffset,
    counter
  };
}
