import type { FrameDeadlineCollector } from "../animation-deadline.js";
import {
  createAtlasLayout,
  type AtlasLayout,
  type AtlasRow
} from "../atlas-layout.js";
import { addHit, type HitRegion, type HitRow, type HitRows } from "../hit.js";
import { createPathLayout } from "../path-layout.js";
import { addInlineHits } from "./story/hits.js";
import { MAP_VIEWS, type MapState, type MapView } from "../map-state.js";
import { pruneConfirmText } from "../prune-model.js";
import type { StoryScreenState } from "../state.js";
import { projectStreamedPayload } from "../stream-projection.js";
import { createMapMassScale, renderMapMassRow, renderMapSketchFold } from "./map-mass-row.js";
import { createMapPathRow, renderMapPathRow, type MapPathRow } from "./map-path-row.js";
import { tagGlyph, tagRole } from "./map-row-labels.js";
import { renderLaneTreeBody } from "./map-lane-body.js";
import { appendMapPreview } from "./map-preview.js";
import { renderSurfaceBreadcrumb } from "./surface-breadcrumb.js";
import { lightWorkKeyword } from "./work-light.js";
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

export interface MapBody {
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
      ? renderLaneTreeBody(visualState, map, width, bodyHeight, deadlines)
      : renderMassBody(visualState, map, width, bodyHeight, deadlines);
  const lensFact = map.view === "tree" && map.factLensFactId !== undefined && map.factLensFactId !== null
    ? payload.facts.find(({ id }) => id === map.factLensFactId) ?? null
    : null;
  const lensActive = lensFact !== null;
  const shown = body.lines.slice(0, bodyHeight);
  const lines = [
    renderTitle(map.view, body.stats, width, lensActive),
    [],
    ...shown,
    ...Array.from({ length: Math.max(0, bodyHeight - shown.length) }, (): FrameLine => []),
    [segment("─".repeat(Math.max(0, width)), "dimmed page")],
    renderBreadcrumb(visualState, map, body.crumb, width, deadlines)
  ].slice(0, height).map((line) => fitLine(line, width));

