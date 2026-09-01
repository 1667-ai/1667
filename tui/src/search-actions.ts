import type { SearchHit } from "../../shared/story-search.js";
import type { StoryPayload } from "../../shared/types.js";
import { canonicalFactStates } from "../../shared/fact-state.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { factRows } from "./facts-model.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import { resolveRerouteTarget } from "./path-layout.js";
import { flushReadingPositionPersist } from "./reading-position-persist.js";
import { abortPendingSearch, runSearch } from "./search-request.js";

import {
  boundedSearchCursor,
  createSearchState,
  searchRows,
  selectedSearchRow,
  type SearchGroupRow,
  type SearchRowModel,
  type SearchState
} from "./search-model.js";
import { adoptStoryState } from "./story-adoption.js";
import { paletteSessionReturningTo, restorePaletteSession } from "./palette-owner.js";
import {
  generationBusy,
  landOnNode,
  rerouteToNode,
  type RerouteOrigin
} from "./story-actions.js";
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
    abortPendingSearch(search);
    state.search = null;
    state.mode = "NAV";
    return;
  }
  if (resolved.action === "input" || resolved.action === "backspace") {
    const next = applyTextKey(search.query, resolved);
    if (next !== null && next !== search.query) {
      search.query = next;
      runSearch(state, search, source, context.repaint);
    }
    return;
  }
  // Changing scope or case is one deliberate act, not the middle of a word, so
  // neither waits for the pause that typing does.
  if (resolved.action === "cycle") {
    search.scope = search.scope === "tree" ? "vault" : "tree";
    search.cursor = 0;
    runSearch(state, search, source, context.repaint, 0);
    return;
  }
  if (resolved.action === "toggle-search-case") {
    search.caseSensitive = !search.caseSensitive;
    runSearch(state, search, source, context.repaint, 0);
    return;
  }
  const model = searchRows(search, state.payload);
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
  if (!hitSurvivesIn(hit, state.payload)) {
    const factStillExists = hit.kind === "fact"
      && state.payload.facts.some(({ id }) => id === hit.targetId);
    state.toast = factStillExists
      ? "that Fact State is no longer in this story"
      : "that part is no longer in this story";
    return;
  }
  if (hit.kind === "fact") {
    // A vault hit can adopt a different story while Ctrl-P is suspended over
    // Search. Adoption clears the Search object, so the normal identity fence
    // in `openHitFact` no longer matches. Keep that palette session alive and
    // retarget its return surface to the Facts overlay we are about to open.
    const palette = state.mode === "COMMANDS"
      && state.commands?.returnMode === "NAV"
      && state.search !== search
      ? state.commands
      : null;
    openHitFact(hit, state, search, palette);
    return;
  }
  const target = resolveRerouteTarget(state.payload, hit.targetId);
  if (target === null) {
    state.toast = "that part is no longer in this story";
    return;
  }
  let palette = state.mode === "COMMANDS"
    && state.commands?.returnMode === "NAV"
    ? state.commands
    : null;
  if (landOnOwnLine(target, state, search, source)) {
    if (palette !== null) {
      // Landing normally closes Search. A palette opened while the story was
      // loading is still the visible owner, so restore it after landing.
      state.commands = palette;
      state.mode = "COMMANDS";
    }
    return;
  }
  const searchOrigin: RerouteOrigin = {
    owns: (current) => {
      if (palette !== null) {
        return current.mode === "COMMANDS" && current.commands === palette;
      }
      // Ctrl-P can open while switchLine is settling. Capture only a palette
      // that still returns to this exact Search; a later palette is fenced by
      // the task's interaction epoch before this predicate is reached.
      if (current.mode === "COMMANDS"
        && current.commands?.returnMode === "SEARCH"
        && current.search === search) {
        palette = current.commands;
        return true;
      }
      return current.mode === "SEARCH" && current.search === search;
    },
    release: (current) => {
      if (current.search === search) current.search = null;
      if (palette !== null && current.commands === palette) {
        palette.returnMode = "NAV";
      }
    }
  };
  await rerouteToNode(state, source, context, target, searchOrigin);
  if (palette !== null && state.commands === palette) state.mode = "COMMANDS";
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
    const palette = paletteSessionReturningTo(state, "SEARCH");
    flushReadingPositionPersist();
    adoptStoryState(state, payload, context.cache);
    if (palette !== null) {
      // A different-story adoption clears every story-bound surface,
      // including the search navigator. Keep Ctrl-P visible, with Esc
      // returning to the settled story's NAV surface. Its captured
      // selection names the old story and must not cross this boundary.
      palette.selection = null;
      palette.deleteArmedTagNodeId = null;
      restorePaletteSession(state, palette, "NAV");
    } else {
      // adoptStoryState returns the app to NAV; search still owns the screen
      // until the part it is travelling to is on the page.
      state.mode = "SEARCH";
      state.search = search;
    }
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
  if (hit.kind !== "fact") return payload.nodes.some((node) => node.id === hit.targetId);
  const fact = payload.facts.find(({ id }) => id === hit.targetId);
  return fact !== undefined
    && (hit.stateId === undefined || canonicalFactStates(fact).some(({ id }) => id === hit.stateId));
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
function openHitFact(
  hit: SearchHit,
  state: RuntimeState,
  search: SearchState,
  palette: RuntimeState["commands"] = null
): void {
  if (state.search !== search && palette === null) return;
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
    deleteArmedId: null,
    scopeFilter: "everywhere",
    dossier: null,
    ...(hit.stateId === undefined ? {} : { selectedStateId: hit.stateId })
  };
  if (palette !== null) {
    palette.returnMode = "FACTS";
    palette.selection = null;
    state.commands = palette;
    state.mode = "COMMANDS";
  } else {
    state.mode = "FACTS";
  }
}
