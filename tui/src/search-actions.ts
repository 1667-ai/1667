import { searchQueryIsRunnable, type SearchHit } from "../../shared/story-search.js";
import type { StoryPayload } from "../../shared/types.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { factRows } from "./facts-model.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import { flushReadingPositionPersist } from "./reading-position-persist.js";

import {
  boundedSearchCursor,
  createSearchState,
  firstHitCursor,
  searchRows,
  selectedSearchRow,
  type SearchGroupRow,
  type SearchRowModel,
  type SearchState
} from "./search-model.js";
import { adoptStoryState } from "./story-adoption.js";
import {
  generationBusy,
  landOnNode,
  rerouteToNode,
  type RerouteOrigin
} from "./story-actions.js";
import { resolveRerouteTarget } from "./path-layout.js";
import type { RuntimeState } from "./state.js";

export function openSearch(state: RuntimeState, source: AppSource): void {
  state.search = createSearchState(source.stories);
  state.mode = "SEARCH";
}

export async function searchAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const search = state.search;
  if (search === null) return;
  if (resolved.action === "cancel") {
    state.search = null;
    state.mode = "NAV";
    return;
  }
  const model = searchRows(search, state.payload);
  if (resolved.action === "input" || resolved.action === "backspace") {
    const next = applyTextKey(search.query, resolved);
    if (next !== null && next !== search.query) {
      search.query = next;
      runSearch(state, search, source, context.repaint);
    }
    return;
  }
  if (resolved.action === "cycle") {
    search.scope = search.scope === "tree" ? "vault" : "tree";
    search.cursor = 0;
    runSearch(state, search, source, context.repaint);
    return;
  }
  if (resolved.action === "toggle-search-case") {
    search.caseSensitive = !search.caseSensitive;
    runSearch(state, search, source, context.repaint);
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    const step = resolved.action === "focus-next" ? 1 : -1;
    search.cursor = boundedSearchCursor(search.cursor + step, model.selectableCount);
    return;
  }
  if (resolved.action === "focus-index") {
    search.cursor = boundedSearchCursor(resolved.index ?? search.cursor, model.selectableCount);
    return;
  }
  if (resolved.action === "take-previous" || resolved.action === "take-next") {
    foldSelectedGroup(search, model, resolved.action === "take-previous");
    return;
  }
  if (resolved.action === "apply" || resolved.action === "open-selected") {
    const row = selectedSearchRow(model, search.cursor);
    if (row === null) return;
    if (row.kind === "group") {
      foldGroup(search, row.id, !search.foldedGroupIds.includes(row.id));
      return;
    }
    await openSearchHit(row.hit, state, search, source, context);
  }
}

/** `←` folds the group the cursor sits in and moves onto its header; `→`
 *  opens it again. A folded group keeps its place in the list. */
function foldSelectedGroup(
  search: SearchState,
  model: SearchRowModel,
  folding: boolean
): void {
  const row = selectedSearchRow(model, search.cursor);
  if (row === null) return;
  const groupId = row.kind === "group" ? row.id : row.groupId;
  if (folding && row.kind === "hit") {
    // Collapsing under the cursor would strand it inside rows that no longer
    // exist; land on the header that now stands for them.
    const headerRow = model.rows.find((candidate): candidate is SearchGroupRow & { select: number } =>
      candidate.kind === "group" && candidate.id === groupId
    );
    if (headerRow !== undefined) search.cursor = headerRow.select;
  }
  foldGroup(search, groupId, folding);
}

function foldGroup(search: SearchState, groupId: string, folded: boolean): void {
  if (folded) {
    if (!search.foldedGroupIds.includes(groupId)) {
      search.foldedGroupIds = [...search.foldedGroupIds, groupId];
    }
  } else {
    search.foldedGroupIds = search.foldedGroupIds.filter((id) => id !== groupId);
  }
}

/**
 * `enter` is the only way out of search and into the story.
 *
 * Inside the tree it routes the line through the part and lands on it. At vault
 * scope it opens the story that owns the hit first, and only reroutes there
 * when the part is off that story's own line — a story whose line already runs
 * through the part keeps the line it remembers.
 */
async function openSearchHit(
  hit: SearchHit,
  state: RuntimeState,
  search: SearchState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (generationBusy(state)) {
    state.toast = "stream running · esc stops it first";
    return;
  }
  if (hit.storyId !== state.payload.id) {
    const adopted = await openHitStory(hit, state, search, source, context);
    if (!adopted) return;
  }
  if (hit.kind === "fact") {
    openHitFact(hit, state, search);
    return;
  }
  const target = resolveRerouteTarget(state.payload, hit.targetId);
  if (target === null) {
    state.toast = "that part is no longer in this story";
    return;
  }
  if (landOnOwnLine(target, state, search, source)) return;
  const searchOrigin: RerouteOrigin = {
    owns: (current) => current.mode === "SEARCH" && current.search === search,
    release: (current) => { current.search = null; }
  };
  await rerouteToNode(state, source, context, target, searchOrigin);
}

