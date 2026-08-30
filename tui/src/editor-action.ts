import { countWords } from "../../shared/story-text.js";
import {
  MAX_AUTHORS_NOTE_CHARS,
  resolveAuthorsNoteDepth
} from "../../shared/authors-note.js";
import {
  FACT_DRAFT_FIELDS,
  factDraftOf,
  type FactDraft
} from "../../shared/fact-draft.js";
import { unicodeScalarLength } from "../../shared/unicode.js";
import type { StoryPayload } from "../../shared/types.js";
import type { AppSource } from "./app.js";
import { isDefinitePlacementFailure } from "./aside-placement.js";
import { handleAuthorsNoteCommand } from "./authors-note-editor-policy.js";
import { recordHumanWords } from "./config.js";
import { parsePartFile, stripGuidance } from "./editor.js";
import { editorBufferAction } from "./editor-buffer-action.js";
import { composerPageRows } from "./composer-viewport.js";
import { composerMotion } from "./composer-motion.js";
import { editorInsertionPolicy } from "./editor-text-insertion.js";
import {
  factEditorChanged,
  factDraftToFactMetadataPatch,
  factDraftToFactPatch,
  factEditorMetadataChanged,
  factEditorSavePayload,
  factEditorStateBodyChanged
} from "./fact-editor-draft.js";
import { blockUncertainFirstTakeRetry } from "./first-take-guard.js";
import {
  factEditorBuffer,
  factEditorComposerForSource,
  handleFactEditorVerticalMove,
  handleFactEditorCommand,
  handleFactEditorHistory
} from "./fact-editor-policy.js";
import type { ResolvedKey } from "./keys.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { rebaseSelectedState } from "./editor-reconciliation.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { storyScalarFieldSpec } from "./story-scalar-fields.js";
import type {
  DocumentEditorSession,
  FactEditorSession,
  InlineEditorTarget,
  RuntimeState
} from "./state.js";
import type { ActionContext } from "./action-context.js";
import { textHash } from "./api.js";
import { findCreatedTake } from "./created-take.js";
import { rememberFocus } from "./reading-position-persist.js";
import { setComposerText } from "./composer-model.js";
import {
  applyWritingPromptDraft,
  settingsDraftChanged
} from "./settings-overlay-model.js";
import { writingPromptFieldDefinitionForRow } from "../../shared/settings-v5-writing.js";
import { toggleFactEditorViewMode } from "./settings-view-mode.js";
import { canonicalFactStates, firstFactText, isFactEndState } from "../../shared/fact-state.js";

