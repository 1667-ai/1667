/**
 * The pure glyph/gauge computation behind the take strip both the TUI
 * (`tui/src/screens/story/density.ts`) and the web manuscript
 * (`web/src/story/TakeStrip.tsx`) show for a part with more than one take —
 * max reuse: only how each host turns this into text (the TUI) or DOM
 * elements (the web) differs.
 */

export type TakeDensity = "spaced" | "condensed" | "gauge";

export interface TakeStripCells {
  readonly density: TakeDensity;
  /** One glyph per take at `spaced`/`condensed`; empty at `gauge`, where the
   *  strip is a position indicator rather than a row of takes. */
  readonly glyphs: readonly ("●" | "◎" | "○")[];
  /** The line position `gauge` density shows in place of individual takes —
   *  `0` the first take, `1` the last — `undefined` at `spaced`/`condensed`,
   *  where `glyphs` already says exactly which take is current. */
  readonly gaugeFraction: number | undefined;
}

const SPACED_MAX = 6;
const CONDENSED_MAX = 12;

/** Decision 18: a take that branches into subtakes of its own wears the ring
 * `◎`, a childless one stays `○`. The take you are reading is never ringed —
 * its subtakes are the parts below it already, so the ring would only
 * repeat what the page already shows — and renders `●` whether or not it
 * branches. */
export function takeStripCells(
  index: number,
  count: number,
  subtakes: readonly boolean[] = []
): TakeStripCells {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error("Take index must be within the sibling count.");
  }
  if (count > CONDENSED_MAX) {
    return { density: "gauge", glyphs: [], gaugeFraction: (index - 1) / (count - 1) };
  }
  const glyphs = Array.from({ length: count }, (_, offset): "●" | "◎" | "○" =>
    offset === index - 1 ? "●" : subtakes[offset] === true ? "◎" : "○");
  return { density: count <= SPACED_MAX ? "spaced" : "condensed", glyphs, gaugeFraction: undefined };
}
