import { countWords } from "../../shared/story-text.js";
import type { AppSource } from "./app.js";
import {
  composerSelection,
  insertComposerText,
  redoComposerEdit,
  selectedComposerText,
  undoComposerEdit
} from "./composer-model.js";
import { applyComposerEdit } from "./composer-editing.js";
import { moveComposerVisualVertical } from "./composer-wrapping.js";
import { copyToClipboard, readFromClipboard } from "./clipboard.js";
import { recordHumanWords } from "./config.js";
import { parsePartFile, stripGuidance } from "./editor.js";
import { parseFactEditor } from "./facts-model.js";
import { sanitizePastedText, type ResolvedKey } from "./keys.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import type { InlineEditorSession, RuntimeState } from "./state.js";
import type { ActionContext } from "./action-context.js";
import { textHash } from "./api.js";
import { findCreatedTake } from "./created-take.js";

export {
  openChapterSummaryEditor,
  openFactEditor,
  openFactFromSelection,
  openPartEditor
} from "./editor-open.js";

export async function inlineEditorAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const editor = state.editor;
  if (editor === null) return;
  if (resolved.action === "cancel") return closeInlineEditor(state, editor);
  if (resolved.action === "copy-selection") return await copySelection(state, editor, false);
  if (resolved.action === "cut-selection") return await copySelection(state, editor, true);
  if (resolved.action === "paste-clipboard") {
    const inputClaim = {
      interactionVersion: state.interactionVersion,
      text: editor.composer.text,
      cursor: editor.composer.cursor,
      anchor: editor.composer.anchor
    };
    const text = await readFromClipboard();
    if (state.editor !== editor) return;
    if (state.interactionVersion !== inputClaim.interactionVersion
      || editor.composer.text !== inputClaim.text
      || editor.composer.cursor !== inputClaim.cursor
      || editor.composer.anchor !== inputClaim.anchor) {
      return;
    }
    if (text === null) {
      return void (state.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v");
    }
    const clean = sanitizePastedText(text);
    if (clean.length === 0) return void (state.toast = "clipboard has no insertable text");
    disarmEditorConfirmations(editor);
    insertComposerText(editor.composer, clean);
    return;
  }
  if (resolved.action === "newline") {
    disarmEditorConfirmations(editor);
    return insertComposerText(editor.composer, "\n");
  }
  const wrapWidth = Math.max(1, (context.renderer?.width ?? 80) - 4);
  if (resolved.action === "cursor-up" || resolved.action === "cursor-down") {
    moveComposerVisualVertical(
      editor.composer,
      resolved.action === "cursor-up" ? -1 : 1,
      wrapWidth,
      resolved.extendSelection
    );
    return;
  }
  const kind = applyComposerEdit(
    editor.composer,
    resolved.action,
    resolved.extendSelection
  );
  if (kind !== null) {
    if (kind === "delete") disarmEditorConfirmations(editor);
    return;
  }
  if (resolved.action === "undo-edit" || resolved.action === "redo-edit") {
    const changed = resolved.action === "undo-edit"
      ? undoComposerEdit(editor.composer)
      : redoComposerEdit(editor.composer);
    if (changed) disarmEditorConfirmations(editor);
    else state.toast = resolved.action === "undo-edit" ? "nothing to undo" : "nothing to redo";
    return;
  }
  if (resolved.action === "input") {
    disarmEditorConfirmations(editor);
    return insertComposerText(editor.composer, resolved.text ?? "");
  }
  if (resolved.action === "save-edit") await saveInlineEditor(state, source, context, editor);
}

async function copySelection(
  state: RuntimeState,
  editor: InlineEditorSession,
  cut: boolean
): Promise<void> {
  const selection = composerSelection(editor.composer);
  const text = selectedComposerText(editor.composer);
  if (selection === null || text === null) {
    editor.cutConfirmation = null;
    return void (state.toast = "nothing selected");
  }
  if (!cut) editor.cutConfirmation = null;
  const interactionVersion = state.interactionVersion;
  const outcome = await copyToClipboard(text);
  if (state.editor !== editor || state.interactionVersion !== interactionVersion) return;
  if (outcome === "unavailable") {
    editor.cutConfirmation = null;
    return void (state.toast = "no clipboard available · selection kept");
  }
  if (cut) {
    if (outcome !== "command") {
      const confirmation = editor.cutConfirmation;
      if (confirmation?.start !== selection.start || confirmation.end !== selection.end
        || confirmation.text !== text) {
        editor.cutConfirmation = { ...selection, text };
        state.toast = "clipboard write unconfirmed · ctrl+x again cuts anyway";
        return;
      }
    }
    const current = composerSelection(editor.composer);
    if (current?.start !== selection.start || current.end !== selection.end
      || selectedComposerText(editor.composer) !== text) {
      state.toast = "selection changed · copied without cutting";
      return;
    }
    disarmEditorConfirmations(editor);
    insertComposerText(editor.composer, "");
  }
  editor.cutConfirmation = null;
  state.toast = cut ? "selection cut" : "selection copied";
}

function closeInlineEditor(state: RuntimeState, editor: InlineEditorSession, toast?: string): void {
  if (state.editor !== editor) return;
  state.editor = null;
  state.editorScrollTop = 0;
  state.mode = editor.returnMode === "FACTS" && state.facts !== null
    ? "FACTS"
    : "NAV";
  if (toast !== undefined) state.toast = toast;
}