export {
  openChapterSummaryEditor,
  openFactEditor,
  openFactStateEditor,
  openFactFromSelection,
  openAuthorsNoteEditor,
  openAuthorBriefEditor,
  openFactsBudgetEditor,
  openPhraseBiasEditor,
  openBannedStringsEditor,
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
  const wheelScroll = resolved.action === "scroll-line-up"
    || resolved.action === "scroll-line-down";
  if (!wheelScroll) state.editorScrollDetached = false;

  if (editor.kind === "fact" && resolved.composerSourceId !== undefined) {
    const source = factEditorComposerForSource(editor, resolved.composerSourceId);
    // Choice rows intentionally have no composer. They are still valid mouse
    // targets because the source lookup sets their focus before this return.
    if (source === null) return;
    if (resolved.action === "compose") return;
  }

  // Author's Note grammar owns the depth control, the same way the Fact
  // header owns its own commands below.
  if (handleAuthorsNoteCommand(resolved, editor)) return;

  if (editor.kind === "fact" && resolved.action === "toggle-view-mode") {
    editor.chromeFocus = "view";
    const next = toggleFactEditorViewMode(state, source);
    state.toast = `${next} Fact fields`;
    return;
  }

  if (editor.kind === "fact" && resolved.action === "open-state-anchor") {
    if (factEditorChanged(editor)) {
      state.toast = "save or cancel this Fact before opening its anchor";
      return;
    }
    const anchor = resolved.rowId ?? editor.stateAnchorPartId ?? undefined;
    if (anchor !== undefined) {
      const view = createStoryViewModel(state.payload);
      const row = rowIndexForNode(view, anchor);
      if (row >= 0) state.focusIndex = row;
      closeInlineEditor(state, editor, "opened Fact state anchor");
    }
    return;
  }
  if (editor.kind === "fact" && resolved.action === "delete-state"
    && editor.stateId !== undefined && editor.stateId !== null
    && editor.stateDeleteArmedId === editor.stateId) {
    if (factEditorChanged(editor)) {
      editor.stateDeleteArmedId = null;
      state.toast = "save or cancel this Fact before deleting its state";
      return;
    }
    if (source.api.deleteFactState === undefined) {
      state.toast = "state deletion requires a newer backend";
      return;
    }
    const stateId = editor.stateId;
    await context.backend.run("deleting Fact state", async (task) => {
      const payload = await source.api.deleteFactState!(task.storyId, editor.target.factId!, stateId);
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload, context.cache);
      closeInlineEditor(state, editor, "Fact state deleted · receipt saved");
    });
    return;
  }

  // Fact header grammar owns its commands; the generic path stays target-agnostic.
  if (editor.kind === "fact" && handleFactEditorCommand(resolved, state, editor)) {
    return;
  }
  if (editor.kind === "fact"
    && handleFactEditorHistory(resolved, state, editor)) {
    return;
  }
  const motion = composerMotion(
    state.config.wordWrap === "on",
    () => Math.max(1, (context.renderer?.width ?? 80) - 4)
  );
  // Wheel input uses the scroll-line vocabulary shared by document viewers.
  // Keep it on the Fact body composer so the fixed header rows never receive
  // focus while the existing composer viewport follows the caret.
  if (editor.kind === "fact"
    && wheelScroll) {
    state.editorScrollTop = Math.max(
      0,
      state.editorScrollTop + (resolved.action === "scroll-line-up" ? -1 : 1)
    );
    state.editorScrollDetached = true;
    return;
  }
  if (editor.kind === "fact"
    && handleFactEditorVerticalMove(
      resolved,
      editor,
      motion,
      state.config.factsViewMode ?? "simple"
    )) {
    return;
  }
  const buffer = editor.kind === "fact" ? factEditorBuffer(editor) : editor;
  const reduceBuffer = () => editorBufferAction(resolved, state, buffer, {
    isCurrent: () => state.mode === "EDITOR" && state.editor === editor,
    ...editorInsertionPolicy(editor),
    motion,
    pageRows: composerPageRows(context.renderer?.height ?? 24, true)
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
  state.textActions = null;
  state.editor = null;
  state.editorScrollTop = 0;
  state.editorScrollDetached = false;
  if (editor.returnMode === "FACTS" && state.facts !== null) {
    state.mode = "FACTS";
  } else if (editor.returnMode === "MAP" && state.map !== null) {
    state.mode = "MAP";
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
    const definition = writingPromptFieldDefinitionForRow(target.row);
    const error = applyWritingPromptDraft(target.owner, definition.field, submitted);
    if (error !== null) {
      state.toast = error;
      return;
    }
    closeInlineEditor(state, editor);
    state.toast = settingsDraftChanged(target.owner)
      ? `${definition.title} updated · s saves settings`
      : `${definition.title} unchanged`;
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
        adoptSameStoryPayload(state, payload, context.cache);
        target.expected = payload.authorsNote ?? "";
        target.expectedDepth = resolveAuthorsNoteDepth(payload.authorsNoteDepth);
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
    if (patch === null) {
      state.toast = "direction marker needs a --- line";
      return;
    }
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
      adoptSameStoryPayload(state, payload, context.cache);
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

  if (target.kind === "human-take" || target.kind === "new-part") {
    const text = stripGuidance(submitted).trim();
    if (text.length === 0) return void (state.toast = "write some prose before saving");
    const firstTake = target.kind === "new-part";
    if (firstTake && target.savedNode === null && blockUncertainFirstTakeRetry(state)) return;
    const firstTakeStoryId = firstTake ? state.payload.id : null;
    try {
      await context.backend.run(firstTake ? "saving first take" : "saving human take", async (task) => {
        const previous = target.savedNode;
        const payload = previous === null
          ? await source.api.createNode(task.storyId, firstTake
            ? { parentId: null, instruction: "", text }
            : { parentId: target.node.parentId, text })
          : await source.api.editNode(task.storyId, previous, { text });
        if (!task.storyCurrent()) return;
        if (firstTake) state.uncertainFirstTakeStoryId = null;
        adoptSameStoryPayload(state, payload, context.cache);
        const landedNode = firstTake
          ? previous === null
            ? payload.path[0]
            : payload.path.find(({ id }) => id === previous.id) ?? { ...previous, text }
          : payload.path[target.pathIndex]
            ?? (previous === null ? undefined : payload.path.find(({ id }) => id === previous.id));
        if (landedNode !== undefined) target.savedNode = landedNode;
        const landedId = landedNode?.id ?? previous?.id
          ?? (firstTake ? undefined : target.node.id);
        if (state.editor === editor && landedId !== undefined) {
          state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), landedId));
          rememberFocus(state, source);
        }
        if (landedId !== undefined) {
          state.freshLandedAt = new Map(state.freshLandedAt).set(landedId, Date.now());
        }
        if (!state.demo) {
          const previousWords = previous === null ? 0 : countWords(previous.text);
          source.config = recordHumanWords(source.config, Math.max(0, countWords(text) - previousWords));
          state.config = source.config;
        }
        settleInlineSave(state, editor, submitted, firstTake ? "first take saved" : "human take saved", true);
      });
    } catch (error) {
      if (firstTake && target.savedNode === null) {
        if (isDefinitePlacementFailure(error)) {
          if (state.uncertainFirstTakeStoryId === firstTakeStoryId) {
            state.uncertainFirstTakeStoryId = null;
          }
        } else {
          state.uncertainFirstTakeStoryId = firstTakeStoryId;
        }
      }
      throw error;
    }
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
      adoptSameStoryPayload(state, payload, context.cache);
      target.expected = text;
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
  const stateMutationAvailable = editor.target.factId !== null
    && (editor.stateCreating === true
      ? source.api.createFactState !== undefined
      : editor.stateId !== undefined && editor.stateId !== null
        && source.api.patchFactState !== undefined);
  if (stateMutationAvailable) {
    await saveFactStateEditor(state, source, context, editor);
    return;
  }
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
  // Keep a FactInput-shaped draft for creation. Ordinary PATCH conversion is
  // centralized with the state-mutation metadata conversion below.
  const submitted = { ...validated.draft, keys: [...validated.draft.keys], secondaryKeys: [...(validated.draft.secondaryKeys ?? [])] };
  const submittedNameText = editor.name?.text ?? "";
  const submittedNameChanged = submittedNameText !== (editor.initialName ?? "");
  const submittedPatch = factDraftToFactPatch(validated.draft, {
    includeName: submittedNameChanged
  });
  const createBody = editor.factAnchorPartId === null || editor.factAnchorPartId === undefined
    ? submitted
    : { ...submitted, anchorPartId: editor.factAnchorPartId };
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
      ? await source.api.createFact(task.storyId, createBody)
      // budgetTokens must travel as an explicit null to clear a previously
      // set cap — an omitted (undefined) field means "leave it alone".
      : await source.api.patchFact(task.storyId, factId, submittedPatch);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload, context.cache);
    if (creating) {
      const created = payload.facts.find((candidate) => {
        const { id, tag, activation, keys, name } = candidate;
        return !previousIds.has(id)
          && (name ?? "") === (submitted.name ?? "")
          && tag === submitted.tag
          && activation === submitted.activation
          && keys.length === submitted.keys.length
          && keys.every((key, index) => key === submitted.keys[index])
          && firstFactText(candidate) === submitted.text;
      })
        ?? payload.facts.find(({ id }) => !previousIds.has(id));
      if (created !== undefined) {
        target.factId = created.id;
        target.base = created;
      }
    } else {
      target.base = payload.facts.find(({ id }) => id === factId) ?? target.base;
    }
    editor.conflict = null;
    if (state.editor !== editor) return;
    const unchanged = editor.tag.text === submittedTagText
      && submittedNameText === (submitted.name ?? "")
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
    editor.initialName = submitted.name ?? null;
    state.toast = `${creating ? "fact created" : "fact saved"} · newer edits kept`;
  });
}

