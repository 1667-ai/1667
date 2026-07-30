import type { FrameDeadlineCollector } from "../animation-deadline.js";
import {
  createAtlasLayout,
  selectableRow,
  type AtlasLayout,
  type AtlasRow
} from "../atlas-layout.js";
import { addHit, type HitRegion, type HitRow, type HitRows } from "../hit.js";
import { createPathLayout } from "../path-layout.js";
import { addFooterHits, joinHintTokens, type HintToken } from "./hint-footer.js";
import { MAP_VIEWS, type MapState, type MapView } from "../map-state.js";
import { pruneConfirmText } from "../prune-model.js";
import type { StoryScreenState } from "../state.js";
import { projectStreamedPayload } from "../stream-projection.js";
import { createMapMassScale, renderMapMassRow, renderMapSketchFold } from "./map-mass-row.js";
import { createMapPathRow, renderMapPathRow, type MapPathRow } from "./map-path-row.js";
import { tagGlyph, tagRole, formatMapWords, formatMapWordsBare } from "./map-row-labels.js";
import { mapTreeFoldFootnote, renderMapTreeRow } from "./map-tree-row.js";
import {
  fitLine,
  plainLine,
  lineWidth,
  segment,
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

export interface MapScreenDerived {
  /** Visible selectable rows, in the exact index order used by mouse actions. */
  rowIds: string[];
  pathCursorId: string;
  treeCursorId: string | null;
}

export interface MapScreenFrame extends FrameComposition {
  derived: MapScreenDerived;
}

interface MapBody {
  lines: FrameLine[];
  hits: Array<HitRow | null>;
  stats: string;
  crumb: string;
  derived: MapScreenDerived;
}

const SHELL_ROWS = 4;

/** Full-screen spatial map. It deliberately accepts no page frame: rendering
 * a map can never preserve prose, a facts rail, a scrim, or panel chrome. */
export function renderMapScreen(
  state: StoryScreenState,
  map: MapState,
  width: number,
  height: number,
  hitRows: HitRows,
  deadlines?: FrameDeadlineCollector
): MapScreenFrame {
  const payload = projectStreamedPayload(state.payload, state.stream, { includePendingTake: true });
  const visualState = payload === state.payload ? state : { ...state, payload };
  const bodyHeight = Math.max(1, height - SHELL_ROWS);
  const body = map.view === "path"
    ? renderPathBody(visualState, map, width, bodyHeight)
    : map.view === "tree"
      ? renderTreeBody(visualState, map, width, bodyHeight, deadlines)
      : renderMassBody(visualState, map, width, bodyHeight, deadlines);
  const shown = body.lines.slice(0, bodyHeight);
  const lines = [
    renderTitle(map.view, body.stats, width),
    [],
    ...shown,
    ...Array.from({ length: Math.max(0, bodyHeight - shown.length) }, (): FrameLine => []),
    [segment("─".repeat(Math.max(0, width)), "dimmed page")],
    renderBreadcrumb(visualState, map, body.crumb, width)
  ].slice(0, height).map((line) => fitLine(line, width));

  hitRows.length = height;
  hitRows.fill(null);
  for (const hit of mapTitleHits()) addHit(hitRows, 0, hit);
  for (let row = 0; row < Math.min(shown.length, body.hits.length); row += 1) {
    hitRows[row + 2] = body.hits[row] ?? null;
  }
  addMapFooterHits(hitRows, lines, height, map, width);
  return { lines, selectable: null, derived: body.derived };
}

function renderPathBody(state: StoryScreenState, map: MapState, width: number, bodyHeight: number): MapBody {
  const layout = createPathLayout(
    state.payload, map.pathCursorId, bodyHeight, 5, map.pathShowAllTakes
  );
  const pieces = layout.rows.map((row) => createMapPathRow(row, state.stream?.targetId ?? null));
  const glyphField = Math.max(4, ...pieces.map((piece) => piece.glyphWidth)) + 2;
  const depthField = 6 + Math.max(2, ...pieces.map((piece) => String(piece.depth).length));
  const counterField = pieces.some((piece) => piece.counter.length > 0)
    ? Math.max(...pieces.map((piece) => piece.counter.length)) + 2 : 0;
  const badgeField = Math.max(0, ...pieces.map((piece) => visibleWidth(piece.badgeText)));
  const lines = pieces.map((piece) => renderMapPathRow(
    piece, depthField, glyphField, counterField, badgeField, width
  ));
  const hits: Array<HitRow | null> = pieces.map((piece, row): HitRow => ({
    target: { kind: "list", index: row }, left: 0, right: width,
    overrides: pathTakeHits(piece, row, depthField, glyphField)
  }));
  const rowIds = layout.rows.map((row) => row.pathNode.id);
  const currentDepth = layout.rows.find((row) => row.cursorHere)?.depth ?? layout.visibleStart;
  const tagCount = layout.tags.length;
  const stats = width < 100
    ? `${state.payload.title} ━ depth ${layout.visibleStart}–${layout.visibleEnd} of ${layout.totalDepth} ━ ${layout.totalParts} parts · ${layout.totalLines} lines`
    : `${state.payload.title} ━ ${layout.totalParts} parts on ${layout.totalLines} lines · ${tagCount} ${tagCount === 1 ? "tag" : "tags"} ━ depth ${layout.visibleStart}–${layout.visibleEnd} of ${layout.totalDepth}`;
  return {
    lines, hits,
    stats,
    crumb: `¶ ${currentDepth}/${layout.totalDepth}`,
    derived: { rowIds, pathCursorId: layout.cursorNodeId, treeCursorId: map.treeCursorId }
  };
}

function pathTakeHits(
  piece: MapPathRow,
  row: number,
  depthField: number,
  glyphField: number
): HitRegion[] {
  const hits: HitRegion[] = piece.takeRegions.map((region) => ({
    target: { kind: "take", row, take: region.take },
    left: depthField + region.left,
    right: depthField + region.right
  }));
  if (piece.counter.length > 0) {
    const left = depthField + glyphField;
    hits.push(
      { target: { kind: "take", row, take: ((piece.currentTake - 2 + piece.takeCount) % piece.takeCount) + 1 }, left, right: left + 1 },
      {
        target: { kind: "take", row, take: (piece.currentTake % piece.takeCount) + 1 },
        left: left + visibleWidth(piece.counter) - 1,
        right: left + visibleWidth(piece.counter)
      }
    );
  }
  return hits;
}

function renderTreeBody(
  state: StoryScreenState,
  map: MapState,
  width: number,
  bodyHeight: number,
  deadlines?: FrameDeadlineCollector
): MapBody {
  const reserve = (width >= 100 ? 2 : 0) + 3;
  const layout = createAtlasLayout(state.payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    openedColdFolds: map.openedColdFolds,
    sort: "graph",
    maxRows: Math.max(1, bodyHeight - reserve),
    deadlines
  });
  const mapRows = layout.rows.flatMap((row) => {
    const kind = selectableRow(row, layout.sort) ? mapRowKind(row.kind) : null;
    return kind === null ? [] : [{ id: row.id, kind }];
  });
  const rowIds = mapRows.map((row) => row.id);
  const indexById = new Map(rowIds.map((id, index) => [id, index] as const));
  const mapRowById = new Map(mapRows.map((row) => [row.id, row] as const));
  const lines = layout.rows.map((row) => renderMapTreeRow(row, width, state.stream?.targetId ?? null));
  const hits: Array<HitRow | null> = layout.rows.map((row) => {
    const index = indexById.get(row.id);
    const mapRow = mapRowById.get(row.id);
    return index === undefined || mapRow === undefined
      ? null
      : { target: { kind: "list", index, mapRow }, left: 0, right: width };
  });
  appendWindowLine(lines, hits, layout);
  const footnote = mapTreeFoldFootnote(layout, map.showSketches);
  if (footnote.length > 0) {
    lines.push([], foldFootnoteLine(footnote, layout.foldedWords, width));
    hits.push(null, { target: { kind: "action", action: "toggle-sketches" }, left: 0, right: width });
  }
  appendPreview(lines, hits, layout, width);
  const cursor = layout.allRows.find((row) => row.cursor) ?? null;
  const hot = Math.max(0, layout.totalLines - layout.coldLines);
  const cold = layout.coldLines > 0 ? ` ━ ${hot} hot · ${layout.coldLines} folded cold` : "";
  const window = layout.totalRows > layout.rows.length
    ? ` ━ rows ${layout.visibleStart + 1}–${layout.visibleEnd} of ${layout.totalRows}` : "";
  return {
    lines, hits,
    stats: `${state.payload.title} ━ ${layout.totalLines} lines · ${layout.totalParts} parts · ${layout.forkCount} forks${cold}${window}`,
    crumb: cursor === null ? "tree" : `¶ ${cursor.depth}`,
    derived: { rowIds, pathCursorId: map.pathCursorId, treeCursorId: layout.cursorId }
  };
}

