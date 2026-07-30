import type { StoryPayload } from "../../shared/types.js";
import { createComposer } from "./composer-model.js";
import { capturePendingDirectDraft } from "./composer-ownership.js";
import { reconcileFactEditor } from "./editor-reconciliation.js";
import { globalEditor } from "./editor-scope.js";
import { boundedFactSelection, factRows } from "./facts-model.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { createPrunePlan, createUnusedTakesPrunePlan } from "./prune-model.js";
import { applyOpeningFocus } from "./reading-position.js";
import { flushReadingPositionPersist } from "./reading-position-persist.js";
import type { RuntimeState } from "./state.js";
import { followStoryViewport } from "./viewport-intent.js";

interface StoryFocus {
  rowId: string | null;
  index: number;
}

/** Capture logical focus before changing the rows beneath it. */
export function captureStoryFocus(state: RuntimeState): StoryFocus {
  const view = createStoryViewModel(state.payload, state.stream);
  return { rowId: view.rows[state.focusIndex]?.id ?? null, index: state.focusIndex };
}

/** Preserve the same logical row when possible; otherwise keep focus valid. */
export function restoreStoryFocus(state: RuntimeState, focus: StoryFocus): ReturnType<typeof createStoryViewModel> {
  const view = createStoryViewModel(state.payload, state.stream);
  const matchingIndex = focus.rowId === null ? -1 : view.rows.findIndex((row) => row.id === focus.rowId);
  state.focusIndex = matchingIndex >= 0
    ? matchingIndex
    : Math.max(0, Math.min(focus.index, view.rows.length - 1));
  return view;
}

/** Adopt an authoritative revision of the open story without reviving the
 * action's launch-time focus. This validity reconciliation is unconditional:
 * later input may move focus, but it may never leave an out-of-range index. */
export function adoptSameStoryPayload(state: RuntimeState, payload: StoryPayload): ReturnType<typeof createStoryViewModel> {
  const focus = captureStoryFocus(state);
  const facts = state.facts;
  const factSelection = facts === null
    ? null
    : boundedFactSelection(state.payload.facts, facts, facts.query);
  const factId = facts === null || factSelection === null
    ? null
    : factRows(state.payload.facts, factSelection.selectedTag, facts.query)[factSelection.cursor]?.id ?? null;
  const commands = state.commands?.view === "tags" ? state.commands : null;
  const tagNodeId = commands === null ? null : state.payload.tags[commands.cursor]?.nodeId ?? null;
  const chapters = state.chapters;
  const chapterRows = chapters === null ? [] : createStoryViewModel(state.payload).chapters;
  const chapter = chapters === null
    ? null
    : chapterRows[Math.max(0, Math.min(chapterRows.length - 1, chapters.cursor))] ?? null;

  state.payload = payload;
  const view = restoreStoryFocus(state, focus);

  if (facts !== null && state.facts === facts) {
    Object.assign(facts, boundedFactSelection(payload.facts, facts, facts.query));
    const rows = factRows(payload.facts, facts.selectedTag, facts.query);
    const preservedIndex = factId === null ? -1 : rows.findIndex((fact) => fact.id === factId);
    if (preservedIndex >= 0) facts.cursor = preservedIndex;
  }
  if (commands !== null && state.commands === commands && commands.view === "tags") {
    const preservedIndex = tagNodeId === null
      ? -1
      : payload.tags.findIndex((tag) => tag.nodeId === tagNodeId);
    commands.cursor = preservedIndex >= 0
      ? preservedIndex
      : Math.min(commands.cursor, Math.max(0, payload.tags.length - 1));
  }
  if (chapters !== null && state.chapters === chapters) {
    const rows = view.chapters;
    const preservedIndex = chapter === null
      ? -1
      : rows.findIndex((candidate) => chapter.openingBreakId === null
        ? candidate.openingBreakId === null
        : candidate.openingBreakId === chapter.openingBreakId);
    chapters.cursor = preservedIndex >= 0
      ? preservedIndex
      : Math.min(chapters.cursor, Math.max(0, rows.length - 1));
  }
  reconcileStoryActions(state, view);
  reconcileMapNavigation(state, payload);
  reconcileStoryBoundIntent(state, view);
  return view;
}

/** Re-anchor an open part menu by semantic identity, or close it if its
 * virtual/real target disappeared underneath the rendered row. */
export function reconcileStoryActions(
  state: RuntimeState,
  view = createStoryViewModel(state.payload, state.stream)
): void {
  const actions = state.actions;
  if (actions === null) return;
  if (rowIndexForNode(view, actions.partId) >= 0) return;
  state.actions = null;
  if (state.mode === "ACTIONS") state.mode = "NAV";
}

