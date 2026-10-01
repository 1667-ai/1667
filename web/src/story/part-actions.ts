import type { StoryNode } from "../../../shared/types.js";
import type { GenerationActions } from "../generation/actions.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { EDITOR_OPEN_TOAST, editorBlocksChange } from "../editor/state.js";
import { STORY_LOCKED_TOAST, type StoryActions } from "./actions.js";
import { partChangeRefusal } from "./part-guard.js";
import type { StoryState } from "./state.js";

type LoadedStoryState = Extract<StoryState, { kind: "loaded" }>;

/** Shown when a retake meets a chapter summary, as in the TUI. */
export const SUMMARY_RETAKE_TOAST = "Summaries are rewritten, not retaken.";

export interface PartActionDependencies {
  readonly story: Pick<StoryActions, "focusPart">;
  readonly generation: Pick<GenerationActions, "continue">;
  /** True while a generation writes into, or saves into, this story. */
  readonly isLocked: (storyId: string) => boolean;
}

export interface PartActions {
  /** `r`: a new take of this part with the same direction, at once. */
  retake(partId: string): void;
}

/** The part a keyboard or menu action targets, with the open story — or
 * `null` when the story is not open, not loaded, or the part left the line. */
export function openPart(
  store: Store<AppState>,
  partId: string
): { readonly storyId: string; readonly story: LoadedStoryState; readonly node: StoryNode } | null {
  const state = store.get();
  if (state.route.kind !== "story" || state.story.kind !== "loaded") return null;
  const story = state.story;
  if (story.payload.id !== state.route.id) return null;
  const node = story.payload.path.find((candidate) => candidate.id === partId);
  return node === undefined ? null : { storyId: story.payload.id, story, node };
}

export function createPartActions(store: Store<AppState>, deps: PartActionDependencies): PartActions {
  return {
    retake: (partId) => {
      const target = openPart(store, partId);
      if (target === null) return;
      const { storyId, story, node } = target;
      if (node.role === "summary") {
        pushToast(store, SUMMARY_RETAKE_TOAST);
        return;
      }
      const refusal = partChangeRefusal(story, partId, deps.isLocked(storyId), STORY_LOCKED_TOAST);
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      // Focus first: a landed take moves focus only if it still sits where
      // the run started, and that is the part being retaken.
      if (editorBlocksChange(store.get().editor, storyId, story.payload.path, partId)) {
        pushToast(store, EDITOR_OPEN_TOAST);
        return;
      }
      deps.story.focusPart(partId);
      void deps.generation.continue({ instruction: node.instruction, retakeOf: node.id });
    }
  };
}