function renderMassBody(
  state: StoryScreenState,
  map: MapState,
  width: number,
  bodyHeight: number,
  deadlines?: FrameDeadlineCollector
): MapBody {
  // Sketch fold and window line, plus the preview pair where there is room for
  // it. Doc 26a's removal of the blank + `sort:` pair gave two rows back.
  const reserve = (width >= 100 ? 2 : 0) + 2;
  const layout = createAtlasLayout(state.payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    openedColdFolds: map.openedColdFolds,
    sort: map.massSort,
    maxRows: Math.max(1, bodyHeight - reserve),
    deadlines
  });
  const rowIds = layout.rows.map((row) => row.id);
  const scale = createMapMassScale(layout, width);
  const lines: FrameLine[] = [];
  const hits: Array<HitRow | null> = [];
  let sketchesDrawn = false;
  for (const [index, row] of layout.rows.entries()) {
    if (row.kind === "sketch" && !sketchesDrawn) {
      lines.push(renderMapSketchFold(layout, scale));
      hits.push({ target: { kind: "action", action: "toggle-sketches" }, left: 0, right: width });
      sketchesDrawn = true;
    }
    lines.push(renderMapMassRow(row, scale));
    const kind = mapRowKind(row.kind);
    hits.push(kind === null
      ? null
      : { target: { kind: "list", index, mapRow: { id: row.id, kind } }, left: 0, right: width });
  }
  if (!sketchesDrawn && layout.sketchCount > 0) {
    lines.push(renderMapSketchFold(layout, scale));
    hits.push({ target: { kind: "action", action: "toggle-sketches" }, left: 0, right: width });
  }
  appendWindowLine(lines, hits, layout);
  appendPreview(lines, hits, layout, width);
  const cursor = layout.allRows.find((row) => row.cursor) ?? null;
  const words = formatTotalWords(layout.storyWords);
  // Doc 26a left the title rule as the only place the active order is named, so
  // it has to survive 80 columns — where the full phrasing truncates away.
  const stats = width < 100
    ? `${state.payload.title} ━ ${words}w · ${layout.totalLines} lines ━ ${shortSortTitle(map.massSort)}`
    : `${state.payload.title} ━ ${words} words · ${layout.totalLines} lines ━ ${sortTitle(map.massSort)}`;
  return {
    lines, hits,
    stats,
    crumb: cursor === null ? `${words} words` : `¶ ${cursor.depth} · ${words} words`,
    derived: { rowIds, pathCursorId: map.pathCursorId, treeCursorId: layout.cursorId }
  };
}

