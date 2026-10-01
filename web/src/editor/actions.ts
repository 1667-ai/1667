import type { StoryActions } from "../story/actions.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { generationLocks } from "../generation/state.js";
import { STORY_RELOADED_TOAST } from "../story/actions.js";
import { STORY_LOCKED_TOAST } from "../story/part-policy.js";
import { openPart } from "../story/state.js";
import { reconcileEditor, saveEditor, type EditorSaveOutcome, type EditorSaveRequest } from "./save.js";
import { editorDirty, editorPartId, openEditorState, type EditorState } from "./state.js";

export interface EditorActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
}

export type SaveKind = "new" | "in-place";

export interface EditorActions {
  /** `e`: opens the editor on this part. The caller has asked
   * `partActionRefusal` first. */
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
  /** Closes the editor at once, throwing its draft away. */
  discard(): void;
}

export const NOTHING_TO_SAVE_TOAST = "Write some prose before saving.";
export const PART_GONE_TOAST = "This part no longer exists. Copy your text before closing.";
export const PART_OFF_LINE_TOAST = "This part is no longer on the story line. Copy your text before closing.";
export const PART_CHANGED_TOAST = "The part changed in another window. Save again to overwrite.";
export const UNRESOLVED_TOAST =
  "Could not check whether your last save went through. Save again to check; nothing is written twice. Draft kept.";
export const EARLIER_SAVE_LANDED_TOAST =
  "Your earlier save did go through. Your newer changes are still in the editor.";
export const SUMMARY_FORK_TOAST = "A summary can only be saved in place.";

type BuiltSave =
  | { readonly kind: "request"; readonly request: EditorSaveRequest; readonly announcement: string }
  /** Nothing changed: the editor just closes. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly toast: string };

/** Turns the editor's draft into the API request one Save makes — or says why
 * it makes none. Pure: the I/O and the outcome handling are in `save`. */
function buildRequest(editor: EditorState, kind: SaveKind, state: AppState): BuiltSave {
  const text = editor.text.trim();
  const knownNodeIds = new Set(state.story.kind === "loaded" ? state.story.payload.nodes.map((node) => node.id) : []);
  if (editor.mode === "edit") {
    const base = editor.base;
    if (kind === "new" && base.role === "summary") return { kind: "refused", toast: SUMMARY_FORK_TOAST };
    if (text.length === 0) return { kind: "refused", toast: NOTHING_TO_SAVE_TOAST };
    const textChanged = text !== base.text;
    const instructionChanged = editor.instruction !== base.instruction;
    if (!textChanged && !instructionChanged) return { kind: "unchanged" };
    if (kind === "new") {
      return {
        kind: "request",
        announcement: "New take saved.",
        request: { kind: "fork", storyId: editor.storyId, base, instruction: editor.instruction, text, knownNodeIds }
      };
    }
    return {
      kind: "request",
      announcement: "Part updated.",
      request: {
        kind: "in-place",
        storyId: editor.storyId,
        base,
        patch: {
          ...(textChanged ? { text } : {}),
          ...(instructionChanged ? { instruction: editor.instruction } : {})
        }
      }
    };
  }
  if (kind === "in-place") return { kind: "refused", toast: "Only an edited part can be saved in place." };
  if (text.length === 0) return { kind: "refused", toast: NOTHING_TO_SAVE_TOAST };
  return {
    kind: "request",
    announcement: editor.mode === "first" ? "First part saved." : "Your take saved.",
    request: {
      kind: "write",
      storyId: editor.storyId,
      parentId: editor.mode === "first" ? null : editor.base.parentId,
      instruction: "",
      text,
      knownNodeIds
    }
  };
}