/** Keep story-bound navigation and inspection ids aligned with rendered nodes. */
export function reconcileMapNavigation(state: RuntimeState, payload = state.payload): void {
  const nodeIds = new Set(payload.nodes.map(({ id }) => id));
  if (state.stream !== null && !state.stream.append) nodeIds.add(state.stream.targetId);
  state.expandedPromptIds = new Set(
    [...state.expandedPromptIds].filter((nodeId) => nodeIds.has(nodeId))
  );
  const map = state.map;
  if (map === null) return;
  const fallbackId = payload.path.at(-1)?.id ?? null;
  if (fallbackId === null) {
    state.map = null;
    if (state.mode === "MAP") state.mode = "NAV";
    return;
  }
  if (!nodeIds.has(map.pathCursorId)) map.pathCursorId = fallbackId;
  if (map.treeCursorId !== null && !nodeIds.has(map.treeCursorId)) map.treeCursorId = fallbackId;
  map.rowIds = map.rowIds.filter((nodeId) => nodeIds.has(nodeId));
  map.openedColdFolds = new Set(
    [...map.openedColdFolds].filter((nodeId) => nodeIds.has(nodeId))
  );
}

/** Adopt a recovery or forced-replacement snapshot. Same-story interactions
 * are reconciled by semantic target; a different story keeps only safe input. */
export function adoptReconciliationSnapshot(
  state: RuntimeState,
  payload: StoryPayload,
  options: { discardedLibrary?: NonNullable<RuntimeState["library"]> } = {}
): void {
  if (state.payload.id === payload.id) {
    adoptSameStoryPayload(state, payload);
    state.undo = [];
    return;
  }

  const retakePrompt = state.retakePrompt;
  const dormantRetake = state.pendingGenerationDraft?.kind === "retake"
    ? state.pendingGenerationDraft.retakePrompt
    : null;
  const retainedPendingText = state.pendingGenerationDraft?.restored === true
    && state.composer.text === state.pendingGenerationDraft.text
    ? state.pendingGenerationDraft.text
    : null;
  const composer = state.composer;
  const composerScrollTop = state.composerScrollTop;
  // A retake target cannot cross stories. Promote whichever editor is visible
  // to Direct and shelve every other editor buffer in recall history.
  const retakeSession = retakePrompt ?? dormantRetake;
  const shelvedCandidates: Array<string | null> = [state.historyDraft];
  if (retakeSession !== null) {
    shelvedCandidates.push(
      retakeSession.returnState.historyDraft,
      retakeSession.returnState.composer.text,
      retakeSession.composer.text
    );
  }
  const shelvedDrafts = shelvedCandidates.filter((text, index, drafts): text is string =>
    text !== null && text.length > 0 && text !== composer.text && drafts.indexOf(text) === index);
  const mode = state.mode;
  const quitArmed = state.quitArmed;
  const library = mode === "LIBRARY"
    && state.library !== null
    && state.library !== options.discardedLibrary
    ? state.library
    : null;
  const retainedGlobalEditor = globalEditor(state);
  const retainedSettings = mode === "SETTINGS" || retainedGlobalEditor !== null
    ? state.settings
    : null;
  const editorScrollTop = state.editorScrollTop;
  const commands = mode === "COMMANDS" && state.commands?.view === "commands"
    ? state.commands
    : null;

  adoptStoryState(state, payload);
  // Destination story keeps its stored opening focus from adoptStoryState.
  // Reusing the previous story's numeric row index would land on an arbitrary
  // part of an unrelated layout.
  state.composer = composer;
  state.composerScrollTop = composerScrollTop;
  state.pendingGenerationDraft = retainedPendingText === null
    ? null
    : { ...capturePendingDirectDraft(state, retainedPendingText), restored: true };
  if (shelvedDrafts.length > 0) {
    state.history = shelvedDrafts;
    state.historyIndex = state.history.length;
  }
  state.quitArmed = quitArmed;

  if (mode === "COMPOSE") state.mode = "COMPOSE";
  else if (retainedGlobalEditor !== null && retainedSettings !== null) {
    state.settings = retainedSettings;
    state.editor = retainedGlobalEditor;
    state.editorScrollTop = editorScrollTop;
    state.mode = "EDITOR";
  }
  else if (library !== null) {
    const targetId = library.prompt?.kind === "filter"
      ? undefined
      : library.prompt?.targetId;
    if (targetId !== undefined
      && !library.stories.some((story) => story.id === targetId)) {
      library.prompt = null;
    }
    state.library = library;
    state.mode = "LIBRARY";
  } else if (retainedSettings !== null) {
    state.settings = retainedSettings;
    state.mode = "SETTINGS";
  } else if (commands !== null) {
    state.commands = commands;
    state.mode = "COMMANDS";
  } else if (mode === "KEYS") state.mode = "KEYS";
}

/** An authoritative call may settle while local input keeps moving. Revalidate
 * the interaction live at adoption time instead of discarding a newer prompt
 * or leaving a destructive confirmation aimed at vanished state. */
