import type { StoryActions } from "../story/actions.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { generationLocks } from "../generation/state.js";
import { STORY_LOCKED_TOAST, STORY_RELOADED_TOAST } from "../story/actions.js";
import { openPart } from "../story/part-actions.js";
import { PART_SWITCHING_TOAST, PART_WRITING_TOAST, partSwitchPending } from "../story/part-guard.js";
import { saveEditor, type EditorSaveRequest } from "./save.js";
import {
  EDITOR_OPEN_TOAST,
  editorDirty,
  openEditorState,
  type EditorState
} from "./state.js";

export interface EditorActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
}

export type SaveKind = "new" | "in-place";

export interface EditorActions {
  /** `e`: opens the editor on this part. */
  openEdit(partId: string): void;
  /** `w`: opens an empty editor for the writer's own take of this part, or —
   * with `null` on an empty story — for the first part. */
  openWrite(partId: string | null): void;
  setText(text: string): void;
  setInstruction(text: string): void;
  /** Saves the open editor: as a new take (the default, and the only Save of
   * `w`), or in place (`e` only). */
  save(kind: SaveKind): Promise<void>;
  /** Escape and Cancel: a clean editor closes; a changed one asks for a
   * second press first. */
  requestClose(): void;
}

export const NOTHING_TO_SAVE_TOAST = "Write some prose before saving.";
export const PART_GONE_TOAST = "This part no longer exists. Copy your text before closing.";
export const PART_OFF_LINE_TOAST = "This part is no longer on the story line. Copy your text before closing.";
export const PART_CHANGED_TOAST = "The part changed in another window. Save again to overwrite.";
export const SUMMARY_FORK_TOAST = "A summary can only be saved in place.";

