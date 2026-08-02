import { countWords } from "../../shared/story-text.js";
import {
  MAX_AUTHORS_NOTE_CHARS,
  resolveAuthorsNoteDepth
} from "../../shared/authors-note.js";
import { unicodeScalarLength } from "../../shared/unicode.js";
import type { StoryPayload } from "../../shared/types.js";
import type { AppSource } from "./app.js";
import { handleAuthorsNoteCommand } from "./authors-note-editor-policy.js";
import { recordHumanWords } from "./config.js";
import { parsePartFile, stripGuidance } from "./editor.js";
import { editorBufferAction } from "./editor-buffer-action.js";
import { editorInsertionPolicy } from "./editor-text-insertion.js";
import { factEditorChanged, factEditorSavePayload } from "./fact-editor-draft.js";
import {
  factEditorBuffer,
  handleFactEditorVerticalMove,
  handleFactEditorCommand,
  handleFactEditorHistory
} from "./fact-editor-policy.js";
import type { ResolvedKey } from "./keys.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { storyScalarFieldSpec } from "./story-scalar-fields.js";
import type { DocumentEditorSession, InlineEditorTarget, RuntimeState } from "./state.js";
import type { ActionContext } from "./action-context.js";
import { textHash } from "./api.js";
import { findCreatedTake } from "./created-take.js";
import { rememberFocus } from "./reading-position-persist.js";
import {
  applySystemPromptDraft,
  settingsDraftChanged
} from "./settings-overlay-model.js";

export {
  openChapterSummaryEditor,
  openFactEditor,
  openFactFromSelection,
  openAuthorsNoteEditor,
  openAuthorBriefEditor,
  openFactsBudgetEditor,
  openPartEditor,
  openSystemPromptEditor
} from "./editor-open.js";

export async function inlineEditorAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const host = state.mode === "EDITOR" ? state.editor : null;
  if (host === null) return;
  const editor = host;

  // Author's Note grammar owns the depth control, the same way the Fact
  // header owns its own commands below.
  if (handleAuthorsNoteCommand(resolved, editor)) return;

  // Fact header grammar owns its commands; the generic path stays target-agnostic.
  if (editor.kind === "fact" && handleFactEditorCommand(resolved, state, editor)) {
    return;
  }
  if (editor.kind === "fact"
    && handleFactEditorHistory(resolved, state, editor)) {
    return;
  }
  const wrapWidth = Math.max(1, (context.renderer?.width ?? 80) - 4);
  if (editor.kind === "fact"
    && handleFactEditorVerticalMove(resolved, editor, wrapWidth)) {
    return;
  }
  const buffer = editor.kind === "fact" ? factEditorBuffer(editor) : editor;
  const reduceBuffer = () => editorBufferAction(resolved, state, buffer, {
    isCurrent: () => state.mode === "EDITOR" && state.editor === editor,
    ...editorInsertionPolicy(editor),
    wrapWidth
  });
  const outcome = await reduceBuffer();
  if (outcome === "cancel") return closeInlineEditor(state, editor);
  if (outcome === "save") {
    await saveInlineEditor(state, source, context, editor, "default");
    return;
  }
  if (outcome === "save-inplace") {
    await saveInlineEditor(state, source, context, editor, "inplace");
  }
}

function closeInlineEditor(
  state: RuntimeState,
  editor: DocumentEditorSession,
  toast?: string
): void {
  if (state.editor !== editor) return;
  state.editor = null;
  state.editorScrollTop = 0;
  if (editor.returnMode === "FACTS" && state.facts !== null) {
    state.mode = "FACTS";
  } else if (editor.returnMode === "SETTINGS"
    && editor.kind === "document"
    && editor.target.kind === "settings-prompt"
    && state.settings === editor.target.owner) {
    if (!settingsDraftChanged(editor.target.owner)) {
      editor.target.owner.conflict = null;
    }
    state.mode = "SETTINGS";
  } else {
    state.mode = "NAV";
  }
  if (toast !== undefined) state.toast = toast;
}

type PartSaveMode = "default" | "inplace";