function mapRowKind(kind: AtlasRow["kind"]): "node" | "sketch" | "cold" | null {
  return kind === "node" || kind === "sketch" || kind === "cold" ? kind : null;
}

/** The fused fold footnote, its weight landing in the same right gutter the
 *  rows above use, so it reads as one more row rather than a caption. */
function foldFootnoteLine(text: string, words: number, width: number): FrameLine {
  const tail = formatMapWordsBare(words);
  const line: FrameLine = [segment("    ↳ ", "accent · deep"), segment(text, "prose · dim")];
  const padding = width - visibleWidth(tail) - 2 - lineWidth(line);
  if (padding > 0) line.push(segment(" ".repeat(padding)));
  line.push(segment(tail, "chrome"));
  return line;
}

function appendWindowLine(lines: FrameLine[], hits: Array<HitRow | null>, layout: AtlasLayout): void {
  if (layout.visibleStart === 0 && layout.moreRows === 0) return;
  const before = layout.visibleStart;
  const pieces = [before > 0 ? `↑ ${before} earlier` : "", layout.moreRows > 0 ? `↓ ${layout.moreRows} later` : ""]
    .filter((piece) => piece.length > 0).join(" · ");
  lines.push([segment(`  ${pieces}`, "chrome")]);
  hits.push(null);
}