function reconcileStoryBoundIntent(
  state: RuntimeState,
  view: ReturnType<typeof createStoryViewModel>
): void {
  reconcileFactEditor(state);
  const prune = state.prune;
  if (prune?.kind === "subtree") {
    const refreshed = createPrunePlan(state.payload, prune.nodeId);
    if (refreshed === null) state.prune = null;
    else Object.assign(prune, refreshed);
  } else if (prune?.kind === "unused-takes") {
    const refreshed = createUnusedTakesPrunePlan(state.payload);
    if (refreshed === null) state.prune = null;
    else Object.assign(prune, refreshed);
  }

  const tag = state.tag;
  const tagNode = tag === null
    ? null
    : state.payload.nodes.find(({ id }) => id === tag.nodeId) ?? null;
  const existingTag = tag === null
    ? null
    : state.payload.tags.find(({ nodeId }) => nodeId === tag.nodeId) ?? null;
  const tagValid = tag !== null
    && tagNode !== null
    && (tagNode.activeChildId === null || existingTag !== null);
  if (tagValid) {
    tag.existing = existingTag !== null;
    if (tag.returnMode === "MAP" && state.map === null) tag.returnMode = "NAV";
  } else {
    const returnMode = tag?.returnMode ?? "NAV";
    state.tag = null;
    if (state.mode === "TAG") {
      state.mode = returnMode === "MAP" && state.map !== null ? "MAP" : "NAV";
    }
  }

  const breakIds = new Set(state.payload.chapterBreaks.map(({ id }) => id));
  const focusedRow = view.rows[state.focusIndex];
  if (state.chapterDeleteArmedId !== null
    && (focusedRow?.kind !== "chapter-divider" || focusedRow.break.id !== state.chapterDeleteArmedId)) {
    state.chapterDeleteArmedId = null;
  }
  if (state.chapters !== null) {
    const rename = state.chapters.rename;
    if (rename !== null && !breakIds.has(rename.breakId)) {
      state.chapters.rename = null;
    }
    if (state.chapters.deleteArmedId !== null && !breakIds.has(state.chapters.deleteArmedId)) {
      state.chapters.deleteArmedId = null;
    }
  }
  const facts = state.facts;
  if (facts !== null && facts.deleteArmedId !== null
    && !state.payload.facts.some(({ id }) => id === facts.deleteArmedId)) {
    facts.deleteArmedId = null;
  }

  const editor = state.editor;
  if (editor !== null) {
    const target = editor.target;
    const targetExists = (target.kind === "settings-prompt"
        && state.settings === target.owner)
      || (target.kind === "fact" && (target.factId === null
        || state.payload.facts.some(({ id }) => id === target.factId)))
      || (target.kind === "part"
        && state.payload.nodes.some(({ id }) => id === target.node.id))
      || (target.kind === "human-take"
        && state.payload.nodes.some(({ id }) =>
        id === (target.savedNode ?? target.node).id))
      || (target.kind === "chapter-summary"
        && state.payload.nodes.some(({ id }) => id === target.summaryId));
    if (!targetExists) {
      state.editor = null;
      state.editorScrollTop = 0;
      if (state.mode === "EDITOR") {
        state.mode = editor.returnMode === "FACTS" && state.facts !== null
          ? "FACTS"
          : "NAV";
      }
    }
  }
}

/** Replace the authoritative story and discard every interaction frozen
 * against the previous payload. Global visual preferences remain intact. */
export function adoptStoryState(state: RuntimeState, payload: StoryPayload): void {
  // Durably leave the previous story's position before replacing focus.
  flushReadingPositionPersist();
  state.payload = payload;
  state.focusIndex = applyOpeningFocus(payload, state.readingPositions);
  state.mode = payload.path.length === 0 ? "COMPOSE" : "NAV";
  state.composer = createComposer();
  state.editor = null;
  state.retakePrompt = null;
  state.stream = null;
  state.abort = null;
  state.undo = [];
  state.history = [];
  state.historyIndex = 0;
  state.historyDraft = null;
  state.pendingGenerationDraft = null;
  state.composerClaimEpoch += 1;
  state.freshLandedAt = new Map();
  state.map = null;
  state.contextMeterExpanded = false;
  state.prune = null;
  state.tag = null;
  state.chapters = null;
  state.expandedChapterSummaryIds = new Set();
  state.expandedPromptIds = new Set();
  state.chapterDeleteArmedId = null;
  state.actions = null;
  state.library = null;
  state.facts = null;
  state.commands = null;
  state.settings = null;
  state.summary = null;
  state.hitRows = [];
  followStoryViewport(state);
  state.lastViewportStart = 0;
  state.composerScrollTop = 0;
  state.editorScrollTop = 0;
  state.quitArmed = false;
}