async function saveInlineEditor(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  editor: DocumentEditorSession,
  partSave: PartSaveMode
): Promise<void> {
  if (editor.kind === "fact") {
    if (partSave === "inplace") {
      state.toast = "same-take save only updates a story part";
      return;
    }
    await saveFactEditor(state, source, context, editor);
    return;
  }
  const submitted = editor.composer.text;
  const target = editor.target;
  if (target.kind === "settings-prompt") {
    if (state.settings !== target.owner) {
      return closeInlineEditor(state, editor);
    }
    applySystemPromptDraft(target.owner, submitted);
    closeInlineEditor(state, editor);
    state.toast = settingsDraftChanged(target.owner)
      ? "system prompt updated · s saves settings"
      : "system prompt unchanged";
    return;
  }
  // A depth draft alone (unchanged text) still has to save.
  const pendingDepthChange = target.kind === "authors-note" && target.depth !== target.expectedDepth;
  if (submitted === editor.initial && editor.conflict === null && !pendingDepthChange) {
    return closeInlineEditor(state, editor);
  }
  if (state.connection.down) {
    disarmEditorConfirmations(editor);
    return void (state.toast = "offline · draft kept until the connection returns");
  }
  if (!confirmOverwrite(state, editor)) return;

  if (target.kind === "authors-note") {
    if (unicodeScalarLength(submitted, MAX_AUTHORS_NOTE_CHARS) > MAX_AUTHORS_NOTE_CHARS) {
      state.toast = "Author's Note must contain at most 4,000 Unicode scalar values.";
      return;
    }
    const requestedDepth = target.depth;
    try {
      await context.backend.run("saving Author's Note", async (task) => {
        const payload = await source.api.setAuthorsNote(task.storyId, submitted, requestedDepth);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload);
        target.expected = payload.authorsNote ?? "";
        target.expectedDepth = resolveAuthorsNoteDepth(payload.authorsNoteDepth);
        context.cache.invalidate();
        settleInlineSave(
          state,
          editor,
          submitted,
          submitted.trim().length === 0 ? "Author's Note cleared" : "Author's Note saved",
          target.depth === requestedDepth
        );
      });
    } catch (error) {
      if (state.editor === editor) {
        state.toast = error instanceof Error ? error.message : String(error);
      }
    }
    return;
  }

  if (target.kind === "story-scalar") {
    const spec = storyScalarFieldSpec(target.field);
    const validated = spec.validate(submitted);
    if (!validated.ok) return void (state.toast = validated.toast);
    await saveScalarFieldEditor(state, context, editor, target, submitted, {
      backendLabel: `saving ${spec.title}`,
      save: (storyId) => spec.save(source.api, storyId, validated.value),
      nextExpected: (payload) => spec.read(payload),
      toast: spec.toast(validated.value)
    });
    return;
  }

  if (target.kind === "part") {
    const patch = parsePartFile(submitted);
    if (patch === null) return void (state.toast = "keep one --- line between direction and prose");
    const text = patch.text.trim();
    // ctrl+s always forks; ctrl+shift+s always overwrites the opened part.
    // Keys keep fixed meaning for the whole session (no sticky save identity).
    const creating = partSave === "default";
    await context.backend.run(creating ? "creating edited take" : "saving edited take", async (task) => {
      const previous = target.node;
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
          // Path may leave the edited take after a concurrent line switch; keep
          // the opened identity with the prose we just wrote (not a NodeStub).
          ?? { ...previous, instruction: patch.instruction, text };
      const landedId = landedNode?.id ?? previous.id;
      if (!creating && landedNode !== undefined) {
        // Keep the source node current so a later fork hashes the latest prose.
        target.node = landedNode;
      }
      if (state.editor === editor) {
        state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), landedId));
        rememberFocus(state, source);
      }
      state.freshLandedAt = new Map(state.freshLandedAt).set(landedId, Date.now());
      if (!state.demo) {
        source.config = recordHumanWords(source.config,
          Math.max(0, countWords(text) - countWords(previous.text)));
        state.config = source.config;
      }
      context.cache.invalidate();
      settleInlineSave(
        state,
        editor,
        submitted,
        creating ? "edited take created" : "take updated in place",
        true
      );
    });
    return;
  }

  if (partSave === "inplace") {
    return void (state.toast = "same-take save only updates a story part");
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
        rememberFocus(state, source);
      }
      state.freshLandedAt = new Map(state.freshLandedAt).set(landedId, Date.now());
      if (!state.demo) {
        const previousWords = previous === null ? 0 : countWords(previous.text);
        source.config = recordHumanWords(source.config, Math.max(0, countWords(text) - previousWords));
        state.config = source.config;
      }
      context.cache.invalidate();
      settleInlineSave(state, editor, submitted, "human take saved", true);
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
      settleInlineSave(
        state, editor, submitted, "summary edited · kept until you re-summarize", true
      );
    });
    return;
  }
}

