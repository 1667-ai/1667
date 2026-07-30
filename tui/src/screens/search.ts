import { SEARCH_MAX_QUERY } from "../../../shared/story-search.js";
import type { HitRow, HitRows } from "../hit.js";
import {
  boundedSearchCursor,
  searchRows,
  selectedSearchRow,
  type SearchRow,
  type SearchRowModel,
  type SearchState
} from "../search-model.js";
import type { StoryScreenState } from "../state.js";
import {
  fitLine,
  lineWidth,
  segment,
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";
import { addFooterHits, joinHintTokens, type HintToken } from "./hint-footer.js";
import { addInlineHits } from "./story/hits.js";
import {
  DIVIDER_COLUMN,
  PREVIEW_COLUMN,
  PREVIEW_MIN_WIDTH,
  renderGroupRow,
  renderHitRow
} from "./search-row.js";
import { joinPanes, renderPreview } from "./search-preview.js";

const SHELL_ROWS = 2;

export function renderSearchScreen(
  state: StoryScreenState,
  search: SearchState,
  width: number,
  height: number,
  hitRows: HitRows
): FrameComposition {
  const model = searchRows(search, state.payload);
  const bodyHeight = Math.max(1, height - SHELL_ROWS);
  const preview = width >= PREVIEW_MIN_WIDTH;
  const listWidth = preview ? DIVIDER_COLUMN : width;
  const window = rowWindow(model, search.cursor, bodyHeight);
  const selectedRow = selectedSearchRow(model, search.cursor);
  const body: FrameLine[] = [];
  const bodyHits: Array<HitRow | null> = [];
  for (let offset = 0; offset < bodyHeight; offset += 1) {
    const index = window.start + offset;
    const row = index < model.rows.length ? model.rows[index]! : { kind: "blank" as const };
    const isFocused = selectedRow !== null && row.kind !== "blank" && row.select === selectedRow.select;
    body.push(renderRow(row, isFocused, listWidth));
    bodyHits.push(rowHit(row, listWidth));
  }
  const notice = paneNotice(state, search, model);
  if (notice !== null) body[0] = fitLine([segment(`  ${notice}`, "chrome")], listWidth);
  const previewLines = preview
    ? renderPreview(state, search, model, width - PREVIEW_COLUMN)
    : [];
  const lines = [
    renderTitle(state, search, model, width),
    ...body.map((line, offset) => preview
      ? joinPanes(line, previewLines[offset] ?? [], width)
      : fitLine(line, width)),
    renderFooter(search, width)
  ].slice(0, height).map((line) => fitLine(line, width));

  hitRows.length = height;
  hitRows.fill(null);
  for (let offset = 0; offset < Math.min(bodyHeight, lines.length - 1); offset += 1) {
    hitRows[offset + 1] = bodyHits[offset] ?? null;
  }
  const footerTokens = searchHintTokens(search, width);
  addFooterHits(hitRows, lines, height, footerTokens, searchHint(search, width));
  // The title paints the scope toggle and the case lamp as controls, so they
  // have to answer a click. Full-bleed screens harvest nothing by default.
  const titleRow = lines[0];
  if (titleRow !== undefined) addInlineHits([titleRow], hitRows);
  return { lines, selectable: null };
}

/** Keep the cursor inside the painted window without moving it any further
 *  than it has to: the list scrolls, the selection does not jump. */
function rowWindow(
  model: SearchRowModel,
  cursor: number,
  bodyHeight: number
): { start: number } {
  const targetSelect = boundedSearchCursor(cursor, model.selectableCount);
  const cursorRowIndex = model.rows.findIndex((r) => r.kind !== "blank" && r.select === targetSelect);
  if (cursorRowIndex === -1 || model.rows.length <= bodyHeight) return { start: 0 };
  const last = Math.max(0, model.rows.length - bodyHeight);
  // Show the group header above the focused hit whenever one row of lead fits.
  const lead = Math.min(1, cursorRowIndex);
  return { start: Math.max(0, Math.min(last, cursorRowIndex - Math.floor(bodyHeight / 2) + lead)) };
}

function renderRow(row: SearchRow, focused: boolean, listWidth: number): FrameLine {
  if (row.kind === "blank") return [];
  return row.kind === "group"
    ? renderGroupRow(row, focused, listWidth)
    : renderHitRow(row, focused, listWidth);
}

function rowHit(row: SearchRow, listWidth: number): HitRow | null {
  return row.kind === "blank"
    ? null
    : { target: { kind: "list", index: row.select }, left: 0, right: listWidth };
}

/** What the pane says when it is not showing hits. */
function paneNotice(
  state: StoryScreenState,
  search: SearchState,
  model: SearchRowModel
): string | null {
  if (search.error !== null) return `search failed · ${search.error}`;
  if (search.query.trim().length === 0) {
    return search.scope === "tree"
      ? `type to search every take in ${state.payload.title}`
      : "type to search every story in the vault";
  }
  if (search.query.trim().length > SEARCH_MAX_QUERY) {
    return `that query is longer than ${SEARCH_MAX_QUERY} characters · search a phrase from it`;
  }
  if (search.response === null) return search.searching ? "searching…" : "keep typing…";
  if (model.selectableCount === 0) return `no match for ${search.query.trim()}`;
  return null;
}

/** The header states the count and the scope, and nothing else — the redundant
 *  stat rows of the first pass folded into this rule. */
function searchTally(search: SearchState, model: SearchRowModel): string {
  if (search.query.trim().length === 0) return "no query yet";
  if (search.error !== null) return "search failed";
  if (search.query.trim().length > SEARCH_MAX_QUERY) return "query too long";
  if (search.response === null) return search.searching ? "searching…" : "keep typing";
  // Folding hides rows, never findings: the tally counts what the query found.
  const hits = search.response.hits.length;
  // Facts hang off no line, so they are not counted as one.
  const groups = search.scope === "tree" ? model.lineGroupCount : model.groupCount;
  const noun = search.scope === "tree"
    ? groups === 1 ? "line" : "lines"
    : groups === 1 ? "story" : "stories";
  const capped = search.response.capped ? "+" : "";
  return `${hits}${capped} ${hits === 1 ? "hit" : "hits"} in ${groups} ${noun}`;
}

/** The copy the grids print, verbatim — `↑↓ hit`, `⏎ reroute + jump`,
 *  `⏎ switch story + open`. Only the two keys the design could not keep differ:
 *  the query owns every plain letter, so `c case` is `⌃s case` and `␣ fold
 *  story` is `←→ fold`. */
function searchHintTokens(search: SearchState, width: number): HintToken[] {
  const narrow = width < PREVIEW_MIN_WIDTH;
  const rows: HintToken = { text: "↑↓ hit", pair: ["focus-previous", "focus-next"] };
  const fold: HintToken = { text: "←→ fold", pair: ["take-previous", "take-next"] };
  const scope: HintToken = {
    text: search.scope === "tree" ? "⇥ vault" : "⇥ tree",
    action: "cycle"
  };
  const open: HintToken = {
    text: narrow ? "⏎ open"
      : search.scope === "tree" ? "⏎ reroute + jump" : "⏎ switch story + open",
    action: "apply"
  };
  const casing: HintToken = { text: "⌃s case", action: "toggle-search-case" };
  const back: HintToken = { text: "esc back", action: "cancel" };
  return [rows, fold, scope, open, casing, back];
}

function searchHint(search: SearchState, width: number): string {
  return joinHintTokens(searchHintTokens(search, width), " ━ ");
}

function renderFooter(search: SearchState, width: number): FrameLine {
  const line: FrameLine = [segment("━━ ", "brass dim")];
  for (const [index, token] of searchHintTokens(search, width).entries()) {
    if (index > 0) line.push(segment(" ━ ", "brass dim"));
    line.push(segment(token.text, token.action === "apply" ? "focus / accent" : "prose"));
  }
  const remaining = width - lineWidth(line);
  if (remaining > 0) line.push(segment(` ${"━".repeat(Math.max(0, remaining - 1))}`, "brass dim"));
  return fitLine(line, width);
}

/** The title rule states the query, the count and the scope. At 80 columns the
 *  scope toggle and the case lamp fold away — the footer still names both keys,
 *  and an armed case switch keeps its lamp because it changes what you see. */
function renderTitle(
  state: StoryScreenState,
  search: SearchState,
  model: SearchRowModel,
  width: number
): FrameLine {
  const narrow = width < PREVIEW_MIN_WIDTH;
  const scope = search.scope === "tree" ? narrow ? "tree" : "whole tree" : "vault";
  const other = search.scope === "tree" ? "vault" : "tree";
  const query = truncate(search.query, Math.max(8, Math.floor(width / 3)));
  const line: FrameLine = [
    segment("━━ ", "brass dim"),
    segment("search", "focus / accent"),
    segment(" ━ ", "brass dim"),
    segment("⌕ ", "accent · deep"),
    segment(query, "streaming"),
    segment("▏", "focus / accent"),
    segment(" ━ ", "brass dim")
  ];
  // An armed case switch changes what every row means, so its lamp is reserved
  // even where the toggle hint itself has folded away. The query and the tally
  // yield their cells to it, never the other way round.
  const trailing = narrow
    ? search.caseSensitive ? visibleWidth(" ━ case ●") : 0
    : visibleWidth(` ━ ⇥ ${other} ━ case ○`);
  const room = Math.max(0, width - lineWidth(line) - trailing - visibleWidth(` ━ scope ${scope} `));
  line.push(
    segment(truncate(searchTally(search, model), room), "chrome"),
    segment(" ━ scope ", "brass dim"),
    segment(scope, "prose")
  );
  if (!narrow) {
    line.push(
      segment(" ━ ", "brass dim"),
      segment("⇥", "prose", { kind: "action", action: "cycle" }),
      segment(` ${other} ━ case `, "brass dim")
    );
  }
  if (!narrow || search.caseSensitive) {
    if (narrow) line.push(segment(" ━ case ", "brass dim"));
    line.push(segment(search.caseSensitive ? "●" : "○",
      search.caseSensitive ? "focus / accent" : "brass dim",
      { kind: "action", action: "toggle-search-case" }));
  }
  const remaining = width - lineWidth(line);
  if (remaining > 0) line.push(segment(` ${"━".repeat(Math.max(0, remaining - 1))}`, "brass dim"));
  return fitLine(line, width);
}