/** Save a branch-scoped state and its Fact metadata through their separate
 * mutation contracts. A multi-state Fact must never send its selected body
 * through `patchFact`, because that endpoint intentionally rejects ambiguous
 * flat text edits. */
async function saveFactStateEditor(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  editor: Extract<DocumentEditorSession, { kind: "fact" }>
): Promise<void> {
  if (!factEditorChanged(editor)) {
    closeInlineEditor(state, editor);
    return;
  }
  if (state.connection.down) {
    disarmEditorConfirmations(editor);
    state.toast = "offline · draft kept until the connection returns";
    return;
  }
  const validated = factEditorSavePayload(editor);
  if (!validated.ok) {
    state.toast = validated.toast;
    return;
  }
  if (!confirmOverwrite(state, editor)) return;
  const target = editor.target;
  const factId = target.factId;
  if (factId === null) return;
  const stateIdBefore = editor.stateId;
  const submittedSnapshot = captureFactEditorSaveSnapshot(editor);
  const submittedStateCreating = submittedSnapshot.stateCreating;
  const bodyChanged = factEditorStateBodyChanged(editor);
  const anchorChanged = editor.stateAnchorPartId !== editor.stateInitialAnchorPartId;
  const metadataChanged = factEditorMetadataChanged(editor);
  const submittedNameChanged = editor.name?.text !== (editor.initialName ?? "");
  await context.backend.run(editor.stateCreating ? "creating Fact state" : "saving Fact state", async (task) => {
    const metadataPatch = metadataChanged
      ? factDraftToFactMetadataPatch(validated.draft, { includeName: submittedNameChanged })
      : undefined;
    const anchorPartId = editor.stateAnchorPartId ?? null;
    let payload = state.payload;
    if (editor.stateCreating) {
      payload = await source.api.createFactState!(task.storyId, factId, editor.stateIsEnd === true
        ? { ends: true, anchorPartId, ...(metadataPatch === undefined ? {} : { metadata: metadataPatch }) }
        : { text: validated.draft.text, anchorPartId, ...(metadataPatch === undefined ? {} : { metadata: metadataPatch }) });
    } else if (bodyChanged || anchorChanged) {
      if (stateIdBefore === undefined || stateIdBefore === null) return;
      payload = await source.api.patchFactState!(task.storyId, factId, stateIdBefore, {
        ...(editor.stateIsEnd === true
          ? bodyChanged ? { ends: true } : {}
          : bodyChanged ? { text: validated.draft.text } : {}),
        ...(anchorChanged ? { anchorPartId } : {}),
        ...(metadataPatch === undefined ? {} : { metadata: metadataPatch })
      });
    } else if (metadataPatch !== undefined) {
      // A state editor that changed only Fact metadata still uses the ordinary
      // Fact PATCH. The state endpoint requires a text, End State, or anchor
      // field; metadata plus a state field stays in the atomic branch above.
      payload = await source.api.patchFact(task.storyId, factId, metadataPatch);
    }
    if (!task.storyCurrent()) return;
    const liveSnapshot = captureFactEditorSaveSnapshot(editor);
    adoptSameStoryPayload(state, payload, context.cache);
    if (!task.storyCurrent()) return;
    if (state.editor !== editor) return;
    // Recovery may rebase an anchor-only or End-state edit while adopting the
    // response because those values are not part of FactDraft equality. Put
    // the live snapshot back before settling, then compare it to what this
    // request submitted.
    if (liveSnapshot.text !== submittedSnapshot.text
      && editor.composer.text !== liveSnapshot.text) {
      setComposerText(editor.composer, liveSnapshot.text);
    }
    if (liveSnapshot.name !== submittedSnapshot.name
      && editor.name !== undefined
      && editor.name.text !== liveSnapshot.name) {
      setComposerText(editor.name, liveSnapshot.name);
    }
    if (liveSnapshot.stateAnchorPartId !== submittedSnapshot.stateAnchorPartId) {
      editor.stateAnchorPartId = liveSnapshot.stateAnchorPartId;
    }
    if (liveSnapshot.stateIsEnd !== submittedSnapshot.stateIsEnd) {
      editor.stateIsEnd = liveSnapshot.stateIsEnd;
    }
    const newerEdits = !factEditorSaveSnapshotsMatch(liveSnapshot, submittedSnapshot);
    const liveStateOverrides = {
      ...(liveSnapshot.stateAnchorPartId === submittedSnapshot.stateAnchorPartId
        ? {} : { anchorPartId: liveSnapshot.stateAnchorPartId }),
      ...(liveSnapshot.stateIsEnd === submittedSnapshot.stateIsEnd
        ? {} : { stateIsEnd: liveSnapshot.stateIsEnd })
    };
    const finalFact = state.payload.facts.find(({ id }) => id === factId);
    if (finalFact !== undefined) {
      editor.target.base = finalFact;
      const finalStates = [...canonicalFactStates(finalFact)];
      const finalState = submittedStateCreating
        ? finalStates.find((candidate) =>
            (candidate.anchorPartId ?? null) === submittedSnapshot.stateAnchorPartId
            && (submittedSnapshot.stateIsEnd
              ? isFactEndState(candidate)
              : !isFactEndState(candidate) && candidate.text === validated.draft.text))
          ?? finalStates[finalStates.length - 1]
        : finalStates.find(({ id }) => id === stateIdBefore);
      const stateSelectionChanged = !submittedStateCreating
        && liveSnapshot.stateId !== submittedSnapshot.stateId;
      const liveSelectedState = stateSelectionChanged
        ? finalStates.find(({ id }) => id === liveSnapshot.stateId)
        : undefined;
      const baselineState = liveSelectedState ?? finalState;
      if (finalState !== undefined && !stateSelectionChanged) {
        rebaseSelectedState(editor, finalFact, finalState, liveStateOverrides);
      } else if (liveSelectedState !== undefined) {
        // A state walk during the request is a newer interaction. Keep that
        // selection, but rebase its baseline onto the authoritative response.
        rebaseSelectedState(editor, finalFact, liveSelectedState, liveStateOverrides);
      }
      const authoritativeDraft = factDraftOf(finalFact);
      editor.initialFact = {
        ...authoritativeDraft,
        text: baselineState === undefined || isFactEndState(baselineState)
          ? ""
          : baselineState.text
      };
      editor.initialName = finalFact.name ?? null;
    }
    editor.stateCreating = false;
    editor.stateDeleteArmedId = null;
    editor.conflict = null;
    if (!newerEdits) {
      closeInlineEditor(state, editor, "Fact state saved");
      return;
    }
    state.toast = "Fact state saved · newer edits kept";
  });
}

