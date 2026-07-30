import {
  createStoryIndex,
  workingName,
  type StoryIndex
} from "../../shared/story-model.js";
import type {
  SearchHit,
  SearchResponse,
  SearchScope
} from "../../shared/story-search.js";
import type { StoryPayload, StorySummary, Tag } from "../../shared/types.js";

/** Everything the search navigator renders from. Hits arrive from the backend;
 * grouping, ordering and folding are decided here. */
export interface SearchState {
  query: string;
  scope: SearchScope;
  caseSensitive: boolean;
  /** The newest settled response, or null before the first one lands. */
  response: SearchResponse | null;
  /** True while a request for the current query is still out. */
  searching: boolean;
  /** Monotonic fence: only the newest request may adopt its response. */
  requestId: number;
  /** Cursor over selectable rows (group headers and hits). */
  cursor: number;
  /** Story or branch groups the user folded. */
  foldedGroupIds: readonly string[];
  /** Vault-scope group labels come from the library listing held at open. */
  stories: readonly StorySummary[];
  /** Last failure of a search request, shown in place of results. */
  error: string | null;
}

export interface SearchGroupRow {
  kind: "group";
  id: string;
  /** Tagged line, dead branch, story, or the facts group. */
  sort: "line" | "branch" | "story" | "facts";
  name: string;
  /** What follows the name: `· this line`, `· dead branch`, `· 214 parts`. */
  detail: string;
  folded: boolean;
  tag: Tag | null;
  hits: SearchHit[];
}

export interface SearchHitRow {
  kind: "hit";
  hit: SearchHit;
  groupId: string;
}

export type SearchRow =
  | (SearchGroupRow & { select: number })
  | (SearchHitRow & { select: number })
  | { kind: "blank" };

export interface SearchRowModel {
  rows: SearchRow[];
  selectableCount: number;
  groupCount: number;
  /** Groups that stand for a line or branch — the facts group is not one. */
  lineGroupCount: number;
  hitCount: number;
}

export function createSearchState(
  stories: readonly StorySummary[],
  scope: SearchScope = "tree"
): SearchState {
  return {
    query: "",
    scope,
    stories,
    caseSensitive: false,
    response: null,
    searching: false,
    requestId: 0,
    cursor: 0,
    foldedGroupIds: [],
    error: null
  };
}

/** Rows for the left pane: a blank line, a header and its hits per group, and
 *  one closing blank, exactly as the grid draws them. */
export function searchRows(state: SearchState, payload: StoryPayload): SearchRowModel {
  const hits = state.response?.hits ?? [];
  const groups = state.scope === "tree"
    ? treeGroups(hits, payload)
    : vaultGroups(hits, payload, state.stories);
  const rows: SearchRow[] = [];
  let select = 0;
  let hitCount = 0;
  for (const group of groups) {
    const folded = state.foldedGroupIds.includes(group.id);
    rows.push({ kind: "blank" });
    rows.push({ ...group, folded, select: select++ });
    if (folded) continue;
    for (const hit of group.hits) {
      rows.push({ kind: "hit", hit, groupId: group.id, select: select++ });
      hitCount += 1;
    }
  }
  if (rows.length > 0) rows.push({ kind: "blank" });
  return {
    rows,
    selectableCount: select,
    groupCount: groups.length,
    lineGroupCount: groups.filter((group) => group.sort !== "facts").length,
    hitCount
  };
}

export function selectedSearchRow(
  model: SearchRowModel,
  cursor: number
): (SearchGroupRow & { select: number }) | (SearchHitRow & { select: number }) | null {
  const targetSelect = boundedSearchCursor(cursor, model.selectableCount);
  const row = model.rows.find((r) => r.kind !== "blank" && r.select === targetSelect);
  return row as (SearchGroupRow & { select: number }) | (SearchHitRow & { select: number }) | null ?? null;
}

/** The hit the preview pane shows: the focused one, or a folded group's first.
 *  It carries its landing, so the pane names the part `enter` would open. */
export function previewSearchHit(
  model: SearchRowModel,
  cursor: number,
  payload: StoryPayload
): SearchHitRow | null {
  const row = selectedSearchRow(model, cursor);
  if (row === null) return null;
  if (row.kind === "hit") return row;
  const first = row.hits[0];
  return first === undefined ? null : { kind: "hit", hit: first, groupId: row.id };
}

/** Where a fresh result set puts the cursor: the first hit, not the header
 *  above it — the reader came for the prose. */
export function firstHitCursor(model: SearchRowModel): number {
  const hitRow = model.rows.find((r): r is SearchHitRow & { select: number } => r.kind === "hit");
  return hitRow?.select ?? 0;
}

export function boundedSearchCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, cursor));
}