function appendPreview(
  lines: FrameLine[],
  hits: Array<HitRow | null>,
  layout: AtlasLayout,
  width: number
): void {
  if (width < 100) return;
  const cursor = layout.allRows.find((row) => row.cursor && row.kind !== "cold");
  if (cursor === undefined) return;
  const detail = `¶ ${cursor.depth} · ${formatMapWords(cursor.ownWords)}`;
  const preview = truncate(cursor.node.preview.replace(/\s+/g, " ").trim(), Math.max(8, width - visibleWidth(detail) - 8));
  lines.push([], [segment("  ‥ ", "summary"), segment(preview, "summary"),
    segment(" ".repeat(Math.max(1, width - visibleWidth(preview) - visibleWidth(detail) - 5))), segment(detail, "chrome")]);
  hits.push(null, null);
}

function renderTitle(view: MapView, stats: string, width: number): FrameLine {
  const line: FrameLine = [segment("━━ ", "brass dim"), segment("map", "focus / accent"), segment(" · ", "brass dim")];
  for (const [index, tab] of MAP_VIEWS.entries()) {
    if (index > 0) line.push(segment(" ", "brass dim"));
    line.push(tab === view
      ? { text: ` ${tab} `, role: "background", background: "focus / accent", bold: true }
      : segment(` ${tab} `, "dimmed page"));
  }
  const room = Math.max(0, width - lineWidth(line) - 5);
  line.push(segment(" ━ ", "brass dim"), segment(truncate(stats, room), "chrome"));
  const remaining = width - lineWidth(line);
  if (remaining > 0) line.push(segment(` ${"━".repeat(Math.max(0, remaining - 1))}`, "brass dim"));
  return fitLine(line, width);
}

function mapTitleHits(): HitRegion[] {
  let left = visibleWidth("━━ map · ");
  return MAP_VIEWS.map((view, index) => {
    if (index > 0) left += 1;
    const right = left + visibleWidth(` ${view} `);
    const hit: HitRegion = { target: { kind: "map-view", view }, left, right };
    left = right;
    return hit;
  });
}

