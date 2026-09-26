import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import type { ReadingPositionsApi } from "../../../client/reading-positions-api.js";
import {
  chapterForRow,
  createManuscriptModel,
  rowIndexForNode,
  rowPart
} from "../../../shared/manuscript-model.js";
import {
  openingFocusIndexOverManuscript,
  type ReadingPositions
} from "../../../shared/reading-position.js";
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

function requireConnection(store: Store<AppState>): Extract<ConnectionState, { kind: "connected" }> {
  const connection = store.get().connection;
  if (connection.kind !== "connected") throw new Error("1667 web: not connected");
  return connection;
}

function requireApi(store: Store<AppState>): StoryApi {
  return requireConnection(store).api;
}

type LoadedStoryState = Extract<StoryState, { kind: "loaded" }>;

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

/** Fetched once per connection (reference equality on the `connection`
 * object — a reconnect always produces a new one), then reused for every
 * story this tab opens; a failure degrades to "no stored positions" rather
 * than blocking the story from opening at all. */
let cachedPositionsConnection: ConnectionState | null = null;
let cachedPositionsPromise: Promise<ReadingPositions> | null = null;

async function loadCachedPositions(store: Store<AppState>): Promise<ReadingPositions> {
  const connection = store.get().connection;
  if (connection.kind !== "connected") return {};
  if (cachedPositionsConnection !== connection) {
    cachedPositionsConnection = connection;
    cachedPositionsPromise = connection.readingPositions.load().catch((error: unknown) => {
      console.warn("1667 web: failed to load reading positions", error);
      return {};
    });
  }
  return await (cachedPositionsPromise ?? Promise.resolve({}));
}

const READING_POSITION_DEBOUNCE_MS = 400;

interface PendingPositionWrite {
  timer: ReturnType<typeof setTimeout> | null;
  readonly storyId: string;
  readonly partId: string | null;
  readonly api: ReadingPositionsApi;
}

let pendingPositionWrite: PendingPositionWrite | null = null;

function cancelPendingPositionTimer(): void {
  if (pendingPositionWrite?.timer !== null && pendingPositionWrite?.timer !== undefined) {
    clearTimeout(pendingPositionWrite.timer);
  }
}

function sendPendingPositionWrite(options: { readonly keepalive?: boolean } = {}): void {
  const pending = pendingPositionWrite;
  if (pending === null) return;
  cancelPendingPositionTimer();
  pendingPositionWrite = null;
  pending.api.set(pending.storyId, pending.partId, options).catch((error: unknown) => {
    console.warn("1667 web: failed to save the reading position", error);
  });
}

function scheduleReadingPositionWrite(store: Store<AppState>, storyId: string, partId: string | null): void {
  const connection = store.get().connection;
  if (connection.kind !== "connected") return;
  cancelPendingPositionTimer();
  pendingPositionWrite = { storyId, partId, api: connection.readingPositions, timer: null };
  pendingPositionWrite.timer = setTimeout(() => sendPendingPositionWrite(), READING_POSITION_DEBOUNCE_MS);
}

/** Sets focus and schedules its durable write in one step — every action
 * that moves reading focus goes through this. */
function setFocusedPart(store: Store<AppState>, storyId: string, partId: string | null): void {
  updateLoadedStory(store, storyId, (story) => ({ ...story, focusedPartId: partId }));
  if (partId !== null) scheduleReadingPositionWrite(store, storyId, partId);
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
    store.set((state) => {
      if (state.route.kind !== "story" || state.route.id !== id) return state;
      // A background reload of an already-loaded story (e.g. the
      // `revision_conflict` recovery below) keeps showing it — no "Loading…"
      // flash, and the switch/focus state a concurrent `switchTake` is
      // updating survives — rather than resetting to "loading" and losing
      // it. `isAtLeastVersion` still guards this call's own adoption below
      // against a newer payload that lands first.
      if (state.story.kind === "loaded" && state.story.payload.id === id) return state;
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
    const positions = await loadCachedPositions(store);
    const model = createManuscriptModel(payload);
    const openingIndex = openingFocusIndexOverManuscript(model, payload, positions[id] ?? null);
    const focusedPartId = rowPart(model, openingIndex)?.id ?? null;
    if (!isCurrentStoryRoute(store, id)) return;
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

  function withFocusMove(storyId: string, compute: (story: LoadedStoryState) => string | null): void {
    const story = currentLoadedStory(store, storyId);
    if (story === null) return;
    const nextId = compute(story);
    if (nextId === null) return;
    setFocusedPart(store, storyId, nextId);
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
          store.set((state) => {
            if (state.route.kind !== "story" || state.route.id !== storyId) return state;
            if (state.story.kind !== "loaded" || state.story.payload.id !== storyId) return state;
            return {
              ...state,
              story: {
                ...state.story,
                payload: next,
                announcement: announcement ?? state.story.announcement
              }
            };
          });
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

    focusPart: (partId) => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      setFocusedPart(store, route.id, partId);
    },

    moveFocus: (direction) => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      withFocusMove(route.id, (story) => {
        const model = createManuscriptModel(story.payload);
        const currentId = effectiveFocusedPartId(story);
        const currentIndex = currentId === null
          ? -1
          : model.parts.findIndex((part) => part.id === currentId);
        const nextIndex = Math.max(0, Math.min(model.parts.length - 1, currentIndex + direction));
        return model.parts[nextIndex]?.id ?? null;
      });
    },

    focusFirst: () => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      withFocusMove(route.id, (story) => createManuscriptModel(story.payload).parts[0]?.id ?? null);
    },

    focusLast: () => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      withFocusMove(route.id, (story) => {
        const model = createManuscriptModel(story.payload);
        return model.parts.at(-1)?.id ?? null;
      });
    },

    jumpChapter: (direction) => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      withFocusMove(route.id, (story) => {
        const model = createManuscriptModel(story.payload);
        const currentId = effectiveFocusedPartId(story);
        const currentRow = currentId === null ? -1 : rowIndexForNode(model, currentId);
        const currentChapter = chapterForRow(model, currentRow)?.number ?? 1;
        const targetNumber = Math.max(1, Math.min(model.chapters.length, currentChapter + direction));
        const chapter = model.chapters.find((candidate) => candidate.number === targetNumber);
        return chapter?.parts[0]?.id ?? null;
      });
    },

    switchTake: (partId, direction) => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      const story = currentLoadedStory(store, route.id);
      if (story === null) return;
      const baseId = story.switching !== null && story.switching.partId === partId
        ? story.switching.targetId
        : partId;
      const target = resolveSwitchTarget(story.payload, baseId, direction);
      if (target === null) return;
      beginSwitch(route.id, partId, target.id);
    },

    switchTakeTo: (partId, targetId) => {
      const route = store.get().route;
      if (route.kind !== "story") return;
      if (currentLoadedStory(store, route.id) === null) return;
      beginSwitch(route.id, partId, targetId);
    },

    toggleDirections: () => {
      const next = !store.get().reading.showDirections;
      persistShowDirections(next);
      store.set((state) => ({ ...state, reading: { ...state.reading, showDirections: next } }));
    },

    flushReadingPosition: () => sendPendingPositionWrite({ keepalive: true })
  };
}
