import { factEditorChanged } from "./fact-editor-draft.js";
import { draftImagesFor } from "./draft-image.js";
import { activeSettingsEdit } from "./settings-edit-state.js";
import { settingsDraftChanged } from "./settings-overlay-reconciliation.js";
import { TAG_STATUSES } from "../../shared/types.js";
import type { RuntimeState } from "./state.js";

/** The exact palette object that owns one suspended interaction. */
export type PaletteSession = NonNullable<RuntimeState["commands"]>;
export type PaletteOwnerMode = Exclude<RuntimeState["mode"], "COMMANDS">;

type PaletteSurface = object;

export interface PaletteOwnerSnapshot {
  actions: RuntimeState["actions"];
  textActions: RuntimeState["textActions"];
  prune: RuntimeState["prune"];
  surface: PaletteSurface | null;
}

/** Capture the identity-bearing state that Escape must restore or release. */
export function capturePaletteOwner(
  state: RuntimeState,
  returnMode: RuntimeState["mode"]
): PaletteOwnerSnapshot {
  return {
    actions: state.actions,
    textActions: state.textActions,
    prune: state.prune,
    surface: paletteOwnerSurface(state, returnMode)
  };
}

/** Settings has more than one draft owner, so check all of them together. */
export function settingsPaletteHasUnsavedWork(state: RuntimeState): boolean {
  const overlay = state.settings;
  if (overlay === null) return false;
  const editMode = state.editor?.kind === "document"
    && state.editor.target.kind === "settings-prompt"
    && state.editor.target.owner === overlay
    ? "EDITOR"
    : "SETTINGS";
  const edit = activeSettingsEdit(
    { mode: editMode, editor: state.editor, settings: overlay },
    overlay
  );
  return settingsDraftChanged(overlay)
    || overlay.view.pendingRevision !== null
    || overlay.saveIntent !== undefined
    || overlay.profileTransfer !== null
    || overlay.modelPicker !== null
    || edit !== null && edit.composer.text !== edit.initialText();
}

/** A destination cannot discard unsent input in its suspended owner. */
export function paletteOwnerHasUnsavedInput(
  state: RuntimeState,
  returnMode: RuntimeState["mode"]
): boolean {
  switch (returnMode) {
    case "COMPOSE":
      return state.retakePrompt !== null
        || state.composer.text.length > 0
        || draftImagesFor(state.composer).length > 0;
    case "ASIDE":
      return state.aside?.busy !== true
        && (state.aside?.composer.text.length ?? 0) > 0;
    case "CARD":
      return (state.card?.path.length ?? 0) > 0;
    case "ARCHIVE":
      return (state.archive?.path.length ?? 0) > 0;
    case "IMAGE":
      return (state.image?.path.length ?? 0) > 0;
    case "LIBRARY": {
      const prompt = state.library?.prompt;
      if (prompt?.kind !== "rename") return false;
      const target = state.library?.stories.find((story) => story.id === prompt.targetId);
      return target === undefined
        ? prompt.composer.text.length > 0
        : prompt.composer.text !== target.title;
    }
    case "CHAPTERS": {
      const rename = state.chapters?.rename;
      if (rename === null || rename === undefined) return false;
      const expected = rename.breakId === null
        ? state.payload.firstChapterTitle ?? ""
        : state.payload.chapterBreaks.find(({ id }) => id === rename.breakId)?.title;
      return expected === undefined
        ? rename.composer.text.length > 0
        : rename.composer.text !== expected;
    }
    case "TAG": {
      const prompt = state.tag;
      if (prompt === null) return false;
      // Status selection and delete confirmation are live prompt state, even
      // when the selected value still matches the saved tag.
      if (prompt.choosingStatus || prompt.deleteArmed) return true;
      const existing = state.payload.tags.find(({ nodeId }) => nodeId === prompt.nodeId);
      if (prompt.existing !== (existing !== undefined)) return true;
      if (existing === undefined) {
        return prompt.name.length > 0 || prompt.statusIndex !== 0;
      }
      return prompt.name !== existing.name
        || prompt.statusIndex !== TAG_STATUSES.indexOf(existing.status);
    }
    case "PLACE":
      // Placement keeps the exact Aside surface aside while it owns the
      // screen. Do not release that surface while it has an unsent question.
      return (state.placement?.returnAside.composer.text.length ?? 0) > 0;
    default:
      return false;
  }
}

export function editorHasUnsavedInput(state: RuntimeState): boolean {
  const editor = state.editor;
  if (editor === null) return false;
  if (editor.kind === "fact") return factEditorChanged(editor);
  if (editor.composer.text !== editor.initial) return true;
  return editor.target.kind === "authors-note"
    && editor.target.depth !== editor.target.expectedDepth;
}

/** Clear the transient menus captured by one palette invocation. */
export function clearPaletteOwnerTransients(
  state: RuntimeState,
  returnMode: RuntimeState["mode"],
  owner: PaletteOwnerSnapshot,
  paletteSession: PaletteSession
): boolean {
  // An awaited command may settle after the user opens a new palette over the
  // same owner. The old transition no longer owns cleanup in that session.
  if (state.commands !== null
    && state.commands !== paletteSession
    && state.commands.returnMode === returnMode) return false;
  // ACTIONS is itself the return surface. Read-only commands that leave the
  // mode unchanged must keep its exact owner so Escape can close it normally.
  if (state.actions === owner.actions
    && !(returnMode === "ACTIONS"
      && state.mode === returnMode
      && state.prune === owner.prune)) state.actions = null;
  if (state.textActions === owner.textActions) state.textActions = null;
  if (state.prune === owner.prune) state.prune = null;
  return true;
}