type FactEditorRawDraftField<K extends keyof FactDraft> =
  K extends "name" | "tag" | "keys" | "secondaryKeys" | "scanDepth" | "budgetTokens" | "text"
    ? string
    : FactDraft[K];

type FactEditorRawDraftSnapshot = {
  [K in keyof FactDraft]: FactEditorRawDraftField<K>;
};

/** Read every FactDraft field from its live editor buffer. The string-valued
 * rows stay raw so an in-flight edit is detected even when it is not valid. */
const FACT_EDITOR_RAW_FIELDS: {
  [K in keyof FactDraft]: (editor: FactEditorSession) => FactEditorRawDraftField<K>
} = {
  name: (editor) => editor.name?.text ?? "",
  tag: (editor) => editor.tag.text,
  activation: (editor) => editor.activation,
  keys: (editor) => editor.keys.text,
  secondaryKeys: (editor) => editor.secondary.text,
  secondaryMode: (editor) => editor.secondaryMode,
  scanDepth: (editor) => editor.scan.text,
  recursion: (editor) => editor.recursion,
  priority: (editor) => editor.priority,
  budgetTokens: (editor) => editor.budget.text,
  text: (editor) => editor.composer.text
};

interface FactEditorStateSnapshot {
  readonly stateId: string | null;
  readonly stateCreating: boolean;
  readonly stateAnchorPartId: string | null;
  readonly stateIsEnd: boolean;
}

