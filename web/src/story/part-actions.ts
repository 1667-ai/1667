import { apiErrorCode } from "../../../client/api-error.js";
import { canonicalFactStates } from "../../../shared/fact-state.js";
import { createStoryIndex } from "../../../shared/story-model.js";
import { subtreeIds, takeIndex } from "../../../shared/story-tree.js";
import type { StoryNode, StoryPayload } from "../../../shared/types.js";
import type { GenerationActions } from "../generation/actions.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { EDITOR_OPEN_TOAST, editorBlocksChange } from "../editor/state.js";
import { STORY_LOCKED_TOAST, STORY_RELOADED_TOAST, type StoryActions } from "./actions.js";
import { partChangeRefusal } from "./part-guard.js";
import type { DeletePlan } from "./part-ui-state.js";
import type { StoryState } from "./state.js";

type LoadedStoryState = Extract<StoryState, { kind: "loaded" }>;

/** Shown when a retake meets a chapter summary, as in the TUI. */
export const SUMMARY_RETAKE_TOAST = "Summaries are rewritten, not retaken.";

export interface PartActionDependencies {
  readonly story: Pick<StoryActions, "focusPart" | "adoptPayload">;
  readonly generation: Pick<GenerationActions, "continue">;
  /** True while a generation writes into, or saves into, this story. */
  readonly isLocked: (storyId: string) => boolean;
}

export interface PartActions {
  /** `r`: a new take of this part with the same direction, at once. */
  retake(partId: string): void;
  /** `x`: opens this part's `···` menu. */
  openMenu(partId: string): void;
  /** `D`, or Delete in the menu: asks before deleting this part and
   * everything below it. */
  askDelete(partId: string): void;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
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

/** What deleting `nodeId` removes: the part, everything under it, the lines
 * that end there, the tags on them, and the Fact states anchored in them. */
export function createDeletePlan(payload: StoryPayload, nodeId: string): DeletePlan | null {
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const ids = new Set(subtreeIds(index.tree, nodeId));
  const position = takeIndex(index.tree, nodeId);
  return {
    storyId: payload.id,
    nodeId,
    partNumber: index.depthByNodeId.get(nodeId) ?? 1,
    take: position.index,
    takeCount: position.count,
    parts: index.subtreeCountByNodeId.get(nodeId) ?? ids.size,
    lines: node.leafCount,
    tags: payload.tags.filter((tag) => ids.has(tag.nodeId)).map((tag) => tag.name),
    factStates: payload.facts.reduce(
      (total, fact) => total + canonicalFactStates(fact)
        .filter((state) => state.anchorPartId !== undefined && ids.has(state.anchorPartId)).length,
      0
    )
  };
}

export function createPartActions(store: Store<AppState>, deps: PartActionDependencies): PartActions {
  const setUi = (change: (ui: AppState["partUi"]) => AppState["partUi"]): void =>
    store.set((state) => ({ ...state, partUi: change(state.partUi) }));

  /** The refusal for a change to this part right now, or `null`. */
  function refusalFor(story: LoadedStoryState, storyId: string, partId: string): string | null {
    const refusal = partChangeRefusal(story, partId, deps.isLocked(storyId), STORY_LOCKED_TOAST);
    if (refusal !== null) return refusal;
    return editorBlocksChange(store.get().editor, storyId, story.payload.path, partId) ? EDITOR_OPEN_TOAST : null;
  }

  async function reload(storyId: string): Promise<StoryPayload | null> {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return null;
    return await connection.api.loadStory(storyId).catch(() => null);
  }

  return {
    retake: (partId) => {
      const target = openPart(store, partId);
      if (target === null) return;
      const { storyId, story, node } = target;
      if (node.role === "summary") {
        pushToast(store, SUMMARY_RETAKE_TOAST);
        return;
      }
      const refusal = refusalFor(story, storyId, partId);
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      // Focus first: a landed take moves focus only if it still sits where
      // the run started, and that is the part being retaken.
      deps.story.focusPart(partId);
      void deps.generation.continue({ instruction: node.instruction, retakeOf: node.id });
    },

    openMenu: (partId) => {
      if (openPart(store, partId) === null) return;
      setUi((ui) => ({ ...ui, menuRequest: { partId, serial: (ui.menuRequest?.serial ?? 0) + 1 } }));
    },

    askDelete: (partId) => {
      const target = openPart(store, partId);
      if (target === null) return;
      const refusal = refusalFor(target.story, target.storyId, partId);
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      const plan = createDeletePlan(target.story.payload, partId);
      if (plan === null) return;
      setUi((ui) => ({ ...ui, deletePlan: plan, deleting: false }));
    },

    cancelDelete: () => setUi((ui) => (ui.deleting ? ui : { ...ui, deletePlan: null })),

    confirmDelete: async () => {
      const state = store.get();
      const plan = state.partUi.deletePlan;
      if (plan === null || state.partUi.deleting) return;
      const target = openPart(store, plan.nodeId);
      if (target !== null) {
        const refusal = refusalFor(target.story, target.storyId, plan.nodeId);
        if (refusal !== null) {
          pushToast(store, refusal);
          return;
        }
      }
      if (state.connection.kind !== "connected") {
        pushToast(store, "Not connected. Nothing was deleted.");
        return;
      }
      const path = state.story.kind === "loaded" ? state.story.payload.path : [];
      const index = path.findIndex((node) => node.id === plan.nodeId);
      const previousId = index > 0 ? path[index - 1]!.id : null;
      const api = state.connection.api;
      setUi((ui) => ({ ...ui, deleting: true }));
      const finish = (payload: StoryPayload, announcement: string): void => {
        const first = payload.path[0]?.id;
        const focusPartId = previousId !== null && payload.path.some((node) => node.id === previousId)
          ? previousId
          : first;
        deps.story.adoptPayload(plan.storyId, payload, {
          focusNewLeafIf: null,
          announcement,
          ...(focusPartId === undefined ? {} : { focusPartId })
        });
        setUi((ui) => ({ ...ui, deletePlan: null, deleting: false }));
      };
      try {
        const payload = await retryWhenBusy(() => api.deleteNode(plan.storyId, plan.nodeId, plan.parts));
        finish(payload, `Deleted ${plan.parts} ${plan.parts === 1 ? "part" : "parts"}.`);
      } catch (error) {
        // Always reload: a failed call can still have changed the story, and
        // an unknown outcome is settled by looking.
        const reloaded = await reload(plan.storyId);
        if (reloaded !== null && !reloaded.nodes.some((node) => node.id === plan.nodeId)) {
          finish(reloaded, `Deleted ${plan.parts} ${plan.parts === 1 ? "part" : "parts"}.`);
          return;
        }
        if (reloaded !== null) deps.story.adoptPayload(plan.storyId, reloaded, { focusNewLeafIf: null });
        setUi((ui) => ({ ...ui, deletePlan: null, deleting: false }));
        const code = apiErrorCode(error);
        pushToast(store, code === "conflict" || code === "revision_conflict"
          ? STORY_RELOADED_TOAST
          : `Delete failed: ${errorMessage(error)}`);
      }
    }
  };
}
