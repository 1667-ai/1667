import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryPayload } from "../../../shared/types.js";
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
import { partActionRefusal, type WebPartActionId } from "./part-policy.js";
import { openPart } from "./state.js";

export interface PartCommandDependencies {
  readonly story: Pick<StoryActions, "focusPart" | "adoptPayload">;
  readonly generation: Pick<GenerationActions, "continue">;
  readonly compose: Pick<ComposeActions, "startRetake">;
  readonly editor: Pick<EditorActions, "openEdit" | "openWrite">;
  readonly tags: Pick<TagsActions, "openForPart">;
  readonly chapters: Pick<ChapterActions, "addBreak">;
  readonly facts: Pick<FactActions, "openNew" | "startPick">;
  readonly panel: Pick<PanelActions, "open">;
}

export interface PartCommands {
  /** The one dispatcher for a part action, whether it comes from a key or
   * from the `···` menu: asks `partActionRefusal` first (a refusal is a
   * toast and nothing else), then does the action. */
  run(id: WebPartActionId, partId: string, options?: { readonly selection?: string }): void;
  /** `Y`: copies the whole line's text. */
  copyLine(): void;
  /** `x`: opens this part's `···` menu. */
  openMenu(partId: string): void;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
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

  function run(id: WebPartActionId, partId: string, options: { readonly selection?: string } = {}): void {
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

    cancelDelete: () => setUi((ui) => (ui.deleting ? ui : { ...ui, deletePlan: null })),

    confirmDelete: async () => {
      const state = store.get();
      const plan = state.partUi.deletePlan;
      if (plan === null || state.partUi.deleting) return;
      // The writer confirmed some time after asking: ask the policy again.
      const refusal = partActionRefusal(state, plan.nodeId, "prune");
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      if (state.story.kind !== "loaded" || state.connection.kind !== "connected") return;
      const path = state.story.payload.path;
      const index = path.findIndex((node) => node.id === plan.nodeId);
      const previousId = index > 0 ? path[index - 1]!.id : null;
      const api = state.connection.api;
      setUi((ui) => ({ ...ui, deleting: true }));
      const finish = (payload: StoryPayload): void => {
        // Focus lands on the part above, or on the new first part.
        const focusId = previousId !== null && payload.path.some((node) => node.id === previousId)
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