function renderBreadcrumb(state: StoryScreenState, map: MapState, crumb: string, width: number): FrameLine {
  if (state.prune != null) return renderPruneBreadcrumb(pruneConfirmText(state.prune), width);
  if (state.toast !== null && state.toast !== undefined) return renderMapNotice(state.toast, width);
  if (state.backendTask !== null && state.backendTask !== undefined) {
    return renderMapNotice(`working · ${state.backendTask.label}`, width);
  }
  const payload = state.payload;
  const view = map.view;
  const density = mapHintDensity(width);
  const hint = mapHint(map, density);
  const available = Math.max(0, width - visibleWidth(hint) - 1);
  const shownCrumb = density === "narrow" ? compactCrumb(crumb) : crumb;
  const activeLeaf = payload.path.at(-1)?.id ?? null;
  const tag = payload.tags.find((item) => item.nodeId === activeLeaf) ?? null;
  // A tag is a name the writer chose. An untagged line has none, and the first
  // words of its leaf are not one — the crumb says nothing rather than that.
  const lineIdentity = tag === null
    ? activeLeaf === null ? "unwritten" : ""
    : `${tagGlyph(tag.status)} ${tag.name}`;
  // Reserve the complete numeric crumb before spending the remaining cells on
  // identity. The tag marker belongs to the line identity budget: adding
  // it after truncating the name used to steal the final two cells from `653w`.
  const viewLabel = view === "path"
    ? `${view}/${map.pathShowAllTakes ? "all" : "branches"}`
    : view;
  const separators = lineIdentity.length === 0 ? 1 : 2;
  const fixed = visibleWidth(" MAP ") + visibleWidth(` ${viewLabel}  `)
    + visibleWidth(" · ") * separators + visibleWidth(shownCrumb);
  const [titleWidth, nameWidth] = saturatingIdentityWidths(
    payload.title, lineIdentity, Math.max(0, available - fixed)
  );
  const shownName = truncate(lineIdentity, nameWidth);
  const left: FrameLine = [
    { text: " MAP ", role: "background", background: "focus / accent", bold: true },
    segment(` ${viewLabel}  `, "focus / accent"),
    segment(truncate(payload.title, titleWidth), "chrome"),
    ...(shownName.length === 0
      ? []
      : [segment(" · ", "chrome"), segment(shownName, tagRole(tag))]),
    segment(` · ${shownCrumb}`, "chrome")
  ];
  const shownLeft = fitLine(left, available);
  const gap = Math.max(1, width - lineWidth(shownLeft) - visibleWidth(hint));
  return [...shownLeft, segment(" ".repeat(gap), "chrome"), segment(hint, "chrome")];
}

function renderMapNotice(text: string, width: number): FrameLine {
  return fitLine([
    { text: " MAP ", role: "background", background: "focus / accent", bold: true },
    segment(`  ${text}`, "focus / accent")
  ], width);
}

function renderPruneBreadcrumb(text: string, width: number): FrameLine {
  const block = { text: " PRUNE ", role: "background" as const, background: "danger" as const, bold: true };
  const suffix = " · d confirms · esc keeps";
  const available = Math.max(0, width - visibleWidth(block.text) - 2);
  if (visibleWidth(text) <= available || !text.endsWith(suffix)) {
    return fitLine([block, segment(`  ${text}`, "danger text")], width);
  }
  const body = text.slice(0, -suffix.length);
  const bodyWidth = Math.max(1, available - visibleWidth(suffix));
  return fitLine([
    block,
    segment("  ", "danger text"),
    segment(truncate(body, bodyWidth), "danger text"),
    segment(suffix, "danger text")
  ], width);
}

type MapHintDensity = "narrow" | "medium" | "wide";

/** A footer key and what it runs. The map is full-bleed, so its footer is the
 * only chrome advertising these keys — every one of them is a click target,
 * exactly as a floating panel's footer is. */
