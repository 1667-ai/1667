import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import { createManuscriptModel, rowPart } from "../../../shared/manuscript-model.js";
import { openingFocusIndex } from "../../../shared/reading-position.js";
import {
  resolveSwitchTarget,
  switchAnnouncement,
  type SwitchDirection
} from "../../../shared/story-model.js";
import { storyAggregateVersionIsAtLeast } from "../../../shared/story-aggregate-version.js";
import type { StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { persistShowDirections } from "../reading/directions.js";
import type { AppState } from "../app/state.js";
import type { ConnectionState } from "../app/connection.js";
import type { Store } from "../app/store.js";
import { catchAtBoundary, errorMessage, pushToast, runAction } from "../app/toasts.js";
import { chapterJumpPartId, firstPartId, lastPartId, nextPartId } from "./focus-model.js";
import { effectiveFocusedPartId, loadedStoryState, type StoryState } from "./state.js";

export interface StoryActionDependencies {
  /** Refreshes the Library list after a take switch lands — the switched-to
   * take can change the story's preview/updated time, the same way a rename
   * does (`story.titleChanged` is the mirror-image hook the Library calls
   * into this slice with). */
  readonly storyChanged: () => void;
}

export interface StoryActions {
  load(id: string): Promise<void>;
  /** `library/actions.ts` calls this after a successful rename instead of
   * writing `state.story` itself — this slice owns its own shape (review fix
   * B3/B5). `renameStory` returns the full, fresh `StoryPayload`, so this
   * replaces the whole thing when it is the one currently open, the same as
   * the pre-split code did for `state.openStory`. Focus and any in-flight
   * switch survive the swap. */
  titleChanged(updated: StoryPayload): void;
  focusPart(partId: string): void;
  moveFocus(direction: -1 | 1): void;
  focusFirst(): void;
  focusLast(): void;
  jumpChapter(direction: -1 | 1): void;
  switchTake(partId: string, direction: SwitchDirection): void;
  switchTakeTo(partId: string, targetId: string): void;
  toggleDirections(): void;
  /** Forces the debounced reading-position write out immediately — called on
   * `pagehide`/visibility hidden (`app/bootstrap.ts`) with `keepalive: true`
   * so the browser still sends it while the tab is going away. */
  flushReadingPosition(): void;
}

type Connected = Extract<ConnectionState, { kind: "connected" }>;
type LoadedStoryState = Extract<StoryState, { kind: "loaded" }>;

function requireConnection(store: Store<AppState>): Connected {
  const connection = store.get().connection;
  if (connection.kind !== "connected") throw new Error("1667 web: not connected");
  return connection;
}

function requireApi(store: Store<AppState>): StoryApi {
  return requireConnection(store).api;
}

/** Stale responses: only adopt a result for `id` if the route still names
 * it — a fast second click on another row must not have this (slower)
 * response land after the user already moved on. */
function isCurrentStoryRoute(store: Store<AppState>, id: string): boolean {
  const route = store.get().route;
  return route.kind === "story" && route.id === id;
}

/** A candidate payload may adopt over `current` only if it is not known to
 * predate it — guards both a plain `load()` (a late, slower response racing
 * a newer one) and a landed take switch against an out-of-order arrival.
 * Absent version metadata on either side carries no ordering information, so
 * it never blocks adoption. */
function isAtLeastVersion(candidate: StoryPayload, current: StoryPayload): boolean {
  if (candidate.aggregateVersion === undefined || current.aggregateVersion === undefined) return true;
  return storyAggregateVersionIsAtLeast(candidate.aggregateVersion, current.aggregateVersion);
}

function currentLoadedStory(store: Store<AppState>, id: string): LoadedStoryState | null {
  const story = store.get().story;
  return story.kind === "loaded" && story.payload.id === id ? story : null;
}

function updateLoadedStory(
  store: Store<AppState>,
  id: string,
  update: (story: LoadedStoryState) => LoadedStoryState
): void {
  store.set((state) => {
    if (state.route.kind !== "story" || state.route.id !== id) return state;
    if (state.story.kind !== "loaded" || state.story.payload.id !== id) return state;
    return { ...state, story: update(state.story) };
  });
}

/** The route's open story, and the story itself, in one guard — replaces the
 * repeated `route.kind !== "story"` / `currentLoadedStory` pairs every
 * action used to open with. Returns `undefined` (and runs nothing) when
 * there is no story route, or that story is not loaded. */
function withOpenStory<T>(
  store: Store<AppState>,
  run: (storyId: string, story: LoadedStoryState) => T
): T | undefined {
  const route = store.get().route;
  if (route.kind !== "story") return undefined;
  const story = currentLoadedStory(store, route.id);
  if (story === null) return undefined;
  return run(route.id, story);
}

/** Sets focus and records its durable write in one step — every action that
 * moves reading focus goes through this. */
function setFocusedPart(store: Store<AppState>, storyId: string, partId: string | null): void {
  updateLoadedStory(store, storyId, (story) => ({ ...story, focusedPartId: partId }));
  if (partId === null) return;
  const connection = store.get().connection;
  if (connection.kind === "connected") connection.readingPositions.record(storyId, partId);
}

export function createStoryActions(
  store: Store<AppState>,
  deps: StoryActionDependencies
): StoryActions {
  // Codex review: `StoryView`'s mount effect has no cleanup, so
  // `<StrictMode>` (dev) calls `load(id)` twice back to back for the same
  // id before either settles. Without de-duplication, both issued a real
  // `loadStory(id)` request; the second's own opportunistic residue-recovery
  // claim on that story's mutation scope could still be active when a
  // near-immediate delete of the SAME story tried to claim it for real,
  // which the server rejects as "busy" — not a genuine capacity limit, just
  // the app racing itself against one story. A second `load` for an id
  // already in flight reuses the first call's promise instead of issuing a
  // second request.
  const inFlight = new Map<string, Promise<void>>();
  // "one request in flight" for the take-switch loop — per story id, since a
  // reader only ever switches on the one story currently open.
  const switchLoopRunning = new Set<string>();

  const loadUnwrapped = (id: string): Promise<void> => catchAtBoundary(() => runAction(store, "Open story", async () => {
    const wasLoaded = currentLoadedStory(store, id);
    store.set((state) => {
      if (state.route.kind !== "story" || state.route.id !== id) return state;
      // A background reload of an already-loaded story (e.g. the
      // `revision_conflict` recovery below) keeps showing it — no "Loading…"
      // flash — rather than resetting to "loading" and losing the switch/
      // focus state a concurrent `switchTake` is updating. `isAtLeastVersion`
      // still guards this call's own adoption below against a newer payload
      // that lands first.
      if (wasLoaded !== null) return state;
      return { ...state, story: { kind: "loading", id } };
    });
    const api = requireApi(store);
    let payload: StoryPayload;
    try {
      payload = await api.loadStory(id);
    } catch (error) {
      // A deleted (or never-existing) story renders its own "missing"
      // state instead of a toast — see `story/StoryView.tsx` — so
      // this returns instead of rethrowing into `runAction`'s toast.
      if (apiErrorCode(error) === "not_found") {
        store.set((state) => (
          state.route.kind === "story" && state.route.id === id
            ? { ...state, story: { kind: "missing", id } }
            : state
        ));
        return;
      }
      throw error;
    }
    if (!isCurrentStoryRoute(store, id)) return;
    // Reloading an already-loaded story keeps its current focus rather than
    // recomputing an opening position from the (possibly stale, and in any
    // case irrelevant — the reader is already here) stored position.
    let focusedPartId: string | null;
    if (wasLoaded !== null) {
      focusedPartId = wasLoaded.focusedPartId;
    } else {
      const connection = store.get().connection;
      const storedPartId = connection.kind === "connected" ? await connection.readingPositions.positionFor(id) : null;
      if (!isCurrentStoryRoute(store, id)) return;
      const model = createManuscriptModel(payload);
      const openingIndex = openingFocusIndex(model, payload, storedPartId);
      focusedPartId = rowPart(model, openingIndex)?.id ?? null;
    }
    store.set((state) => {
      if (state.route.kind !== "story" || state.route.id !== id) return state;
      // Guard against a late, slower `load()` clobbering a newer payload a
      // take switch already landed while this one was in flight.
      if (state.story.kind === "loaded" && state.story.payload.id === id
        && !isAtLeastVersion(payload, state.story.payload)) return state;
      return { ...state, story: loadedStoryState(payload, focusedPartId) };
    });
  }));

  function load(id: string): Promise<void> {
    const existing = inFlight.get(id);
    if (existing !== undefined) return existing;
    const promise = loadUnwrapped(id).finally(() => {
      if (inFlight.get(id) === promise) inFlight.delete(id);
    });
    inFlight.set(id, promise);
    return promise;
  }

  function runSwitchLoop(storyId: string): void {
    if (switchLoopRunning.has(storyId)) return;
    switchLoopRunning.add(storyId);
    void catchAtBoundary(async () => {
      try {
        for (;;) {
          const story = currentLoadedStory(store, storyId);
          const target = story?.switching?.targetId;
          if (story === undefined || story === null || target === undefined) return;
          // The anchor this landing replaces — captured now so the rebase
          // below only touches focus/switching state that actually still
          // points at the take this request is about to replace.
          const anchorBeforeLanding = story.switching?.partId ?? null;
          let next: StoryPayload;
          try {
            next = await retryWhenBusy(() => requireApi(store).switchLine(storyId, target));
          } catch (error) {
            if (apiErrorCode(error) === "revision_conflict") {
              pushToast(store, "The story changed in another window. It was reloaded.");
              updateLoadedStory(store, storyId, (current) => ({ ...current, switching: null }));
              await load(storyId);
              return;
            }
            pushToast(store, `Switch take failed: ${errorMessage(error)}`);
            updateLoadedStory(store, storyId, (current) => ({ ...current, switching: null }));
            return;
          }
          if (!isCurrentStoryRoute(store, storyId)) return;
          const currentAfterResponse = currentLoadedStory(store, storyId);
          if (currentAfterResponse === null) return;
          if (!isAtLeastVersion(next, currentAfterResponse.payload)) return;
          const announcement = switchAnnouncement(next, target);
          const stillDesired = currentAfterResponse.switching?.targetId;
          updateLoadedStory(store, storyId, (current) => ({
            ...current,
            payload: next,
            announcement: announcement ?? current.announcement,
            // Rebase: `anchorBeforeLanding` (the take this response replaces)
            // is gone from `next`'s path now that `target` has landed in its
            // place. Left stale, `focusedPartId`/`switching.partId` would
            // point at a take no longer on the path — `effectiveFocusedPartId`
            // would fall back to the leaf, and a keyboard take-switch right
            // after this landing would then act on the leaf instead of the
            // part actually being switched.
            focusedPartId: current.focusedPartId === anchorBeforeLanding ? target : current.focusedPartId,
            switching: current.switching === null ? null : { partId: target, targetId: current.switching.targetId }
          }));
          deps.storyChanged();
          if (stillDesired !== undefined && stillDesired !== target) {
            // A rapid press moved the desired target again while this
            // request was in flight — one more round trip for the latest one.
            continue;
          }
          setFocusedPart(store, storyId, target);
          updateLoadedStory(store, storyId, (current) => ({ ...current, switching: null }));
          return;
        }
      } finally {
        switchLoopRunning.delete(storyId);
      }
    });
  }

  function beginSwitch(storyId: string, partId: string, targetId: string): void {
    updateLoadedStory(store, storyId, (story) => ({ ...story, switching: { partId, targetId } }));
    runSwitchLoop(storyId);
  }

  return {
    load,

    titleChanged: (updated) => {
      store.set((state) => (
        state.story.kind === "loaded" && state.story.payload.id === updated.id
          ? { ...state, story: { ...state.story, payload: updated } }
          : state
      ));
    },

    focusPart: (partId) => withOpenStory(store, (storyId) => setFocusedPart(store, storyId, partId)),

    moveFocus: (direction) => withOpenStory(store, (storyId, story) => {
      const model = createManuscriptModel(story.payload);
      const nextId = nextPartId(model, effectiveFocusedPartId(story), direction);
      if (nextId !== null) setFocusedPart(store, storyId, nextId);
    }),

    focusFirst: () => withOpenStory(store, (storyId, story) => {
      const nextId = firstPartId(createManuscriptModel(story.payload));
      if (nextId !== null) setFocusedPart(store, storyId, nextId);
    }),

    focusLast: () => withOpenStory(store, (storyId, story) => {
      const nextId = lastPartId(createManuscriptModel(story.payload));
      if (nextId !== null) setFocusedPart(store, storyId, nextId);
    }),

    jumpChapter: (direction) => withOpenStory(store, (storyId, story) => {
      const model = createManuscriptModel(story.payload);
      const nextId = chapterJumpPartId(model, effectiveFocusedPartId(story), direction);
      if (nextId !== null) setFocusedPart(store, storyId, nextId);
    }),

    switchTake: (partId, direction) => withOpenStory(store, (storyId, story) => {
      if (belowPendingSwitch(story, partId)) return;
      const baseId = story.switching !== null && story.switching.partId === partId
        ? story.switching.targetId
        : partId;
      const target = resolveSwitchTarget(story.payload, baseId, direction);
      if (target === null) return;
      beginSwitch(storyId, partId, target.id);
    }),

    switchTakeTo: (partId, targetId) => withOpenStory(store, (storyId, story) => {
      if (belowPendingSwitch(story, partId)) return;
      beginSwitch(storyId, partId, targetId);
    }),

    toggleDirections: () => {
      const next = !store.get().reading.showDirections;
      persistShowDirections(next);
      store.set((state) => ({ ...state, reading: { ...state.reading, showDirections: next } }));
    },

    flushReadingPosition: () => {
      const connection = store.get().connection;
      if (connection.kind === "connected") connection.readingPositions.flush({ keepalive: true });
    }
  };
}

/** A part below a pending switch belongs to the line that switch replaces;
 * switching it would queue a take on a branch that is about to disappear
 * (and, once the ancestor lands, restore it). The mouse controls are
 * disabled there; keys get the same rule. */
function belowPendingSwitch(
  story: Extract<StoryState, { kind: "loaded" }>,
  partId: string
): boolean {
  if (story.switching === null || story.switching.partId === partId) return false;
  const path = story.payload.path;
  const anchor = path.findIndex((node) => node.id === story.switching!.partId);
  const target = path.findIndex((node) => node.id === partId);
  return anchor >= 0 && target > anchor;
}