async function saveInlineEditor(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  editor: InlineEditorSession
): Promise<void> {
  const submitted = editor.composer.text;
  if (submitted === editor.initial && editor.conflict === null) {
    return closeInlineEditor(state, editor, "unchanged · no-op");
  }
  if (state.connection.down) {
    disarmEditorConfirmations(editor);
    return void (state.toast = "offline · draft kept until the connection returns");
  }
  if (!confirmOverwrite(state, editor)) return;

  const target = editor.target;
  if (target.kind === "part") {
    const patch = parsePartFile(submitted);
    if (patch === null) return void (state.toast = "keep one --- line between direction and prose");
    const text = patch.text.trim();
    const creating = target.savedNode === null;
    await context.backend.run(creating ? "creating edited take" : "saving edited take", async (task) => {
      const previous = target.savedNode ?? target.node;
      const knownNodeIds = new Set(state.payload.nodes.map(({ id }) => id));
      const payload = creating
        ? await source.api.createNode(task.storyId, {
          sourceNodeId: target.node.id,
          expectedTextHash: await textHash(target.node.text),
          instruction: patch.instruction,
          text
        })
        : await source.api.editNode(task.storyId, previous, { ...patch, text });
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      const landedNode = creating
        ? findCreatedTake(payload, knownNodeIds, target.node.parentId, patch.instruction, text)
        : payload.path.find(({ id }) => id === previous.id)
          ?? { ...previous, instruction: patch.instruction, text };
      const landedId = landedNode?.id ?? previous.id;
      if (landedNode !== undefined) target.savedNode = landedNode;
      if (state.editor === editor) {
        state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), landedId));
      }
      state.freshLandedAt = new Map(state.freshLandedAt).set(landedId, Date.now());
      if (!state.demo) {
        source.config = recordHumanWords(source.config,
          Math.max(0, countWords(text) - countWords(previous.text)));
        state.config = source.config;
      }
      context.cache.invalidate();
      settleInlineSave(state, editor, submitted, creating ? "edited take created" : "edited take saved");
    });
    return;
  }

  if (target.kind === "human-take") {
    const text = stripGuidance(submitted);
    if (text.trim().length === 0) return void (state.toast = "write some prose before saving");
    await context.backend.run("saving human take", async (task) => {
      const previous = target.savedNode;
      const payload = previous === null
        ? await source.api.createNode(task.storyId, { parentId: target.node.parentId, text })
        : await source.api.editNode(task.storyId, previous, { text });
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      const landedNode = payload.path[target.pathIndex]
        ?? (previous === null ? undefined : payload.path.find(({ id }) => id === previous.id));
      if (landedNode !== undefined) target.savedNode = landedNode;
      const landedId = landedNode?.id ?? previous?.id ?? target.node.id;
      if (state.editor === editor) {
        state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), landedId));
      }
      state.freshLandedAt = new Map(state.freshLandedAt).set(landedId, Date.now());
      if (!state.demo) {
        const previousWords = previous === null ? 0 : countWords(previous.text);
        source.config = recordHumanWords(source.config, Math.max(0, countWords(text) - previousWords));
        state.config = source.config;
      }
      context.cache.invalidate();
      settleInlineSave(state, editor, submitted, "human take saved");
    });
    return;
  }

  if (target.kind === "fact") {
    const parsed = parseFactEditor(submitted);
    if (parsed.text.trim().length === 0) return void (state.toast = "fact text cannot be empty");
    const factId = target.factId;
    const creating = factId === null;
    await context.backend.run(creating ? "creating fact" : "saving fact", async (task) => {
      const previousIds = new Set(state.payload.facts.map(({ id }) => id));
      const payload = creating
        ? await source.api.createFact(task.storyId, parsed)
        : await source.api.patchFact(task.storyId, factId, parsed);
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      if (creating) {
        const created = payload.facts.find(({ id, tag, text }) => !previousIds.has(id)
          && tag === parsed.tag && text === parsed.text)
          ?? payload.facts.find(({ id }) => !previousIds.has(id));
        if (created !== undefined) {
          target.factId = created.id;
          target.base = created;
        }
      } else {
        target.base = payload.facts.find(({ id }) => id === factId) ?? target.base;
      }
      editor.conflict = null;
      context.cache.invalidate();
      settleInlineSave(state, editor, submitted, creating ? "fact created" : "fact saved");
    });
    return;
  }

  if (target.kind === "chapter-summary") {
    const text = stripGuidance(submitted).trim();
    if (text.length === 0) return void (state.toast = "summary cannot be empty");
    await context.backend.run("saving chapter summary", async (task) => {
      const payload = await source.api.editChapterSummary(
        task.storyId, target.summaryId, text, target.expected
      );
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      target.expected = text;
      context.cache.invalidate();
      settleInlineSave(state, editor, submitted, "summary edited · kept until you re-summarize");
    });
    return;
  }
}

function disarmEditorConfirmations(editor: InlineEditorSession): void {
  if (editor.conflict !== null) editor.conflict.armed = false;
  editor.cutConfirmation = null;
}

function confirmOverwrite(state: RuntimeState, editor: InlineEditorSession): boolean {
  const conflict = editor.conflict;
  if (conflict === null || conflict.armed) return true;
  conflict.armed = true;
  const resolution = conflict.resolution === "create" ? "creates a new fact" : "overwrites";
  state.toast = `${conflict.message} · ctrl+s again ${resolution}`;
  return false;
}

/** Close only the exact draft that was acknowledged. Input typed while the
 * request was in flight remains visible and becomes the next save. */
function settleInlineSave(
  state: RuntimeState,
  editor: InlineEditorSession,
  submitted: string,
  toast: string
): void {
  if (state.editor !== editor) return;
  if (editor.composer.text === submitted) return closeInlineEditor(state, editor, toast);
  editor.initial = submitted;
  state.toast = `${toast} · newer edits kept`;
}