  hitRows.length = height;
  hitRows.fill(null);
  for (const hit of mapTitleHits(lensActive)) addHit(hitRows, 0, hit);
  for (let row = 0; row < Math.min(shown.length, body.hits.length); row += 1) {
    hitRows[row + 2] = body.hits[row] ?? null;
  }
  addInlineHits([lines[lines.length - 1]!], hitRows, () => true, lines.length - 1);
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

function mapRowKind(kind: AtlasRow["kind"]): "node" | "sketch" | null {
  return kind === "node" || kind === "sketch" ? kind : null;
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
  const cursor = layout.allRows.find((row) => row.cursor) ?? null;
  appendMapPreview(lines, hits, cursor, width);
}

function renderTitle(view: MapView, stats: string, width: number, lensActive = false): FrameLine {
  const line: FrameLine = [
    segment("━━ ", "brass dim"),
    segment(lensActive ? "loom" : "map", "focus / accent"),
    segment(" · ", "brass dim")
  ];
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

function mapTitleHits(lensActive = false): HitRegion[] {
  let left = visibleWidth(`━━ ${lensActive ? "loom" : "map"} · `);
  return MAP_VIEWS.map((view, index) => {
    if (index > 0) left += 1;
    const right = left + visibleWidth(` ${view} `);
    const hit: HitRegion = { target: { kind: "map-view", view }, left, right };
    left = right;
    return hit;
  });
}

function renderBreadcrumb(
  state: StoryScreenState,
  map: MapState,
  crumb: string,
  width: number,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  if (state.prune != null) return renderPruneBreadcrumb(pruneConfirmText(state.prune), width);
  if (state.toast !== null && state.toast !== undefined) return renderMapNotice(state.toast, width);
  if (state.backendTask !== null && state.backendTask !== undefined) {
    return lightWorkKeyword(
      renderMapNotice(`working · ${state.backendTask.label}`, width),
      "working",
      state.now,
      deadlines
    );
  }
  const payload = state.payload;
  const view = map.view;
  const density = mapHintDensity(width);
  const lensActive = map.view === "tree"
    && map.factLensFactId !== undefined
    && map.factLensFactId !== null;
  const hintSegments = mapHintSegments(map, density, lensActive);
  const hintWidth = lineWidth(hintSegments);
  const available = Math.max(0, width - hintWidth - 1);
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
  return renderSurfaceBreadcrumb({
    mode: "MAP",
    scope: lensActive ? "tree/lens" : viewLabel,
    title: payload.title,
    identity: lineIdentity,
    identityRole: tagRole(tag),
    crumb: shownCrumb,
    keys: hintSegments,
    width
  });
}

function renderMapNotice(text: string, width: number): FrameLine {
  return fitLine([
    { text: " MAP ", role: "background", background: "focus / accent", bold: true },
    segment(`  ${text}`, "focus / accent")
  ], width);
}

function renderPruneBreadcrumb(text: string, width: number): FrameLine {
  const block = { text: " PRUNE ", role: "background" as const, background: "danger" as const, bold: true };
  const suffix = " · D confirms · esc keeps";
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
function mapHintSegments(map: MapState, density: MapHintDensity, lensActive = false): FrameLine {
  const line: FrameLine = [];
  const appendToken = (segments: FrameLine) => {
    if (line.length > 0) line.push(segment(" · ", "chrome"));
    line.push(...segments);
  };

  const rows = (label: string): FrameLine => [
    segment("↑", "chrome", { kind: "action", action: "focus-previous" }),
    segment("↓", "chrome", { kind: "action", action: "focus-next" }),
    segment(` ${label}`, "chrome")
  ];
  const takes: FrameLine = [
    segment("←", "chrome", { kind: "action", action: "take-previous" }),
    segment("→", "chrome", { kind: "action", action: "take-next" }),
    segment(" take", "chrome")
  ];
  const cycle = (text: string): FrameLine => [segment(text, "chrome", { kind: "action", action: "cycle-map-view" })];
  const reroute = (text: string): FrameLine => [segment(text, "chrome", { kind: "action", action: "apply" })];
  const escape = (text: string): FrameLine => [segment(text, "chrome", { kind: "action", action: "cancel" })];
  const sort: FrameLine = [segment("s sort", "chrome", { kind: "action", action: "map-cycle-sort" })];
  const follow = (text: string): FrameLine => [segment(text, "chrome", { kind: "action", action: "map-follow" })];
  // `←→` jumps to the nearest row in the next lane; `tab` hides the lanes and
  // opens the path view on the same part (doc "10a": lane 0 is path view).
  const lanes: FrameLine = [
    segment("←", "chrome", { kind: "action", action: "take-previous" }),
    segment("→", "chrome", { kind: "action", action: "take-next" }),
    segment(" lane", "chrome")
  ];
  const hideLanes: FrameLine = [segment("tab path", "chrome", { kind: "action", action: "map-hide-lanes" })];
  // The fold rows used to advertise `a` inside the canvas. Decision 21 took
  // in-canvas hints out of mass; C-06 puts them here for both whole-tree views.
  const sketches: FrameLine = [
    segment("a sketches", "chrome", { kind: "action", action: "toggle-sketches" })
  ];
  const openLens: FrameLine = [segment("f lens", "chrome", { kind: "action", action: "open-fact-lens" })];
  const lensNext: FrameLine = [segment(
    density === "narrow" ? "tab next" : "tab next fact",
    "chrome",
    { kind: "action", action: "cycle-fact-lens" }
  )];
  const lensAnchor: FrameLine = [segment(
    density === "narrow" ? "enter ◆" : "enter go to ◆",
    "chrome",
    { kind: "action", action: "open-fact-lens-anchor" }
  )];
  const lensEdit: FrameLine = [segment(
    density === "narrow" ? "e edit" : "e edit state",
    "chrome",
    { kind: "action", action: "edit-fact-lens" }
  )];

  if (map.view === "path") {
    const wideToggle = map.pathShowAllTakes ? "a branches" : "a all";
    const toggleText = density === "narrow" ? (map.pathShowAllTakes ? "a branch" : "a all") : wideToggle;
    const toggle: FrameLine = [segment(toggleText, "chrome", { kind: "action", action: "toggle-path-takes" })];

    if (density === "narrow") {
      appendToken(cycle("m")); appendToken(toggle); appendToken(rows("depth")); appendToken(takes); appendToken(escape("esc"));
    } else if (density === "medium") {
      appendToken(cycle("m tree")); appendToken(toggle); appendToken(rows("depth")); appendToken(takes); appendToken(reroute("enter")); appendToken(escape("esc"));
    } else {
      appendToken(cycle("m tree")); appendToken(toggle); appendToken(rows("depth")); appendToken(takes); appendToken(reroute("enter reroute")); appendToken(escape("esc writes"));
    }
  } else if (map.view === "tree") {
    if (lensActive) {
      appendToken(lensNext);
      appendToken(lensAnchor);
      appendToken(lensEdit);
      appendToken(escape(density === "narrow" ? "esc loom" : "esc loom"));
      return line;
    }
    if (density === "narrow") {
      appendToken(cycle("m mass")); appendToken(rows("row")); appendToken(lanes); appendToken(hideLanes); appendToken(escape("esc"));
    } else if (density === "medium") {
      appendToken(cycle("m mass")); appendToken(openLens); appendToken(rows("row")); appendToken(lanes); appendToken(sketches); appendToken(hideLanes); appendToken(reroute("enter")); appendToken(escape("esc writes"));
    } else {
      appendToken(cycle("m mass")); appendToken(openLens); appendToken(rows("row")); appendToken(lanes); appendToken(sketches); appendToken(follow("l follow")); appendToken(hideLanes); appendToken(reroute("enter reroute")); appendToken(escape("esc writes"));
    }
  } else {
    if (density === "narrow") {
      appendToken(cycle("m path")); appendToken(rows("row")); appendToken(sort); appendToken(follow("l open")); appendToken(escape("esc"));
    } else if (density === "medium") {
      // Mass carries `s sort` that the tree does not, so it runs out of room
      // one rung earlier: the breadcrumb keeps its cells before the keyline
      // does (C-02 — the tether is never the thing that yields).
      appendToken(cycle("m path")); appendToken(rows("row")); appendToken(sort); appendToken(follow("l open")); appendToken(escape("esc writes"));
    } else {
      appendToken(cycle("m path")); appendToken(rows("row")); appendToken(sort); appendToken(sketches); appendToken(follow("l open line")); appendToken(reroute("enter reroute")); appendToken(escape("esc writes"));
    }
  }
  return line;
}

function mapHintDensity(width: number): MapHintDensity {
  return width < 100 ? "narrow" : width < 136 ? "medium" : "wide";
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