/** State identity and controls are separate from FactDraft because they are
 * editor routing, not Fact metadata. Keep their capture exhaustive too. */
const FACT_EDITOR_STATE_FIELDS: {
  [K in keyof FactEditorStateSnapshot]: (editor: FactEditorSession) => FactEditorStateSnapshot[K]
} = {
  stateId: (editor) => editor.stateId ?? null,
  stateCreating: (editor) => editor.stateCreating === true,
  stateAnchorPartId: (editor) => editor.stateAnchorPartId ?? null,
  stateIsEnd: (editor) => editor.stateIsEnd === true
};

const FACT_EDITOR_STATE_KEYS = Object.keys(
  FACT_EDITOR_STATE_FIELDS
) as Array<keyof FactEditorStateSnapshot>;

type FactEditorSaveSnapshot = FactEditorRawDraftSnapshot & FactEditorStateSnapshot;

function captureFactEditorSaveSnapshot(editor: FactEditorSession): FactEditorSaveSnapshot {
  const draft = Object.fromEntries(
    FACT_DRAFT_FIELDS.map((field) => [field, FACT_EDITOR_RAW_FIELDS[field](editor)])
  ) as FactEditorRawDraftSnapshot;
  const state = Object.fromEntries(
    FACT_EDITOR_STATE_KEYS.map((field) => [field, FACT_EDITOR_STATE_FIELDS[field](editor)])
  ) as unknown as FactEditorStateSnapshot;
  return { ...draft, ...state };
}

function factEditorSaveSnapshotsMatch(
  left: FactEditorSaveSnapshot,
  right: FactEditorSaveSnapshot
): boolean {
  return FACT_DRAFT_FIELDS.every((field) => left[field] === right[field])
    && FACT_EDITOR_STATE_KEYS.every((field) => left[field] === right[field]);
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
      adoptSameStoryPayload(state, payload, context.cache);
      target.expected = options.nextExpected(payload);
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
  editor.composer.cutConfirmation = null;
  if (editor.kind === "fact") {
    if (editor.name !== undefined) editor.name.cutConfirmation = null;
    editor.tag.cutConfirmation = null;
    editor.keys.cutConfirmation = null;
    editor.budget.cutConfirmation = null;
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
