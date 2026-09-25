import type { StorySummary } from "../../../shared/types.js";

/**
 * Moved from `app/state.ts`'s old top-level `dialog: DialogState` (review fix
 * B5): the Rename/Delete dialogs are Library-only concerns, so the state
 * that drives them is feature-local, in the same `LibraryState` the story
 * list and search query already live in. `library/LibraryDialogs.tsx` reads
 * it; `App.tsx`'s `Shell` mounts that component directly, not nested inside
 * `Sidebar`.
 */
export type DialogState =
  | { readonly kind: "none" }
  | { readonly kind: "rename"; readonly storyId: string; readonly title: string }
  | { readonly kind: "delete"; readonly storyId: string; readonly title: string };

export interface LibraryState {
  readonly stories: readonly StorySummary[] | null;
  readonly query: string;
  readonly dialog: DialogState;
}

export function initialLibraryState(): LibraryState {
  return { stories: null, query: "", dialog: { kind: "none" } };
}
