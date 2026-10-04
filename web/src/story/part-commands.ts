import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryPayload } from "../../../shared/types.js";
import { NO_SELECTION_MESSAGE } from "../../../shared/rewrite-target.js";
import { continuationStats, rememberedLeafId } from "../../../shared/story-model.js";
import type { ComposeActions } from "../compose/actions.js";
import { focusComposer } from "../compose/dom.js";
import type { EditorActions } from "../editor/actions.js";
import type { GenerationActions } from "../generation/actions.js";
import type { PanelActions } from "../panel/actions.js";
import type { ChapterActions } from "../chapters/actions.js";
import type { FactActions } from "../facts/index.js";
import type { TagsActions } from "../tags/actions.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { STORY_RELOADED_TOAST, type StoryActions } from "./actions.js";
import { copyStoryText } from "./copy.js";
import { createDeletePlan } from "./delete-plan.js";
import { createUnusedPrunePlan, NOTHING_TO_PRUNE_TOAST } from "./prune-unused.js";
import { nodeDeleteRefusal, partActionRefusal, pruneUnusedRefusal, type WebPartActionId } from "./part-policy.js";
import { openPart } from "./state.js";

export interface PartCommandDependencies {
  readonly story: Pick<StoryActions, "focusPart" | "adoptPayload">;
  readonly generation: Pick<GenerationActions, "continue">;
  readonly compose: Pick<ComposeActions, "startRetake" | "startRewrite">;
  readonly editor: Pick<EditorActions, "openEdit" | "openWrite">;
  readonly tags: Pick<TagsActions, "openForPart">;
  readonly chapters: Pick<ChapterActions, "addBreak">;
  readonly facts: Pick<FactActions, "openNew" | "startPick">;
  readonly panel: Pick<PanelActions, "open">;
}

/** What a part action may need from the page: the text selected in the part,
 * and the passage a rewrite replaces. */
export interface PartRunOptions {
  readonly selection?: string;
  readonly rewrite?: { readonly start: number; readonly end: number; readonly expected: string };
}

export interface PartCommands {
  /** The one dispatcher for a part action, whether it comes from a key or
   * from the `···` menu: asks `partActionRefusal` first (a refusal is a
   * toast and nothing else), then does the action. */
  run(id: WebPartActionId, partId: string, options?: PartRunOptions): void;
  /** `Y`: copies the whole line's text. */
  copyLine(): void;
  /** `x`: opens this part's `···` menu. */
  openMenu(partId: string): void;
  /** The map's `D`: asks to delete a take of the story, on the reading line or
   * not. */
  askDeleteNode(nodeId: string): void;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
  /** The palette's "prune drafts & discarded": reviews what would go. */
  askPruneUnused(): void;
  cancelPruneUnused(): void;
  confirmPruneUnused(): Promise<void>;
}