/** Release the suspended owner after a palette destination takes over. */
export function releasePaletteOwner(
  state: RuntimeState,
  returnMode: RuntimeState["mode"],
  owner: PaletteOwnerSnapshot,
  paletteSession: PaletteSession
): void {
  // The request viewer is a read-only child of the exact surface that opened
  // the palette. Keep that owner and all of its transient state until the
  // viewer closes and restores its return mode.
  if (state.mode === "REQUEST" && state.request?.returnMode === returnMode) return;
  if (!clearPaletteOwnerTransients(state, returnMode, owner, paletteSession)) return;
  if (state.mode === returnMode) return;
  // A new Fact opened from the Facts palette is still owned by the same
  // overlay. Keep that exact object so cancel and save return to its context.
  if (returnMode === "FACTS"
    && owner.surface !== null
    && state.facts === owner.surface
    && state.editor?.kind === "fact"
    && state.editor.returnMode === "FACTS") return;
  // Record and Tag are children of MAP. Keep its exact owner while their
  // close action still needs to return to MAP.
  if (returnMode === "MAP"
    && owner.surface !== null
    && state.map === owner.surface
    && ((state.record?.returnMode === "MAP")
      || (state.tag?.returnMode === "MAP")
      || (state.editor?.returnMode === "MAP"))) return;
  // A Settings prompt editor is a child of the captured Settings overlay.
  // Keep that exact owner so the prompt can still save its draft.
  if (returnMode === "SETTINGS"
    && owner.surface !== null
    && state.settings === owner.surface
    && state.editor?.kind === "document"
    && state.editor.target.kind === "settings-prompt"
    && state.editor.target.owner === owner.surface) return;
  switch (returnMode) {
    case "ARCHIVE": if (state.archive === owner.surface) state.archive = null; break;
    case "ASIDE": if (state.aside === owner.surface) state.aside = null; break;
    case "CARD": if (state.card === owner.surface) state.card = null; break;
    case "CHAPTERS": if (state.chapters === owner.surface) state.chapters = null; break;
    case "FACTS": if (state.facts === owner.surface) state.facts = null; break;
    case "IMAGE": if (state.image === owner.surface) state.image = null; break;
    case "LIBRARY": if (state.library === owner.surface) state.library = null; break;
    case "MAP": if (state.map === owner.surface) state.map = null; break;
    case "PROBS": if (state.probs === owner.surface) state.probs = null; break;
    case "RECORD": if (state.record === owner.surface) state.record = null; break;
    case "REQUEST": if (state.request === owner.surface) state.request = null; break;
    case "SEARCH": if (state.search === owner.surface) state.search = null; break;
    case "SETTINGS": if (state.settings === owner.surface) state.settings = null; break;
    case "TAG": if (state.tag === owner.surface) state.tag = null; break;
    case "PLACE": if (state.placement === owner.surface) state.placement = null; break;
    default: break;
  }
}

/** Retarget an exact live palette session without claiming a newer one. */
export function retargetPaletteSession(
  state: Pick<RuntimeState, "commands">,
  paletteSession: PaletteSession,
  returnMode: RuntimeState["mode"]
): boolean {
  if (state.commands !== paletteSession) return false;
  paletteSession.returnMode = returnMode;
  return true;
}

/** Restore one exact palette session after a story replacement. */
export function restorePaletteSession(
  state: Pick<RuntimeState, "commands" | "mode">,
  paletteSession: PaletteSession,
  returnMode: RuntimeState["mode"]
): void {
  paletteSession.returnMode = returnMode;
  state.commands = paletteSession;
  state.mode = "COMMANDS";
}

/** Return the exact live palette that is waiting for one owner to settle. */
export function paletteSessionReturningTo(
  state: Pick<RuntimeState, "mode" | "commands">,
  ownerMode: PaletteOwnerMode
): PaletteSession | null {
  return state.mode === "COMMANDS"
    && state.commands?.returnMode === ownerMode
    ? state.commands
    : null;
}

/** Settle an owner without replacing a matching palette session. */
export function settleModeUnderPalette(
  state: Pick<RuntimeState, "mode" | "commands" | "request">,
  ownerMode: PaletteOwnerMode,
  nextMode: PaletteOwnerMode
): PaletteSession | null {
  const palette = paletteSessionReturningTo(state, ownerMode);
  if (palette !== null) {
    palette.returnMode = nextMode;
    state.mode = "COMMANDS";
    return palette;
  }
  // A request viewer is a read-only child of the same owner, but it removes
  // the palette before the owner can settle. Retarget the viewer instead of
  // sending its visible route to a hidden or already-released owner.
  if (state.mode === "REQUEST" && state.request?.returnMode === ownerMode) {
    state.request.returnMode = nextMode;
    return null;
  }
  state.mode = nextMode;
  return null;
}

function paletteOwnerSurface(
  state: RuntimeState,
  returnMode: RuntimeState["mode"]
): PaletteSurface | null {
  switch (returnMode) {
    case "ARCHIVE": return state.archive;
    case "ASIDE": return state.aside;
    case "CARD": return state.card;
    case "CHAPTERS": return state.chapters;
    case "FACTS": return state.facts;
    case "IMAGE": return state.image ?? null;
    case "LIBRARY": return state.library;
    case "MAP": return state.map;
    case "PROBS": return state.probs;
    case "RECORD": return state.record;
    case "REQUEST": return state.request;
    case "SEARCH": return state.search;
    case "SETTINGS": return state.settings;
    case "TAG": return state.tag;
    case "PLACE": return state.placement;
    default: return null;
  }
}
