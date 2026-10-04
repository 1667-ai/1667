import type { ReasoningRecord } from "../../../shared/reasoning.js";
import type { ReasoningDisplayV2 } from "../../../shared/settings-v2-types.js";
import { pushToast } from "../app/toasts.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { effectiveFocusedPartId } from "../story/state.js";

/**
 * A landed take's stored thought (`T` in the TUI, #409 step 10g, owner
 * decision 5): folded unless the reasoning setting is "open", and never shown
 * while text streams. The record is fetched when the part is first unfolded
 * and kept, because a take's thought never changes.
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
      const id = partId ?? effectiveFocusedPartId(state.story);
      const node = id === null ? undefined : state.story.payload.path.find((candidate) => candidate.id === id);
      if (node === undefined || node.reasoning !== true) {
        pushToast(store, NO_THOUGHT_TOAST);
        return;
      }
      patch((thoughts) => {
        const flipped = new Set(thoughts.flipped);
        if (!flipped.delete(node.id)) flipped.add(node.id);
        return { ...thoughts, flipped };
      });
      if (thoughtUnfolded(reasoning, store.get().thoughts.flipped, node.id)) ensureLoaded(state.story.payload.id, node.id, node.text.length);
    }
  };
}
