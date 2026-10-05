import {
  createLaneLayout,
  laneCursorAcross,
  laneSelectable,
  type LaneRow
} from "../../../shared/lane-layout.js";
import {
  createAtlasLayout,
  selectableRow as massSelectable,
  type AtlasRow
} from "../../../shared/atlas-layout.js";
import type { MapMassSort } from "../../../shared/map-model.js";
import { createPathLayout, pathLineLeafId, type PathLayout } from "../../../shared/path-layout.js";
import {
  continuationStats,
  createStoryIndex,
  formatAge,
  rememberedLeafId
} from "../../../shared/story-model.js";
import { isChapterSummary, takeIndex } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";
import { planLineSwitch } from "../story/line-switch.js";

/**
 * The map's pure model: what the rows are, which of them the cursor can land
 * on, and what the footer says about the cursor's node. Nothing here knows
 * about the cursor itself while a layout is built: the cursor is separate
 * state, so moving it never rebuilds a layout.
 */

export type MapViewKind = "tree" | "path" | "mass";

export interface MapStats {
  readonly lines: number;
  readonly parts: number;
  readonly forks: number;
}

/** Line, part and fork counts, the way the TUI's tree header counts them. */
export function mapStats(payload: StoryPayload): MapStats {
  const index = createStoryIndex(payload);
  const lineNodes = payload.nodes.filter((node) => !isChapterSummary(node));
  const roots = (index.tree.childrenByParentId.get(null) ?? []).filter((node) => !isChapterSummary(node));
  return {
    lines: index.mapLineCount,
    parts: lineNodes.length,
    forks: lineNodes.filter((node) => node.childCount >= 2).length + Number(roots.length > 1)
  };
}

/** The chapter that opens after a part, by the part's id. */
function chapterTitles(payload: StoryPayload): ReadonlyMap<string, string> {
  return new Map(payload.chapterBreaks.map((chapterBreak) => [chapterBreak.parentPartId, chapterBreak.title] as const));
}

// ---------- tree ----------

export interface TreeModel {
  readonly kind: "tree";
  readonly rows: readonly LaneRow[];
  readonly laneCount: number;
  readonly overflow: boolean;
  /** 1 for a row drawn thin (a fork or a close), 0 for a full row. */
  readonly thin: Uint8Array;
  /** Row indexes the cursor can land on, in reading order. */
  readonly selectable: readonly number[];
  /** A selectable row's id to its position in `selectable`. */
  readonly positionById: ReadonlyMap<string, number>;
  /** Every row's id to its index in `rows`. */
  readonly indexById: ReadonlyMap<string, number>;
  readonly chapters: ReadonlyMap<string, string>;
  readonly coldLines: number;
}

export interface TreeOptions {
  readonly now: number;
  readonly showSketches: boolean;
  readonly openedColdFolds: ReadonlySet<string>;
}

export function buildTreeModel(payload: StoryPayload, options: TreeOptions): TreeModel {
  const layout = createLaneLayout(payload, options);
  const rows = layout.allRows;
  const thin = new Uint8Array(rows.length);
  const selectable: number[] = [];
  const positionById = new Map<string, number>();
  const indexById = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    indexById.set(row.id, index);
    if (row.kind === "fork" || row.kind === "close") thin[index] = 1;
    if (laneSelectable(row)) {
      positionById.set(row.id, selectable.length);
      selectable.push(index);
    }
  }
  return {
    kind: "tree", rows, laneCount: layout.laneCount, overflow: layout.overflow, thin, selectable,
    positionById, indexById, chapters: chapterTitles(payload), coldLines: layout.coldLines
  };
}

/** The row id the cursor should sit on for `nodeId`: the node's own row, else
 * its line's end, else the nearest ancestor that has a row (a middle part of
 * an off-path line has none of its own), else `fallbackId`, else `firstId`.
 * `has` says whether a node has a selectable row in the view. */
