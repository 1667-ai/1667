import {
  lastPartRowIndex,
  rowIndexForNode,
  rowPart
} from "../../../shared/manuscript-model.js";
import { manuscriptModelOf } from "./manuscript-model.js";
import type { StoryNode, StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";

/**
 * Split out of `app/state.ts`'s old top-level `openStory: StoryPayload | null`
 * (review fix B3): that shape had no way to tell "still loading" apart from
 * "loaded nothing yet", so a failed `loadStory` (e.g. a route naming a
 * deleted story) left the placeholder on "Loading…" forever. `missing` is
 * the state that case renders instead — see `story/StoryView.tsx`.
 *
 * `loaded`'s `focusedPartId`/`switching` are the manuscript read view's own
 * state (#409 step 4): which part has keyboard focus, and — while a take
 * switch is in flight — which sibling the reader is heading toward. Both
 * outlive a `titleChanged` payload swap (a rename elsewhere must not reset
 * where the reader is or interrupt a switch in progress). `announcement` is
 * the live-region text a landed switch sets, for `StoryView.tsx`'s
 * `role="status"` element.
 */
export type StoryState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly id: string }
  | {
      readonly kind: "loaded";
      readonly payload: StoryPayload;
      readonly focusedPartId: string | null;
      readonly switching: { readonly partId: string; readonly targetId: string } | null;
      readonly announcement: string | null;
    }
  | { readonly kind: "missing"; readonly id: string };

export function initialStoryState(): StoryState {
  return { kind: "idle" };
}

export function loadedStoryState(
  payload: StoryPayload,
  focusedPartId: string | null
): StoryState {
  return { kind: "loaded", payload, focusedPartId, switching: null, announcement: null };
}

/** The story id a given state is "about" (`null` for `idle`), so a consumer
 * can compare against the route's id with one check regardless of which
 * variant is current — used by `StoryView` to decide what to render,
 * and by `story/actions.ts`'s own stale-response guard. */
export function storyIdOf(state: StoryState): string | null {
  if (state.kind === "idle") return null;
  if (state.kind === "loaded") return state.payload.id;
  return state.id;
}

/**
 * The part that should actually carry focus right now: `focusedPartId` when
 * it still names a row on the current path, otherwise the opening default
 * (the leaf) — a switch elsewhere, an edit, or a stale value left over from
 * a payload swap can all leave `focusedPartId` pointing at a part that no
 * longer has a row.
 */
export function effectiveFocusedPartId(
  state: Extract<StoryState, { kind: "loaded" }>
): string | null {
  const model = manuscriptModelOf(state.payload);
  if (state.focusedPartId !== null && rowIndexForNode(model, state.focusedPartId) >= 0) {
    return state.focusedPartId;
  }
  return rowPart(model, lastPartRowIndex(model))?.id ?? null;
}

/** The part a keyboard, menu, or editor action targets, with the open story —
 * or `null` when the story is not open, not loaded, or the part left the
 * line. */
export function openPart(
  state: AppState,
  partId: string
): { readonly storyId: string; readonly story: Extract<StoryState, { kind: "loaded" }>; readonly node: StoryNode } | null {
  if (state.route.kind !== "story" || state.story.kind !== "loaded") return null;
  const story = state.story;
  if (story.payload.id !== state.route.id) return null;
  const node = story.payload.path.find((candidate) => candidate.id === partId);
  return node === undefined ? null : { storyId: story.payload.id, story, node };
}