export function createEditorActions(store: Store<AppState>, deps: EditorActionDependencies): EditorActions {
  /** Raised for each opened editor, so a late save answer never touches a
   * newer one. */
  let opened = 0;

  const update = (change: (editor: EditorState) => EditorState): void =>
    store.set((state) => {
      if (state.editor === null) return state;
      const next = change(state.editor);
      return next === state.editor ? state : { ...state, editor: next };
    });

  const close = (): void => store.set((state) => (state.editor === null ? state : { ...state, editor: null }));

  /** The one way an editor opens. A changed editor is never replaced, and the
   * same editor opened again keeps its draft. */
  function open(mode: EditorState["mode"], partId: string | null): void {
    const state = store.get();
    if (state.route.kind !== "story" || state.story.kind !== "loaded" || state.story.payload.id !== state.route.id) return;
    const storyId = state.story.payload.id;
    let node = null;
    if (mode === "first") {
      if (state.story.payload.path.length > 0) return;
    } else {
      node = partId === null ? null : openPart(state, partId)?.node ?? null;
      if (node === null) return;
    }
    const current = state.editor;
    if (current !== null && current.storyId === storyId && current.mode === mode && editorPartId(current) === partId) return;
    if (current !== null && editorDirty(current)) return;
    opened += 1;
    store.set((s) => ({ ...s, editor: openEditorState(storyId, mode, node) }));
  }

  async function save(kind: SaveKind): Promise<void> {
    const state = store.get();
    const editor = state.editor;
    if (editor === null || editor.saving) return;
    const built = buildRequest(editor, kind, state);
    if (built.kind === "unchanged") {
      close();
      return;
    }
    if (built.kind === "refused") {
      pushToast(store, built.toast);
      return;
    }
    if (state.connection.kind !== "connected") {
      pushToast(store, "Not connected. Draft kept.");
      return;
    }
    if (generationLocks(state.generation, editor.storyId)) {
      pushToast(store, `${STORY_LOCKED_TOAST} Draft kept.`);
      return;
    }

    const token = opened;
    update((current) => ({ ...current, saving: true, discardArmed: false }));
    const api = state.connection.api;
    let outcome: EditorSaveOutcome;
    if (editor.pending !== null) {
      // An earlier create may have committed. Settle that first: only when it
      // is known to have left nothing behind may this Save create again.
      const settled = await reconcileEditor(api, editor.pending);
      if (opened !== token || store.get().editor === null) return;
      if (settled.kind === "unresolved") {
        update((current) => ({ ...current, saving: false }));
        pushToast(store, UNRESOLVED_TOAST);
        return;
      }
      if (settled.payload !== null) deps.story.adoptPayload(editor.storyId, settled.payload);
      update((current) => ({ ...current, pending: null }));
      if (settled.kind === "saved" && editor.pending.kind !== "in-place" && editor.pending.text !== editor.text.trim()) {
        // It landed, but the writer has typed more since: keep going from the
        // saved part instead of writing the new text beside it.
        const landed = settled.payload.path.find((node) => node.id === settled.landedId) ?? null;
        update((current) => (landed === null
          ? { ...current, saving: false }
          : { ...openEditorState(current.storyId, "edit", landed), text: current.text, instruction: current.instruction }));
        pushToast(store, EARLIER_SAVE_LANDED_TOAST);
        return;
      }
      outcome = settled.kind === "saved" ? settled : await saveEditor(api, built.request);
    } else {
      outcome = await saveEditor(api, built.request);
    }
    const stillOpen = opened === token && store.get().editor !== null;

    if (outcome.kind === "saved") {
      const applied = deps.story.adoptPayload(editor.storyId, outcome.payload, {
        announcement: built.announcement,
        ...(outcome.landedId === null ? {} : { focus: { kind: "part" as const, partId: outcome.landedId } })
      });
      if (!applied) pushToast(store, built.announcement);
      if (stillOpen) close();
      return;
    }

    if (outcome.payload !== null) deps.story.adoptPayload(editor.storyId, outcome.payload);
    if (!stillOpen) return;

    if (outcome.kind === "conflict") {
      if (editor.mode === "edit") {
        const baseId = editor.base.id;
        const rebased = outcome.payload?.path.find((node) => node.id === baseId) ?? null;
        if (rebased === null) {
          const exists = outcome.payload?.nodes.some((node) => node.id === baseId) ?? false;
          pushToast(store, exists ? PART_OFF_LINE_TOAST : PART_GONE_TOAST);
          update((current) => ({ ...current, saving: false }));
          return;
        }
        update((current) => (current.mode === "edit"
          ? { ...current, base: rebased, saving: false, overwriteArmed: true }
          : current));
        pushToast(store, PART_CHANGED_TOAST);
        return;
      }
      update((current) => ({ ...current, saving: false }));
      pushToast(store, `${STORY_RELOADED_TOAST} Draft kept.`);
      return;
    }

    if (outcome.kind === "unresolved") {
      update((current) => ({ ...current, saving: false, pending: built.request }));
      pushToast(store, UNRESOLVED_TOAST);
      return;
    }
    update((current) => ({ ...current, saving: false }));
    pushToast(store, outcome.kind === "failed" ? `${errorMessage(outcome.error)} Draft kept.` : "Draft kept.");
  }

  return {
    openEdit: (partId) => open("edit", partId),
    openWrite: (partId) => open(partId === null ? "first" : "write", partId),

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
    },

    discard: () => {
      const editor = store.get().editor;
      if (editor !== null && !editor.saving) close();
    }
  };
}
