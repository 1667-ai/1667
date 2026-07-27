import { shortDate, type AtlasRow } from "../atlas-layout.js";
import { bookmarkGlyph, bookmarkRole } from "../bookmark-presentation.js";

export { bookmarkGlyph, bookmarkRole };

/** A word count with no unit, for views that already head a column of them —
 * doc 20c's tree gutter and doc 26a's metadata column. */
export function formatMapWordsBare(words: number): string {
  return words < 1_000 ? words.toLocaleString("en-US") : `${(words / 1_000).toFixed(1)}k`;
}

/** The same count carrying its unit, for the places a number stands alone. The
 * `k` form already reads as words, so only the small counts take the suffix. */
export function formatMapWords(words: number): string {
  return words < 1_000 ? `${formatMapWordsBare(words)} w` : formatMapWordsBare(words);
}

/** What a line is called. Doc 26a moves the bookmark glyph out to the state
 * column, so the name column holds nothing but the name. */
export function mapLineName(row: AtlasRow): string {
  return row.bookmark === null
    ? `unnamed · ${shortDate(row.node.lastTouched)}`
    : row.bookmark.name;
}

/** The name with its bookmark glyph, for views with no column to move it to. */
export function mapLineLabel(row: AtlasRow): string {
  return row.bookmark === null
    ? mapLineName(row)
    : `${bookmarkGlyph(row.bookmark.label)} ${mapLineName(row)}`;
}