export function createPartCommands(store: Store<AppState>, deps: PartCommandDependencies): PartCommands {
  const setUi = (change: (ui: AppState["partUi"]) => AppState["partUi"]): void =>
    store.set((state) => ({ ...state, partUi: change(state.partUi) }));

  function askDelete(partId: string): void {
    const target = openPart(store.get(), partId);
    if (target === null) return;
    const plan = createDeletePlan(target.story.payload, partId);
    if (plan === null) return;
    setUi((ui) => ({ ...ui, deletePlan: plan, deleting: false }));
  }

  function askDeleteNode(nodeId: string): void {
    const state = store.get();
    const refusal = nodeDeleteRefusal(state, nodeId);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    if (state.story.kind !== "loaded") return;
    const plan = createDeletePlan(state.story.payload, nodeId);
    if (plan === null) return;
    setUi((ui) => ({ ...ui, deletePlan: plan, deleting: false }));
  }

  function copyLine(partId: string): void {
    const state = store.get();
    const target = openPart(state, partId);
    if (target === null) return;
    const payload = target.story.payload;
    const parts = continuationStats(payload, partId).parts;
    if (parts === 0) {
      pushToast(store, "Nothing below this part to copy.");
      return;
    }
    const lineClip = { storyId: payload.id, sourceNodeId: partId, expectedLeafId: rememberedLeafId(payload, partId), parts };
    setUi((ui) => ({ ...ui, lineClip }));
    pushToast(store, `Copied story line. ${parts} ${parts === 1 ? "part" : "parts"} ready to paste.`);
  }

  async function pasteLine(targetId: string): Promise<void> {
    const state = store.get();
    const clip = state.partUi.lineClip;
    if (clip === null || state.story.kind !== "loaded" || clip.storyId !== state.story.payload.id) {
      pushToast(store, "Nothing copied to paste.");
      return;
    }
    if (state.connection.kind !== "connected") return;
    const api = state.connection.api;
    const storyId = clip.storyId;
    try {
      const payload = await retryWhenBusy(() => api.pasteStoryLine(storyId, targetId, {
        sourceNodeId: clip.sourceNodeId,
        expectedLeafId: clip.expectedLeafId
      }));
      const at = payload.path.findIndex((node) => node.id === targetId);
      const first = at >= 0 ? payload.path[at + 1] : undefined;
      const message = `Pasted story line. ${clip.parts} ${clip.parts === 1 ? "part" : "parts"}.`;
      deps.story.adoptPayload(storyId, payload, {
        announcement: message,
        ...(first === undefined ? {} : { focus: { kind: "part" as const, partId: first.id } })
      });
      setUi((ui) => (ui.lineClip === clip ? { ...ui, lineClip: null } : ui));
      pushToast(store, message);
    } catch (error) {
      // The copy stays, so the writer can try again. A failed call can still
      // have changed the story: look again.
      const reloaded = await reload(storyId);
      if (reloaded !== null) deps.story.adoptPayload(storyId, reloaded);
      const code = apiErrorCode(error);
      pushToast(store, code === "conflict" || code === "revision_conflict"
        ? STORY_RELOADED_TOAST
        : `Paste failed: ${errorMessage(error)}`);
    }
  }

  function askPruneUnused(): void {
    const state = store.get();
    if (state.story.kind !== "loaded" || state.route.kind !== "story" || state.story.payload.id !== state.route.id) return;
    const refusal = pruneUnusedRefusal(state);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    const plan = createUnusedPrunePlan(state.story.payload);
    if (plan === null) {
      pushToast(store, NOTHING_TO_PRUNE_TOAST);
      return;
    }
    setUi((ui) => (ui.deleting ? ui : { ...ui, unusedPlan: plan }));
  }

  async function confirmPruneUnused(): Promise<void> {
    const state = store.get();
    const plan = state.partUi.unusedPlan;
    if (plan === null || state.partUi.deleting) return;
    if (state.story.kind !== "loaded" || state.connection.kind !== "connected" || state.story.payload.id !== plan.storyId) return;
    const refusal = pruneUnusedRefusal(state);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    const api = state.connection.api;
    setUi((ui) => ({ ...ui, deleting: true }));
    try {
      const payload = await retryWhenBusy(() => api.pruneUnusedTakes(plan.storyId, {
        expectedStoryRevision: plan.revision,
        expectedTakeCount: plan.takes,
        expectedPartCount: plan.parts
      }));
      const message = `Pruned ${plan.takes} unused ${plan.takes === 1 ? "take" : "takes"}.`;
      deps.story.adoptPayload(plan.storyId, payload, { announcement: message });
      setUi((ui) => ({ ...ui, unusedPlan: null, deleting: false }));
      pushToast(store, message);
    } catch (error) {
      // Always look again: an unknown outcome is settled by looking.
      const reloaded = await reload(plan.storyId);
      if (reloaded !== null) deps.story.adoptPayload(plan.storyId, reloaded);
      setUi((ui) => ({ ...ui, unusedPlan: null, deleting: false }));
      const code = apiErrorCode(error);
      pushToast(store, code === "conflict" || code === "revision_conflict"
        ? "The story changed. Review the prune again."
        : `Prune failed: ${errorMessage(error)}`);
    }
  }

  function run(id: WebPartActionId, partId: string, options: PartRunOptions = {}): void {
    const state = store.get();
    const refusal = partActionRefusal(state, partId, id);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    const target = openPart(state, partId);
    if (target === null) return;
    switch (id) {
      case "continue":
        deps.story.focusPart(partId);
        void deps.generation.continue();
        break;
      case "direct":
        deps.story.focusPart(partId);
        focusComposer();
        break;
      case "retake":
        // Focus first: a landed take moves focus only if it still sits where
        // the run started, and that is the part being retaken.
        deps.story.focusPart(partId);
        void deps.generation.continue({ instruction: target.node.instruction, retakeOf: partId });
        break;
      case "retake-with-prompt": deps.compose.startRetake(partId); break;
      case "write": deps.editor.openWrite(partId); break;
      case "edit": deps.editor.openEdit(partId); break;
      case "copy":
        void copyStoryText(store, target.story.payload, options.selection === undefined
          ? { kind: "part", partId }
          : { kind: "selection", text: options.selection });
        break;
      case "prune": askDelete(partId); break;
      case "rewrite-selection":
        if (options.rewrite === undefined) pushToast(store, NO_SELECTION_MESSAGE);
        else deps.compose.startRewrite(partId, options.rewrite);
        break;
      case "copy-line": copyLine(partId); break;
      case "paste-line": void pasteLine(partId); break;
      case "tag": deps.tags.openForPart(partId); break;
      case "end-chapter": void deps.chapters.addBreak(partId); break;
      case "fact-here": deps.facts.openNew({ anchorPartId: partId }); break;
      case "new-fact": deps.facts.openNew(); break;
      case "fact-from-selection": deps.facts.openNew({ text: options.selection ?? "" }); break;
      case "fact-state": deps.facts.startPick("new-state", partId); deps.panel.open("facts"); break;
      case "fact-end": deps.facts.startPick("end", partId); deps.panel.open("facts"); break;
      default: break;
    }
  }

  async function reload(storyId: string): Promise<StoryPayload | null> {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return null;
    return await connection.api.loadStory(storyId).catch(() => null);
  }

  return {
    run,

    copyLine: () => {
      const { story } = store.get();
      if (story.kind === "loaded") void copyStoryText(store, story.payload, { kind: "line" });
    },

    openMenu: (partId) => {
      if (openPart(store.get(), partId) === null) return;
      setUi((ui) => ({ ...ui, menuRequest: { partId, serial: (ui.menuRequest?.serial ?? 0) + 1 } }));
    },

    askDeleteNode,

    askPruneUnused,
    cancelPruneUnused: () => setUi((ui) => (ui.deleting ? ui : { ...ui, unusedPlan: null })),
    confirmPruneUnused,

    cancelDelete: () => setUi((ui) => (ui.deleting ? ui : { ...ui, deletePlan: null })),

    confirmDelete: async () => {
      const state = store.get();
      const plan = state.partUi.deletePlan;
      if (plan === null || state.partUi.deleting) return;
      // The writer confirmed some time after asking: ask the policy again.
      const refusal = nodeDeleteRefusal(state, plan.nodeId);
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      if (state.story.kind !== "loaded" || state.connection.kind !== "connected") return;
      const path = state.story.payload.path;
      const index = path.findIndex((node) => node.id === plan.nodeId);
      const onLine = index >= 0;
      const previousId = index > 0 ? path[index - 1]!.id : null;
      const api = state.connection.api;
      setUi((ui) => ({ ...ui, deleting: true }));
      const finish = (payload: StoryPayload): void => {
        // Focus lands on the part above, or on the new first part.
        const focusId = !onLine ? undefined : previousId !== null && payload.path.some((node) => node.id === previousId)
          ? previousId
          : payload.path[0]?.id;
        deps.story.adoptPayload(plan.storyId, payload, {
          announcement: `Deleted ${plan.parts} ${plan.parts === 1 ? "part" : "parts"}.`,
          ...(focusId === undefined ? {} : { focus: { kind: "part" as const, partId: focusId } })
        });
        setUi((ui) => ({ ...ui, deletePlan: null, deleting: false }));
      };
      try {
        finish(await retryWhenBusy(() => api.deleteNode(plan.storyId, plan.nodeId, plan.parts)));
      } catch (error) {
        // Always reload: a failed call can still have changed the story, and
        // an unknown outcome is settled by looking.
        const reloaded = await reload(plan.storyId);
        if (reloaded !== null && !reloaded.nodes.some((node) => node.id === plan.nodeId)) {
          finish(reloaded);
          return;
        }
        if (reloaded !== null) deps.story.adoptPayload(plan.storyId, reloaded);
        setUi((ui) => ({ ...ui, deletePlan: null, deleting: false }));
        const code = apiErrorCode(error);
        pushToast(store, code === "conflict" || code === "revision_conflict"
          ? STORY_RELOADED_TOAST
          : `Delete failed: ${errorMessage(error)}`);
      }
    }
  };
}
