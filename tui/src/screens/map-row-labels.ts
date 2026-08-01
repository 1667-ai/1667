import { shortDate, type AtlasRow } from "../atlas-layout.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";

export { tagGlyph, tagRole };

/** A word count with no unit, for views that already head a column of them —
 * doc 20c's tree gutter and doc 26a's metadata column. */
export function formatMapWordsBare(words: number): string {
  if (words < 1_000) return words.toLocaleString("en-US");
  // Decision 21 pins this column at six cells, so the scale steps up rather
  // than letting the number outgrow the grid it is compared in. The step is
  // decided on the *rounded* figure: 999,999 rounds to `1000.0k`, which is
  // seven cells, and is `1.0M`.
  const thousands = (words / 1_000).toFixed(1);
  if (Number(thousands) < 1_000) return `${thousands}k`;
  return `${(words / 1_000_000).toFixed(1)}M`;
}

/** The same count carrying its unit, for the places a number stands alone. The
 * `k` form already reads as words, so only the small counts take the suffix. */
export function formatMapWords(words: number): string {
  return words < 1_000 ? `${formatMapWordsBare(words)} w` : formatMapWordsBare(words);
}

/** What a line is called. Doc 26a moves the tag glyph out to the state
 * column, so the name column holds nothing but the name. */
export function mapLineName(row: AtlasRow): string {
  return row.tag === null
    ? `unnamed · ${shortDate(row.node.lastTouched)}`
    : row.tag.name;
}

/** The name with its tag glyph, for views with no column to move it to. */
export function mapLineLabel(row: AtlasRow): string {
  return row.tag === null
    ? mapLineName(row)
    : `${tagGlyph(row.tag.status)} ${mapLineName(row)}`;
}
