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
import { EDITOR_OPEN_TOAST, STORY_LOCKED_TOAST, belowPendingSwitch, editorBlocksChange } from "./part-policy.js";
import { chapterJumpPartId, firstPartId, lastPartId, nextPartId } from "./focus-model.js";
import { effectiveFocusedPartId, loadedStoryState, type StoryState } from "./state.js";

export interface StoryActionDependencies {
  /** Refreshes the Library list after a take switch lands — the switched-to
   * take can change the story's preview/updated time, the same way a rename
   * does (`story.titleChanged` is the mirror-image hook the Library calls
   * into this slice with). Also called by `adoptPayload`, for the exact same
   * reason: a landed generation can change the row this story shows. */
  readonly storyChanged: () => void;
  /** True while a generation (`generation/actions.ts`) is writing into, or
   * trying to save into, `storyId` — reads `state.generation` directly
   * rather than taking a `GenerationActions` reference, so this module never
   * has to import the generation slice's action factory (only its pure
   * `generationLocks` predicate, threaded in from `app/actions.ts`'s own
   * wiring). `switchTake`/`switchTakeTo` refuse with a toast while this is
   * true; every other key here (focus moves, chapter jumps, scroll) stays
   * allowed. */
  readonly isLocked: (storyId: string) => boolean;
}

/** Re-exported: the toast lives with the rest of the writing loop's refusals
 * in `story/part-policy.ts`. */
export { STORY_LOCKED_TOAST };


/** Shown wherever a `revision_conflict` (a save, or a fresh Continue
 * admission, built against a payload that has since moved elsewhere) is
 * resolved by reloading and adopting the current story instead of guessing —
 * `runSwitchLoop` below and `generation/actions.ts`'s `finishRun` both use
 * this exact wording. */
export const STORY_RELOADED_TOAST = "The story changed in another window. It was reloaded.";

/** Where focus goes when `adoptPayload` lands a payload. */
export type AdoptFocus =
  | { readonly kind: "new-leaf-if"; readonly partId: string | null }
  | { readonly kind: "part"; readonly partId: string };

export interface StoryActions {
  load(id: string): Promise<void>;
  /** `library/actions.ts` calls this after a successful rename instead of
   * writing `state.story` itself — this slice owns its own shape (review fix
   * B3/B5). `renameStory` returns the full, fresh `StoryPayload`, so this
   * replaces the whole thing when it is the one currently open, the same as
   * the pre-split code did for `state.openStory`. Focus and any in-flight
   * switch survive the swap. */
  titleChanged(updated: StoryPayload): void;
  /**
   * Lands a generation's payload (`generation/actions.ts`, #409 step 5) —
   * the one path a landed take reaches `state.story` through other than
   * `load()`/take-switch. Version-guarded and route-gated exactly like every
   * other adoption in this file: applies only when `storyId` is the exact
   * story currently open (a background generation's own story is never
   * cached here just to receive this update — decision: adopted only if
   * that story is still open) and `payload` is not known to predate what is
   * already showing. Always refreshes the Library row regardless, since a
   * landed generation changes that row's preview/updated time the same way
   * a take switch does.
   *
   * `focus` says where focus goes on landing: `new-leaf-if` moves it onto
   * the new leaf only if the reader's focus still equals `partId` (the part
   * focused when a generation started, so a landing never moves focus out
   * from under a reader who moved on); `part` moves it onto that part when
   * it is on the adopted line (a saved edit or a new take lands the writer
   * on it). `null` or absent leaves focus alone.
   * `announcement`, given, replaces the story's live-region text — only
   * takes effect together with an applied adoption, so it never fires for a
   * story the reader has left.
   *
   * Returns whether `storyId` was in fact the open story (and so whether
   * the update actually applied) — `generation/actions.ts` uses this to
   * decide between updating the on-screen announcement (applied) and
   * pushing a toast naming the story by title (not applied: the reader is
   * elsewhere).
   */
  adoptPayload(
    storyId: string,
    payload: StoryPayload,
    options?: { readonly focus?: AdoptFocus | null; readonly announcement?: string }
  ): boolean;
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
              pushToast(store, STORY_RELOADED_TOAST);
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

    adoptPayload: (storyId, payload, options) => {
      deps.storyChanged();
      let applied = false;
      let moveFocusTo: string | null = null;
      store.set((state) => {
        if (state.route.kind !== "story" || state.route.id !== storyId) return state;
        if (state.story.kind !== "loaded" || state.story.payload.id !== storyId) return state;
        if (!isAtLeastVersion(payload, state.story.payload)) return state;
        applied = true;
        const focus = options?.focus ?? null;
        const newLeafId = payload.path.at(-1)?.id ?? null;
        if (focus?.kind === "new-leaf-if"
          && focus.partId !== null
          && newLeafId !== null
          && state.story.focusedPartId === focus.partId) {
          moveFocusTo = newLeafId;
        } else if (focus?.kind === "part" && payload.path.some((node) => node.id === focus.partId)) {
          moveFocusTo = focus.partId;
        }
        return {
          ...state,
          story: {
            ...state.story,
            payload,
            announcement: options?.announcement ?? state.story.announcement
          }
        };
      });
      // A separate, ordinary `setFocusedPart` call rather than folding the
      // move into the `store.set` above: it already knows how to update
      // `focusedPartId` and record the reading position together, and reuses
      // it verbatim instead of duplicating that pairing here.
      if (moveFocusTo !== null) setFocusedPart(store, storyId, moveFocusTo);
      return applied;
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
      if (deps.isLocked(storyId)) {
        pushToast(store, STORY_LOCKED_TOAST);
        return;
      }
      if (belowPendingSwitch(story, partId)) return;
      if (editorBlocksChange(store.get(), partId)) {
        pushToast(store, EDITOR_OPEN_TOAST);
        return;
      }
      const baseId = story.switching !== null && story.switching.partId === partId
        ? story.switching.targetId
        : partId;
      const target = resolveSwitchTarget(story.payload, baseId, direction);
      if (target === null) return;
      beginSwitch(storyId, partId, target.id);
    }),

    switchTakeTo: (partId, targetId) => withOpenStory(store, (storyId, story) => {
      if (deps.isLocked(storyId)) {
        pushToast(store, STORY_LOCKED_TOAST);
        return;
      }
      if (belowPendingSwitch(story, partId)) return;
      if (editorBlocksChange(store.get(), partId)) {
        pushToast(store, EDITOR_OPEN_TOAST);
        return;
      }
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
