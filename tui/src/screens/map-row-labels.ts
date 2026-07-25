import { shortDate, type AtlasRow } from "../atlas-layout.js";
import { bookmarkGlyph, bookmarkRole } from "../bookmark-presentation.js";

export { bookmarkGlyph, bookmarkRole };

export function formatMapWords(words: number): string {
  return words < 1_000 ? `${words.toLocaleString("en-US")} w` : `${(words / 1_000).toFixed(1)}k`;
}

export function mapLineLabel(row: AtlasRow): string {
  return row.bookmark === null
    ? `unnamed · ${shortDate(row.node.lastTouched)}`
    : `${bookmarkGlyph(row.bookmark.label)} ${row.bookmark.name}`;
}