/** Load and adopt the story a vault hit belongs to. Search keeps the screen
 *  until the caller has travelled to the part.
 *
 *  The hit is checked against the story as loaded before anything is adopted: a
 *  result set can outlive the prose it names, and a jump that cannot land must
 *  not still move the reader to another story. */
async function openHitStory(
  hit: SearchHit,
  state: RuntimeState,
  search: SearchState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  let adopted = false;
  await context.backend.run("opening story", async (task) => {
    const payload = await source.api.loadStory(hit.storyId);
    if (!task.interactionCurrent() || state.search !== search) return;
    if (!hitSurvivesIn(hit, payload)) {
      state.toast = "that part is no longer in that story";
      return;
    }
    flushReadingPositionPersist();
    adoptStoryState(state, payload);
    context.cache.invalidate();
    // adoptStoryState returns the app to NAV; search still owns the screen
    // until the part it is travelling to is on the page.
    state.mode = "SEARCH";
    state.search = search;
    adopted = true;
  });
  return adopted;
}

/** Whether the hit still names something in the story as loaded.
 *
 *  This asks whether the destination exists, not whether its prose still says
 *  what it said. A part edited since the query is still the part the reader
 *  asked to see, and landing on it is the honest answer; refusing every hit
 *  whose story has moved would make a vault result set useless after any edit
 *  anywhere in the vault. */
function hitSurvivesIn(hit: SearchHit, payload: StoryPayload): boolean {
  return hit.kind === "fact"
    ? payload.facts.some((fact) => fact.id === hit.targetId)
    : payload.nodes.some((node) => node.id === hit.targetId);
}

/** A part already on the story's own line needs no reroute — landing on it is
 *  enough, and the line the story remembers stays intact. */
function landOnOwnLine(
  targetId: string,
  state: RuntimeState,
  search: SearchState,
  source: AppSource
): boolean {
  if (!state.payload.path.some((node) => node.id === targetId)) return false;
  if (state.search === search) state.search = null;
  landOnNode(state, source, targetId);
  return true;
}

/** A fact has no place on the page, so its hit opens the facts overlay with
 *  that note selected. */
function openHitFact(hit: SearchHit, state: RuntimeState, search: SearchState): void {
  if (state.search !== search) return;
  const rows = factRows(state.payload.facts, null, "");
  const cursor = rows.findIndex((fact) => fact.id === hit.targetId);
  if (cursor < 0) {
    state.toast = "that part is no longer in this story";
    return;
  }
  state.search = null;
  state.facts = {
    cursor,
    query: "",
    chip: 0,
    selectedTag: null,
    filtering: false,
    deleteArmedId: null
  };
  state.mode = "FACTS";
}

/**
 * Ask the backend for the current query.
 *
 * Every keystroke fires one request. `requestId` is the fence: a response is
 * adopted only while it is still the newest one asked for, so out-of-order
 * arrivals cannot overwrite a later query's results.
 *
 * The settled response is dropped as the request goes out. Keeping it would
 * paint hits from the previous query, scope or case under the new header —
 * and `enter` would travel to one of them.
 */
export function runSearch(
  state: RuntimeState,
  search: SearchState,
  source: AppSource,
  repaint: () => void
): void {
  const query = search.query.trim();
  const requestId = search.requestId + 1;
  search.requestId = requestId;
  search.response = null;
  search.error = null;
  search.cursor = 0;
  if (!searchQueryIsRunnable(query)) {
    search.searching = false;
    return;
  }
  search.searching = true;
  // The payload is the fence, not just the story id. Only adoption replaces it
  // — a stream mutates its own view, never this object — so requiring the same
  // payload rejects exactly the responses that describe a story which has since
  // changed, and rejects nothing while the writer is generating.
  const payload = state.payload;
  const owns = () => state.search === search
    && search.requestId === requestId
    && state.payload === payload;
  void source.api.searchStories({
    query,
    scope: search.scope,
    storyId: state.payload.id,
    caseSensitive: search.caseSensitive
  }).then((response) => {
    if (!owns()) return;
    search.response = response;
    search.searching = false;
    search.cursor = firstHitCursor(searchRows(search, state.payload));
    repaint();
  }, (error: unknown) => {
    if (!owns()) return;
    search.searching = false;
    search.response = null;
    search.error = error instanceof Error ? error.message : String(error);
    repaint();
  });
}
