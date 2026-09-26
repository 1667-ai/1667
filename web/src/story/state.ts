import type { StoryPayload } from "../../../shared/types.js";

/**
 * Split out of `app/state.ts`'s old top-level `openStory: StoryPayload | null`
 * (review fix B3): that shape had no way to tell "still loading" apart from
 * "loaded nothing yet", so a failed `loadStory` (e.g. a route naming a
 * deleted story) left the placeholder on "Loading…" forever. `missing` is
 * the state that case renders instead — see `story/StoryPlaceholder.tsx`.
 */
export type StoryState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly id: string }
  | { readonly kind: "loaded"; readonly payload: StoryPayload }
  | { readonly kind: "missing"; readonly id: string };

export function initialStoryState(): StoryState {
  return { kind: "idle" };
}

/** The story id a given state is "about" (`null` for `idle`), so a consumer
 * can compare against the route's id with one check regardless of which
 * variant is current — used by `StoryPlaceholder` to decide what to render,
 * and by `story/actions.ts`'s own stale-response guard. */
export function storyIdOf(state: StoryState): string | null {
  if (state.kind === "idle") return null;
  if (state.kind === "loaded") return state.payload.id;
  return state.id;
}