export function createEditorActions(store: Store<AppState>, deps: EditorActionDependencies): EditorActions {
  /** Raised for each opened editor, so a late save answer never touches a
   * newer one. */
  let serial = 0;
  let openSerial = 0;

  const update = (change: (editor: EditorState) => EditorState): void =>
    store.set((state) => {
      if (state.editor === null) return state;
      const next = change(state.editor);
      return next === state.editor ? state : { ...state, editor: next };
    });

  const close = (): void => store.set((state) => (state.editor === null ? state : { ...state, editor: null }));

  async function save(kind: SaveKind): Promise<void> {
    const state = store.get();
    const editor = state.editor;
    if (editor === null || editor.saving) return;
    const base = editor.base;
    const editSerial = openSerial;

    const text = editor.text.trim();
    let request: EditorSaveRequest;
    let announcement: string;
    if (editor.mode === "edit") {
      if (base === null) return;
      if (kind === "new" && base.role === "summary") {
        pushToast(store, SUMMARY_FORK_TOAST);
        return;
      }
      if (text.length === 0) {
        pushToast(store, NOTHING_TO_SAVE_TOAST);
        return;
      }
      const textChanged = text !== base.text;
      const instructionChanged = editor.instruction !== base.instruction;
      // Nothing changed: there is nothing to save, so the editor just closes.
      if (!textChanged && !instructionChanged) {
        close();
        return;
      }
      request = kind === "new"
        ? {
            kind: "fork",
            storyId: editor.storyId,
            base,
            instruction: editor.instruction,
            text,
            knownNodeIds: new Set(storyNodeIds(state))
          }
        : {
            kind: "in-place",
            storyId: editor.storyId,
            base,
            patch: {
              ...(textChanged ? { text } : {}),
              ...(instructionChanged ? { instruction: editor.instruction } : {})
            }
          };
      announcement = kind === "new" ? "New take saved." : "Part updated.";
    } else {
      if (kind === "in-place") {
        pushToast(store, "Only an edited part can be saved in place.");
        return;
      }
      if (text.length === 0) {
        pushToast(store, NOTHING_TO_SAVE_TOAST);
        return;
      }
      request = {
        kind: "write",
        storyId: editor.storyId,
        parentId: editor.mode === "first" ? null : base?.parentId ?? null,
        instruction: "",
        text,
        knownNodeIds: new Set(storyNodeIds(state))
      };
      announcement = editor.mode === "first" ? "First part saved." : "Your take saved.";
    }

    if (state.connection.kind !== "connected") {
      pushToast(store, "Not connected. Draft kept.");
      return;
    }
    if (generationLocks(state.generation, editor.storyId)) {
      pushToast(store, `${STORY_LOCKED_TOAST} Draft kept.`);
      return;
    }

    update((current) => ({ ...current, saving: true, discardArmed: false }));
    const outcome = await saveEditor(state.connection.api, request);
    const stillOpen = openSerial === editSerial && store.get().editor !== null;

    if (outcome.kind === "saved") {
      const applied = deps.story.adoptPayload(editor.storyId, outcome.payload, {
        focusNewLeafIf: null,
        announcement,
        ...(outcome.landedId === null ? {} : { focusPartId: outcome.landedId })
      });
      if (!applied) pushToast(store, announcement);
      if (stillOpen) close();
      return;
    }

    if (outcome.payload !== null) deps.story.adoptPayload(editor.storyId, outcome.payload, { focusNewLeafIf: null });
    if (!stillOpen) return;

    if (outcome.kind === "conflict") {
      if (editor.mode === "edit" && base !== null) {
        const rebased = outcome.payload?.path.find((node) => node.id === base.id) ?? null;
        if (rebased === null) {
          const exists = outcome.payload?.nodes.some((node) => node.id === base.id) ?? false;
          pushToast(store, exists ? PART_OFF_LINE_TOAST : PART_GONE_TOAST);
          update((current) => ({ ...current, saving: false }));
          return;
        }
        update((current) => ({ ...current, base: rebased, saving: false, overwriteArmed: true }));
        pushToast(store, PART_CHANGED_TOAST);
        return;
      }
      update((current) => ({ ...current, saving: false }));
      pushToast(store, `${STORY_RELOADED_TOAST} Draft kept.`);
      return;
    }

    update((current) => ({ ...current, saving: false }));
    pushToast(store, `${errorMessage(outcome.error)} Draft kept.`);
  }

  return {
    openEdit: (partId) => {
      const target = openPart(store, partId);
      if (target === null) return;
      const { storyId, story, node } = target;
      const current = store.get().editor;
      if (current !== null && current.storyId === storyId && current.partId === partId && current.mode === "edit") return;
      const generation = store.get().generation;
      if (generationLocks(generation, storyId) && generation.kind !== "idle"
        && generation.mode === "append" && generation.appendTo === node.id) {
        pushToast(store, PART_WRITING_TOAST);
        return;
      }
      if (partSwitchPending(story, partId)) {
        pushToast(store, PART_SWITCHING_TOAST);
        return;
      }
      if (current !== null && editorDirty(current)) {
        pushToast(store, EDITOR_OPEN_TOAST);
        return;
      }
      openSerial = ++serial;
      store.set((state) => ({ ...state, editor: openEditorState(storyId, "edit", node) }));
    },

    openWrite: (partId) => {
      const state = store.get();
      if (state.route.kind !== "story" || state.story.kind !== "loaded" || state.story.payload.id !== state.route.id) return;
      const storyId = state.story.payload.id;
      const current = state.editor;
      const mode = partId === null ? "first" : "write";
      if (current !== null && current.storyId === storyId && current.mode === mode && current.partId === partId) return;
      let node = null;
      if (partId === null) {
        if (state.story.payload.path.length > 0) return;
      } else {
        const target = openPart(store, partId);
        if (target === null) return;
        if (partSwitchPending(target.story, partId)) {
          pushToast(store, PART_SWITCHING_TOAST);
          return;
        }
        node = target.node;
      }
      if (current !== null && editorDirty(current)) {
        pushToast(store, EDITOR_OPEN_TOAST);
        return;
      }
      openSerial = ++serial;
      store.set((s) => ({ ...s, editor: openEditorState(storyId, mode, node) }));
    },

    setText: (text) => update((editor) => (
      editor.text === text && !editor.discardArmed ? editor : { ...editor, text, discardArmed: false }
    )),

    setInstruction: (instruction) => update((editor) => (
      editor.instruction === instruction && !editor.discardArmed
        ? editor
        : { ...editor, instruction, discardArmed: false }
    )),

    save,

    requestClose: () => {
      const editor = store.get().editor;
      if (editor === null || editor.saving) return;
      if (!editorDirty(editor) || editor.discardArmed) {
        close();
        return;
      }
      update((current) => ({ ...current, discardArmed: true }));
    }
  };
}

function storyNodeIds(state: AppState): readonly string[] {
  return state.story.kind === "loaded" ? state.story.payload.nodes.map((node) => node.id) : [];
}