function mapHintTokens(map: MapState, density: MapHintDensity): HintToken[] {
  const rows = (label: string): HintToken =>
    ({ text: `↑↓ ${label}`, pair: ["focus-previous", "focus-next"] });
  const cycle = (text: string): HintToken => ({ text, action: "cycle-map-view" });
  const reroute = (text: string): HintToken => ({ text, action: "apply" });
  const escape = (text: string): HintToken => ({ text, action: "cancel" });
  const sort: HintToken = { text: "s sort", action: "map-cycle-sort" };
  if (map.view === "path") {
    const wideToggle = map.pathShowAllTakes ? "a branches" : "a all";
    const toggle: HintToken = {
      text: density === "narrow" ? map.pathShowAllTakes ? "a branch" : "a all" : wideToggle,
      action: "toggle-path-takes"
    };
    const takes: HintToken = { text: "←→ take", pair: ["take-previous", "take-next"] };
    if (density === "narrow") return [cycle("m"), toggle, rows("depth"), takes, escape("esc")];
    if (density === "medium") {
      return [cycle("m tree"), toggle, rows("depth"), takes, reroute("enter"), escape("esc")];
    }
    return [cycle("m tree"), toggle, rows("depth"), takes, reroute("enter reroute"), escape("esc writes")];
  }
  if (map.view === "tree") {
    const follow: HintToken = { text: "l follow", action: "map-follow" };
    if (density === "narrow") return [cycle("m mass"), rows("row"), follow, escape("esc")];
    if (density === "medium") {
      return [cycle("m mass"), rows("row"), follow, reroute("enter"), escape("esc writes")];
    }
    return [cycle("m mass"), rows("row"), follow, reroute("enter reroute"), sort, escape("esc writes")];
  }
  if (density === "narrow") {
    return [cycle("m path"), rows("row"), sort, { text: "l open", action: "map-follow" }, escape("esc")];
  }
  if (density === "medium") {
    return [cycle("m path"), rows("row"), sort, { text: "l open", action: "map-follow" }, escape("esc writes")];
  }
  return [cycle("m path"), rows("row"), sort, { text: "l open line", action: "map-follow" },
    reroute("enter reroute"), escape("esc writes")];
}

function mapHint(map: MapState, density: MapHintDensity): string {
  return joinHintTokens(mapHintTokens(map, density), " · ");
}

function mapHintDensity(width: number): MapHintDensity {
  return width < 100 ? "narrow" : width < 136 ? "medium" : "wide";
}

/** Register every footer key drawn on the breadcrumb row. The scan starts at
 * the hint itself: a bare token like `m` would otherwise match a letter of the
 * story title sitting to its left on the same row. */
function addMapFooterHits(
  hitRows: HitRows,
  lines: FrameLine[],
  height: number,
  map: MapState,
  width: number
): void {
  const density = mapHintDensity(width);
  const tokens = mapHintTokens(map, density);
  addFooterHits(hitRows, lines, height, tokens, mapHint(map, density));
}

/** Spend every identity cell. A short title or line yields its unused share to
 * the other instead of leaving both truncated by a rigid percentage split. */
function saturatingIdentityWidths(title: string, name: string, room: number): [number, number] {
  const titleCells = visibleWidth(title);
  const nameCells = visibleWidth(name);
  let titleWidth = Math.min(titleCells, Math.floor(room * 0.5));
  let nameWidth = Math.min(nameCells, room - titleWidth);
  let remaining = room - titleWidth - nameWidth;
  const titleGrowth = Math.min(remaining, titleCells - titleWidth);
  titleWidth += titleGrowth;
  remaining -= titleGrowth;
  nameWidth += Math.min(remaining, nameCells - nameWidth);
  return [titleWidth, nameWidth];
}

function sortTitle(sort: MapState["massSort"]): string {
  if (sort === "size") return "largest first";
  if (sort === "recency") return "recent first";
  if (sort === "name") return "alphabetical";
  return "deepest first";
}

/** The same order named in the cells a narrow title rule can spare. */
function shortSortTitle(sort: MapState["massSort"]): string {
  if (sort === "size") return "largest";
  if (sort === "recency") return "recent";
  if (sort === "name") return "alpha";
  return "deepest";
}

function formatTotalWords(words: number): string {
  return words < 1_000 ? words.toLocaleString("en-US") : `${Math.round(words / 1_000)}k`;
}

function compactCrumb(crumb: string): string {
  return crumb.replaceAll(" ", "").replace("words", "w");
}