async function saveFactEditor(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  editor: Extract<DocumentEditorSession, { kind: "fact" }>
): Promise<void> {
  if (!factEditorChanged(editor) && editor.conflict === null) {
    closeInlineEditor(state, editor);
    return;
  }
  if (state.connection.down) {
    disarmEditorConfirmations(editor);
    state.toast = "offline · draft kept until the connection returns";
    return;
  }
  const validated = factEditorSavePayload(editor);
  if (!validated.ok) return void (state.toast = validated.toast);
  if (!confirmOverwrite(state, editor)) return;
  const submitted = {
    tag: validated.draft.tag,
    activation: validated.draft.activation,
    keys: [...validated.draft.keys],
    priority: validated.draft.priority,
    budgetTokens: validated.draft.budgetTokens,
    text: validated.draft.text
  };
  const submittedTagText = editor.tag.text;
  const submittedActivation = editor.activation;
  const submittedKeysText = editor.keys.text;
  const submittedPriority = editor.priority;
  const submittedBudgetText = editor.budget.text;
  const target = editor.target;
  const factId = target.factId;
  const creating = factId === null;
  await context.backend.run(creating ? "creating fact" : "saving fact", async (task) => {
    const previousIds = new Set(state.payload.facts.map(({ id }) => id));
    const payload = creating
      ? await source.api.createFact(task.storyId, submitted)
      // budgetTokens must travel as an explicit null to clear a previously
      // set cap — an omitted (undefined) field means "leave it alone".
      : await source.api.patchFact(task.storyId, factId, { ...submitted, budgetTokens: submitted.budgetTokens ?? null });
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    if (creating) {
      const created = payload.facts.find(({ id, tag, activation, keys, text }) =>
        !previousIds.has(id)
        && tag === submitted.tag
        && activation === submitted.activation
        && keys.length === submitted.keys.length
        && keys.every((key, index) => key === submitted.keys[index])
        && text === submitted.text)
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
    if (state.editor !== editor) return;
    const unchanged = editor.tag.text === submittedTagText
      && editor.activation === submittedActivation
      && editor.keys.text === submittedKeysText
      && editor.priority === submittedPriority
      && editor.budget.text === submittedBudgetText
      && editor.composer.text === submitted.text;
    if (unchanged) {
      closeInlineEditor(state, editor, creating ? "fact created" : "fact saved");
      return;
    }
    editor.initialFact = submitted;
    state.toast = `${creating ? "fact created" : "fact saved"} · newer edits kept`;
  });
}

/** Every field in STORY_SCALAR_FIELDS (see story-scalar-fields.ts) is saved
 *  straight to the story, with no field beyond `expected` to reconcile —
 *  unlike the Author's Note, which also carries a depth. This is their one
 *  shared save path: field-specific validation, parsing, and messaging stay
 *  in the table, but the request/adopt/settle shell is not worth writing out
 *  once per field. An options object rather than a run of positional
 *  parameters, three of them same-typed strings, so a call site cannot
 *  transpose two of them and have the type checker miss it. */
async function saveScalarFieldEditor(
  state: RuntimeState,
  context: ActionContext,
  editor: DocumentEditorSession,
  target: Extract<InlineEditorTarget, { kind: "story-scalar" }>,
  submitted: string,
  options: {
    backendLabel: string;
    save: (storyId: string) => Promise<StoryPayload>;
    nextExpected: (payload: StoryPayload) => string;
    toast: string;
  }
): Promise<void> {
  try {
    await context.backend.run(options.backendLabel, async (task) => {
      const payload = await options.save(task.storyId);
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      target.expected = options.nextExpected(payload);
      context.cache.invalidate();
      settleInlineSave(state, editor, submitted, options.toast, true);
    });
  } catch (error) {
    if (state.editor === editor) {
      state.toast = error instanceof Error ? error.message : String(error);
    }
  }
}

function disarmEditorConfirmations(
  editor: DocumentEditorSession
): void {
  if (editor.conflict !== null) editor.conflict.armed = false;
  editor.cutConfirmation = null;
  if (editor.kind === "fact") {
    editor.tagCutConfirmation = null;
    editor.keysCutConfirmation = null;
    editor.budgetCutConfirmation = null;
  }
}

function confirmOverwrite(
  state: RuntimeState,
  editor: DocumentEditorSession
): boolean {
  const conflict = editor.conflict;
  if (conflict === null || conflict.armed) return true;
  conflict.armed = true;
  const resolution = conflict.resolution === "create" ? "creates a new fact" : "overwrites";
  state.toast = `${conflict.message} · ctrl+s again ${resolution}`;
  return false;
}

/** Close only the exact draft that was acknowledged. Input typed while the
 * request was in flight remains visible and becomes the next save. Every
 * caller states `otherFieldsUnchanged`: a target that carries a field beyond
 * `composer.text` (the Author's Note depth) reports whether that field moved
 * while the request was in flight, so a live edit to it keeps the draft open
 * the same way a live text edit does. It is not defaulted, because a target
 * that gains such a field must not settle wrongly by saying nothing. */
function settleInlineSave(
  state: RuntimeState,
  editor: DocumentEditorSession,
  submitted: string,
  toast: string,
  otherFieldsUnchanged: boolean
): void {
  if (state.editor !== editor) return;
  if (editor.kind === "fact") return;
  if (editor.composer.text === submitted && otherFieldsUnchanged) {
    return closeInlineEditor(state, editor, toast);
  }
  editor.initial = submitted;
  state.toast = `${toast} · newer edits kept`;
}
