import { SEARCH_MAX_QUERY, SEARCH_MIN_QUERY } from "../../../shared/story-search.js";
import type { HitRow, HitRows } from "../hit.js";
import {
  boundedSearchCursor,
  searchInFlight,
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
import { addInlineHits } from "./story/hits.js";
import {
  DIVIDER_COLUMN,
  hitReference,
  PREVIEW_COLUMN,
  PREVIEW_MIN_WIDTH,
  renderGroupRow,
  renderHitRow
} from "./search-row.js";
import { joinPanes, renderPreview } from "./search-preview.js";
import { renderSurfaceBreadcrumb } from "./surface-breadcrumb.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";

const SHELL_ROWS = 2;

export type SearchStatus =
  | { kind: "idle" }
  | { kind: "too-short" }
  | { kind: "too-long" }
  | { kind: "running" }
  /** The results were dropped because the story they described was replaced,
   *  and no request is out. The next keystroke asks again. */
  | { kind: "retired" }
  | { kind: "failed"; message: string }
  | { kind: "empty" }
  | { kind: "results"; hits: number; groups: number; capped: boolean };

export function deriveSearchStatus(search: SearchState, model: SearchRowModel): SearchStatus {
  const query = search.query.trim();
  if (query.length === 0) return { kind: "idle" };
  if (search.error !== null) return { kind: "failed", message: search.error };
  if (query.length < SEARCH_MIN_QUERY) return { kind: "too-short" };
  if (query.length > SEARCH_MAX_QUERY) return { kind: "too-long" };
  if (searchInFlight(search)) return { kind: "running" };
  if (search.response === null) return { kind: "retired" };
  const hits = search.response.hits.length;
  if (hits === 0) return { kind: "empty" };
  const groups = search.scope === "tree" ? model.lineGroupCount : model.groupCount;
  return { kind: "results", hits, groups, capped: search.response.capped };
}

export function renderSearchScreen(
  state: StoryScreenState,
  search: SearchState,
  width: number,
  height: number,
  hitRows: HitRows
): FrameComposition {
  const model = searchRows(search, state.payload);
  const status = deriveSearchStatus(search, model);
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
  const notice = paneNotice(state, search, status);
  if (notice !== null) body[0] = fitLine([segment(`  ${notice}`, "chrome")], listWidth);
  const previewLines = preview
    ? renderPreview(state, search, model, width - PREVIEW_COLUMN)
    : [];
  const lines = [
    renderTitle(state, search, status, width),
    ...body.map((line, offset) => preview
      ? joinPanes(line, previewLines[offset] ?? [], width)
      : fitLine(line, width)),
    renderFooter(state, search, model, width)
  ].slice(0, height).map((line) => fitLine(line, width));

  hitRows.length = height;
  hitRows.fill(null);
  for (let offset = 0; offset < Math.min(bodyHeight, lines.length - 1); offset += 1) {
    hitRows[offset + 1] = bodyHits[offset] ?? null;
  }
  // Title and footer carry action metadata directly on their segments.
  const titleRow = lines[0];
  if (titleRow !== undefined) addInlineHits([titleRow], hitRows);
  const footerRow = lines[lines.length - 1];
  if (footerRow !== undefined) addInlineHits([footerRow], hitRows, () => true, lines.length - 1);

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
  status: SearchStatus
): string | null {
  switch (status.kind) {
    case "idle":
      return search.scope === "tree"
        ? `type to search every take in ${state.payload.title}`
        : "type to search every story in the vault";
    case "too-short":
    case "retired":
      return "keep typing…";
    case "running":
      return "searching…";
    case "too-long":
      return `that query is longer than ${SEARCH_MAX_QUERY} characters · search a phrase from it`;
    case "failed":
      return `search failed · ${status.message}`;
    case "empty":
      return `no match for ${search.query.trim()}`;
    case "results":
      return null;
  }
}

/** The header states the count and the scope, and nothing else — the redundant
 *  stat rows of the first pass folded into this rule. */
function searchTally(search: SearchState, status: SearchStatus): string {
  switch (status.kind) {
    case "idle":
      return "no query yet";
    case "too-short":
    case "retired":
      return "keep typing";
    case "too-long":
      return "query too long";
    case "failed":
      return "search failed";
    case "running":
      return "searching…";
    case "empty": {
      const noun = search.scope === "tree" ? "lines" : "stories";
      return `0 hits in 0 ${noun}`;
    }
    case "results": {
      const noun = search.scope === "tree"
        ? status.groups === 1 ? "line" : "lines"
        : status.groups === 1 ? "story" : "stories";
      const capped = status.capped ? "+" : "";
      return `${status.hits}${capped} ${status.hits === 1 ? "hit" : "hits"} in ${status.groups} ${noun}`;
    }
  }
}

/** Spec §4: search takes the same full-bleed shell as the map — title rule and
 *  footer breadcrumb. The last row used to be a bare keyline, which dropped
 *  both the ` SEARCH ` mode cell and the C-02 tether back to the story. */
function renderFooter(
  state: StoryScreenState,
  search: SearchState,
  model: SearchRowModel,
  width: number
): FrameLine {
  const narrow = width < PREVIEW_MIN_WIDTH;
  const tag = state.payload.tags.find(
    (item) => item.nodeId === (state.payload.path.at(-1)?.id ?? null)
  ) ?? null;
  return renderSurfaceBreadcrumb({
    mode: "SEARCH",
    scope: search.scope === "tree" ? narrow ? "tree" : "whole tree" : "vault",
    title: state.payload.title,
    identity: tag === null ? "" : `${tagGlyph(tag.status)} ${tag.name}`,
    identityRole: tagRole(tag),
    crumb: searchCrumb(model, search.cursor),
    keys: searchKeys(search, narrow),
    width
  });
}

/** Where the cursor is among the hits, in the breadcrumb's `¶` slot. */
function searchCrumb(model: SearchRowModel, cursor: number): string {
  if (model.selectableCount === 0) return "no hits";
  const row = selectedSearchRow(model, cursor);
  const position = `hit ${boundedSearchCursor(cursor, model.selectableCount) + 1}/${model.selectableCount}`;
  return row === null || row.kind === "group"
    ? position
    : `${hitReference(row)} · ${position}`;
}

function searchKeys(search: SearchState, narrow: boolean): FrameLine {
  const line: FrameLine = [];
  const push = (segments: FrameLine) => {
    if (line.length > 0) line.push(segment(" · ", "chrome"));
    line.push(...segments);
  };
  push([
    segment("↑", "chrome", { kind: "action", action: "focus-previous" }),
    segment("↓", "chrome", { kind: "action", action: "focus-next" }),
    segment(" hit", "chrome")
  ]);
  push([
    segment("←", "chrome", { kind: "action", action: "take-previous" }),
    segment("→", "chrome", { kind: "action", action: "take-next" }),
    segment(" fold", "chrome")
  ]);
  push([segment(search.scope === "tree" ? "⇥ vault" : "⇥ tree", "chrome",
    { kind: "action", action: "cycle" })]);
  push([segment(narrow ? "↵ open"
    : search.scope === "tree" ? "↵ reroute + jump" : "↵ switch story + open",
  "focus / accent", { kind: "action", action: "apply" })]);
  push([segment("⌃s case", "chrome", { kind: "action", action: "toggle-search-case" })]);
  push([segment("esc back", "chrome", { kind: "action", action: "cancel" })]);
  return line;
}

/** The title rule states the query, the count and the scope. At 80 columns the
 *  scope toggle and the case lamp fold away — the footer still names both keys,
 *  and an armed case switch keeps its lamp because it changes what you see. */
function renderTitle(
  state: StoryScreenState,
  search: SearchState,
  status: SearchStatus,
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
    segment(truncate(searchTally(search, status), room), "chrome"),
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