function groupHits(
  hits: readonly SearchHit[],
  keyFn: (hit: SearchHit) => string,
  rowFn: (key: string, first: SearchHit, hits: SearchHit[]) => SearchGroupRow,
  compareFn: (left: SearchGroupRow, right: SearchGroupRow) => number
): SearchGroupRow[] {
  const groups = new Map<string, SearchGroupRow>();
  for (const hit of hits) {
    const key = keyFn(hit);
    let row = groups.get(key);
    if (row === undefined) {
      // The triggering hit builds the row: a story the client's catalog
      // snapshot has not seen, or one renamed since, carries the only
      // authoritative title there is.
      row = rowFn(key, hit, []);
      groups.set(key, row);
    }
    row.hits.push(hit);
  }
  const ordered = [...groups.values()];
  ordered.sort(compareFn);
  return ordered;
}

/** Tree scope: the current line first, then each dead branch by its fork
 *  depth, then the facts. A hit's group is the branch it hangs from. */
function treeGroups(hits: readonly SearchHit[], payload: StoryPayload): SearchGroupRow[] {
  const index = createStoryIndex(payload);
  const onPath = new Set(payload.path.map((node) => node.id));
  return groupHits(
    hits,
    // The corpus already reports a hit at the part it opens, so the id here is
    // always one a line can run through.
    (hit) => hit.kind === "fact" ? "facts" : branchHeadId(hit.targetId, onPath, index),
    (key, _first, groupHitsList) => key === "facts"
      ? factsGroupRow(groupHitsList)
      : lineGroupRow(key, groupHitsList, index, payload),
    (left, right) => groupOrder(left, index) - groupOrder(right, index)
  );
}

function groupOrder(group: SearchGroupRow, index: StoryIndex): number {
  if (group.sort === "facts") return Number.MAX_SAFE_INTEGER;
  if (group.id === "line") return -1;
  return index.depthByNodeId.get(group.id) ?? 0;
}

/** The take that leaves the current line on the way to this node. A node
 *  already on the line reports the line itself.
 *
 *  Callers pass the node a hit actually travels to, so a chapter summary is
 *  grouped with the part it hangs off. Grouping it by its own id would file a
 *  hit under a dead branch that `enter` then leaves for the current line. */
function branchHeadId(nodeId: string, onPath: ReadonlySet<string>, index: StoryIndex): string {
  if (onPath.has(nodeId)) return "line";
  let node = index.tree.nodesById.get(nodeId) ?? null;
  while (node !== null) {
    const parentId = node.parentId;
    if (parentId === null) return node.id;
    if (onPath.has(parentId)) return node.id;
    node = index.tree.nodesById.get(parentId) ?? null;
  }
  return "line";
}

function lineGroupRow(key: string, hits: SearchHit[], index: StoryIndex, payload: StoryPayload): SearchGroupRow {
  if (key === "line") {
    const leafId = payload.path.at(-1)?.id ?? null;
    const tag = leafId === null ? null : index.tagByNodeId.get(leafId) ?? null;
    return {
      kind: "group",
      id: "line",
      sort: "line",
      name: leafId === null ? "unwritten" : lineLabel(leafId, index),
      detail: "· this line",
      folded: false,
      tag,
      hits
    };
  }
  const depth = index.depthByNodeId.get(key) ?? 0;
  const leafId = index.continuationByNodeId.get(key)?.leafId ?? key;
  return {
    kind: "group",
    id: key,
    sort: "branch",
    name: `¶${depth} ${lineLabel(leafId, index)}`,
    detail: "· dead branch",
    folded: false,
    tag: index.tagByNodeId.get(leafId) ?? null,
    hits
  };
}

function lineLabel(leafId: string, index: StoryIndex): string {
  const tag = index.tagByNodeId.get(leafId);
  return tag?.name ?? workingName(index.tree.nodesById.get(leafId) ?? null);
}

function factsGroupRow(hits: SearchHit[]): SearchGroupRow {
  return { kind: "group", id: "facts", sort: "facts", name: "facts", detail: "· canon notes", folded: false, tag: null, hits };
}

/** Vault scope: one group per story, heaviest first, the open story in place
 *  rather than pinned — the design's own rule. */
function vaultGroups(
  hits: readonly SearchHit[],
  payload: StoryPayload,
  stories: readonly StorySummary[]
): SearchGroupRow[] {
  const summaries = new Map(stories.map((summary) => [summary.id, summary] as const));
  return groupHits(
    hits,
    (hit) => hit.storyId,
    (storyId, first, groupHitsList) => {
      const summary = summaries.get(storyId);
      const parts = summary?.partCount;
      return {
        kind: "group",
        id: storyId,
        sort: "story",
        name: first.storyTitle || summary?.title || storyId,
        detail: storyId === payload.id
          ? "· this story"
          : parts === undefined ? "" : `· ${parts.toLocaleString("en-US")} parts`,
        folded: false,
        tag: null,
        hits: groupHitsList
      };
    },
    (left, right) => right.hits.length - left.hits.length
  );
}