function resolveCursorNode(
  payload: StoryPayload,
  has: (id: string) => boolean,
  nodeId: string | null,
  fallbackId: string | null,
  firstId: string | null
): string | null {
  const index = createStoryIndex(payload);
  if (nodeId !== null) {
    if (has(nodeId)) return nodeId;
    const leafId = rememberedLeafId(payload, nodeId, index);
    if (has(leafId)) return leafId;
    for (let node = index.tree.nodesById.get(nodeId); node !== undefined;
      node = node.parentId === null ? undefined : index.tree.nodesById.get(node.parentId)) {
      if (has(node.id)) return node.id;
    }
  }
  if (fallbackId !== null && has(fallbackId)) return fallbackId;
  return firstId;
}

export function resolveTreeCursor(
  payload: StoryPayload,
  model: TreeModel,
  nodeId: string | null,
  fallbackId: string | null
): string | null {
  const first = model.selectable[0];
  return resolveCursorNode(
    payload, (id) => model.positionById.has(id), nodeId, fallbackId,
    first === undefined ? null : model.rows[first]!.id
  );
}

/** `↑`/`↓`: the neighbouring selectable row. */
export function moveTreeCursor(model: TreeModel, cursorId: string, direction: -1 | 1): string {
  const position = model.positionById.get(cursorId);
  if (position === undefined) return cursorId;
  const next = model.selectable[Math.max(0, Math.min(model.selectable.length - 1, position + direction))];
  return next === undefined ? cursorId : model.rows[next]!.id;
}

/** `←`/`→`: the nearest selectable row one lane over, or `null`. */
export function acrossTreeCursor(model: TreeModel, cursorId: string, direction: -1 | 1): string | null {
  const from = model.indexById.get(cursorId);
  if (from === undefined) return null;
  const target = laneCursorAcross(model.rows, model.laneCount, from, direction);
  return target === null ? null : model.rows[target]!.id;
}

// ---------- mass ----------

/** One row of the mass view: a line (or a sketch) with its bar, or the fold
 * that stands for the sketches. */
export type MassItem =
  | { readonly kind: "row"; readonly row: AtlasRow }
  | { readonly kind: "fold"; readonly count: number; readonly words: number };

export interface MassModel {
  readonly kind: "mass";
  readonly items: readonly MassItem[];
  /** Item indexes the cursor can land on, in order. */
  readonly selectable: readonly number[];
  readonly positionById: ReadonlyMap<string, number>;
  readonly indexById: ReadonlyMap<string, number>;
  /** The largest line's words: the scale every bar is drawn against. */
  readonly massMaximum: number;
  /** The line the reader is on, or null. */
  readonly activeId: string | null;
  readonly sketchCount: number;
}

export interface MassOptions {
  readonly now: number;
  readonly showSketches: boolean;
  readonly sort: MapMassSort;
}

export function buildMassModel(payload: StoryPayload, options: MassOptions): MassModel {
  const layout = createAtlasLayout(payload, { now: options.now, showSketches: options.showSketches, sort: options.sort });
  const items: MassItem[] = [];
  const selectable: number[] = [];
  const positionById = new Map<string, number>();
  const indexById = new Map<string, number>();
  let foldDrawn = false;
  const fold = (): void => {
    foldDrawn = true;
    items.push({ kind: "fold", count: layout.sketchCount, words: layout.sketchWords });
  };
  let activeId: string | null = null;
  for (const row of layout.allRows) {
    if (row.kind === "sketch" && !foldDrawn) fold();
    if (row.kind === "node" && row.active) activeId = row.id;
    if (massSelectable(row)) {
      positionById.set(row.id, selectable.length);
      indexById.set(row.id, items.length);
      selectable.push(items.length);
    }
    items.push({ kind: "row", row });
  }
  if (!foldDrawn && layout.sketchCount > 0) fold();
  return {
    kind: "mass", items, selectable, positionById, indexById,
    massMaximum: layout.massMaximum, activeId, sketchCount: layout.sketchCount
  };
}

export function resolveMassCursor(
  payload: StoryPayload,
  model: MassModel,
  nodeId: string | null,
  fallbackId: string | null
): string | null {
  const first = model.selectable[0];
  const firstItem = first === undefined ? undefined : model.items[first];
  return resolveCursorNode(
    payload, (id) => model.positionById.has(id), nodeId, model.activeId ?? fallbackId,
    firstItem?.kind === "row" ? firstItem.row.id : null
  );
}

