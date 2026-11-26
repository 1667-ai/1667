import type { ReasoningRecord } from "../../../shared/reasoning.js";
import type { ReasoningDisplayV2 } from "../../../shared/settings-v2-types.js";
import { pushToast } from "../app/toasts.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { effectiveFocusedPartId } from "../story/state.js";

/**
 * A take's thought (`T` in the TUI, #409 step 10g): folded unless the
 * reasoning setting is "open". While a take streams, `LiveThought` shows the
 * thought as it arrives. After the take lands, `ThoughtBlock` shows the
 * stored record, fetched when the part is first unfolded and kept, because a
 * landed take's thought never changes.
 */
export type ThoughtEntry =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly record: ReasoningRecord }
  | { readonly status: "error" };

export interface ThoughtsState {
  /** Parts whose fold was flipped away from the setting's own default. */
  readonly flipped: ReadonlySet<string>;
  readonly entries: Readonly<Record<string, ThoughtEntry>>;
}

export function initialThoughtsState(): ThoughtsState {
  return { flipped: new Set(), entries: {} };
}

export function thoughtKey(partId: string, version: number): string {
  return `${partId}:${version}`;
}

/** The fold key of the thought of a new take that streams into no part yet.
 * The key ends with the run (`forgetLiveThought`). */
export const LIVE_TAKE_THOUGHT = "live-take";

/** The fold key of the thought that streams in `storyId` now, or null when no
 * run there has a thought yet. An append and a rewrite stream into a part. */
export function liveThoughtId(state: AppState, storyId: string): string | null {
  const run = state.generation;
  if (run.kind === "idle" || run.storyId !== storyId || run.reasoning === null) return null;
  if (run.mode === "take") return LIVE_TAKE_THOUGHT;
  return run.appendTo ?? run.rewrite?.partId ?? null;
}

/** A run ended: a new take's live thought goes back to the setting's
 * default. An append keeps its part's fold, because the part stays. */
export function forgetLiveThought(store: Store<AppState>): void {
  store.set((state) => {
    const flipped = state.thoughts.flipped;
    if (!flipped.has(LIVE_TAKE_THOUGHT)) return state;
    const next = new Set(flipped);
    next.delete(LIVE_TAKE_THOUGHT);
    return { ...state, thoughts: { ...state.thoughts, flipped: next } };
  });
}

export const THOUGHTS_OFF_TOAST = "thoughts are off · settings turns them on";
export const NO_THOUGHT_TOAST = "no thought on this take";

/** "marker" folds every thought; "open" unfolds every one; a flip reverses it. */
export function thoughtUnfolded(reasoning: ReasoningDisplayV2, flipped: ReadonlySet<string>, partId: string): boolean {
  return reasoning === "open" ? !flipped.has(partId) : flipped.has(partId);
}

export interface ThoughtActions {
  /** `T`: shows or hides the thought of this part, or the focused one. */
  readonly toggle: (partId?: string) => void;
  /** Reads the thought when its part is unfolded and it is not read yet. */
  readonly ensureLoaded: (storyId: string, partId: string, version: number) => void;
}

function flip(thoughts: ThoughtsState, id: string): ThoughtsState {
  const flipped = new Set(thoughts.flipped);
  if (!flipped.delete(id)) flipped.add(id);
  return { ...thoughts, flipped };
}

export function createThoughtActions(store: Store<AppState>): ThoughtActions {
  const patch = (change: (state: ThoughtsState) => ThoughtsState): void => {
    store.set((state) => {
      const next = change(state.thoughts);
      return next === state.thoughts ? state : { ...state, thoughts: next };
    });
  };

  /** An append rewrites a take's thought, so an entry belongs to the text length it was read at. */
  const ensureLoaded = (storyId: string, partId: string, version: number): void => {
    const key = thoughtKey(partId, version);
    const state = store.get();
    if (state.thoughts.entries[key] !== undefined || state.connection.kind !== "connected") return;
    const api = state.connection.api;
    patch((thoughts) => ({ ...thoughts, entries: { ...thoughts.entries, [key]: { status: "loading" } } }));
    void api.getReasoning(storyId, partId).then(
      (record) => patch((thoughts) => ({ ...thoughts, entries: { ...thoughts.entries, [key]: { status: "ready", record } } })),
      () => patch((thoughts) => ({ ...thoughts, entries: { ...thoughts.entries, [key]: { status: "error" } } }))
    );
  };

  return {
    ensureLoaded,
    toggle: (partId) => {
      const state = store.get();
      if (state.story.kind !== "loaded" || state.route.kind !== "story" || state.story.payload.id !== state.route.id) return;
      const reasoning = state.context.runtime?.runtime.reasoning ?? "marker";
      if (reasoning === "off") {
        pushToast(store, THOUGHTS_OFF_TOAST);
        return;
      }
      const live = liveThoughtId(state, state.story.payload.id);
      if (live !== null && (partId === undefined || partId === live)) {
        patch((thoughts) => flip(thoughts, live));
        return;
      }
      const id = partId ?? effectiveFocusedPartId(state.story);
      const node = id === null ? undefined : state.story.payload.path.find((candidate) => candidate.id === id);
      if (node === undefined || node.reasoning !== true) {
        pushToast(store, NO_THOUGHT_TOAST);
        return;
      }
      patch((thoughts) => flip(thoughts, node.id));
      if (thoughtUnfolded(reasoning, store.get().thoughts.flipped, node.id)) ensureLoaded(state.story.payload.id, node.id, node.text.length);
    }
  };
}