/** `↑`/`↓`: the neighbouring selectable row. */
export function moveMassCursor(model: MassModel, cursorId: string, direction: -1 | 1): string {
  const position = model.positionById.get(cursorId);
  if (position === undefined) return cursorId;
  const next = model.items[model.selectable[Math.max(0, Math.min(model.selectable.length - 1, position + direction))]!];
  return next?.kind === "row" ? next.row.id : cursorId;
}

// ---------- path ----------

export interface PathModel {
  readonly kind: "path";
  readonly layout: PathLayout;
  /** Every shown take's id to the index of its row. */
  readonly rowOfNode: ReadonlyMap<string, number>;
  readonly chapters: ReadonlyMap<string, string>;
}

/** The key a path layout is built by: its rows depend on the cursor's line
 * alone, so a cursor move along the line keeps the same key. */
export function pathLineKey(payload: StoryPayload, cursorId: string, showSketches: boolean): string {
  return pathLineLeafId(payload, cursorId, showSketches);
}

export function buildPathModel(payload: StoryPayload, lineLeafId: string, showSketches: boolean): PathModel {
  const layout = createPathLayout(payload, lineLeafId, Number.MAX_SAFE_INTEGER, 5, showSketches);
  const rowOfNode = new Map<string, number>();
  for (const [offset, row] of layout.rows.entries()) {
    rowOfNode.set(row.pathNode.id, offset);
    for (const cell of row.cells) rowOfNode.set(cell.node.id, offset);
  }
  return { kind: "path", layout, rowOfNode, chapters: chapterTitles(payload) };
}

/** The node the path cursor really sits on (a hidden sketch resolves to a
 * visible take) and the row it is in. */
export function resolvePathCursor(model: PathModel, cursorId: string | null, fallbackId: string): string {
  if (cursorId !== null && model.rowOfNode.has(cursorId)) return cursorId;
  return model.rowOfNode.has(fallbackId) ? fallbackId : model.layout.cursorNodeId;
}

// ---------- footer ----------

export type MapAction = "switch" | "go" | "unfold";

export interface NodeDetail {
  readonly nodeId: string;
  readonly preview: string;
  readonly part: number;
  readonly words: number;
  readonly age: string;
  readonly take: { readonly index: number; readonly count: number } | null;
  readonly below: number;
  /** Where the node sits against the line being read. */
  readonly place: string;
  readonly action: MapAction;
  /** Cold rows only: the folded subtree's line count and idle weeks. */
  readonly cold: { readonly lines: number; readonly weeks: number } | null;
  readonly name: string | null;
}

/** What the footer says about the cursor's node. `cold` is given for a cold
 * row, whose action unfolds instead of switching. */
export function nodeDetail(
  payload: StoryPayload,
  nodeId: string,
  now: number,
  cold: { readonly lines: number; readonly weeks: number } | null
): NodeDetail | null {
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const part = index.depthByNodeId.get(nodeId) ?? 0;
  const take = takeIndex(index.tree, nodeId);
  const plan = planLineSwitch(payload, nodeId);
  let place = "";
  if (plan === null || plan.kind === "focus") place = "On the line you are reading.";
  else if (plan.extendsLeaf) place = "Continues the line you are reading.";
  else {
    const forkPart = (index.depthByNodeId.get(plan.anchorId) ?? 1) - 1;
    place = forkPart === 0 ? "Another beginning." : `Branches after part ${forkPart}.`;
  }
  const leafId = rememberedLeafId(payload, nodeId, index);
  return {
    nodeId,
    preview: node.preview.replace(/\s+/g, " ").trim(),
    part,
    words: node.words,
    age: formatAge(node.lastTouched, now).toLowerCase(),
    take: take.count > 1 ? take : null,
    below: continuationStats(payload, nodeId, index).parts,
    place,
    action: cold !== null ? "unfold" : plan !== null && plan.kind === "switch" ? "switch" : "go",
    cold,
    name: index.tagByNodeId.get(leafId)?.name ?? null
  };
}
