import {
  composerPosition,
  redoComposerEditOwner,
  replaceComposerTextRange,
  resetComposerEditHistory,
  shareComposerEditHistory,
  undoComposerEditOwner,
  type ComposerState
} from "./composer-model.js";
import { FACT_PRIORITIES, FACT_RECURSIONS, FACT_SECONDARY_MODES } from "../../shared/fact-activation.js";
import { graphemeCells } from "./cell-width.js";
import { wrappedComposerLayout } from "./composer-wrapping.js";
import { factEditorTag } from "./fact-editor-draft.js";
import { nextFactEditorRow, type FactEditorRow } from "./fact-editor-rows.js";
import { factTagPresets } from "./facts-model.js";
import type { ResolvedKey } from "./keys.js";
import type { FactEditorSession, RuntimeState } from "./state.js";

export const FACT_EDITOR_FOOTER =
  "tab/shift+tab choose · ctrl+t custom · ctrl+s save · esc cancel";
export const FACT_TAG_COMPOSER_SOURCE = "fact-tag";
export const FACT_ACTIVATION_COMPOSER_SOURCE = "fact-activation";
export const FACT_KEYS_COMPOSER_SOURCE = "fact-keys";
export const FACT_SECONDARY_COMPOSER_SOURCE = "fact-secondary-keys";
export const FACT_MATCH_COMPOSER_SOURCE = "fact-secondary-mode";
export const FACT_SCAN_COMPOSER_SOURCE = "fact-scan-depth";
export const FACT_CHAIN_COMPOSER_SOURCE = "fact-recursion";
export const FACT_PRIORITY_COMPOSER_SOURCE = "fact-priority";
export const FACT_BUDGET_COMPOSER_SOURCE = "fact-budget-tokens";
export const FACT_BODY_COMPOSER_SOURCE = "fact-body";

interface FactEditorRowSpec {
  readonly row: FactEditorRow;
  readonly sourceId: string;
  /** A choice row has no text composer of its own — it borrows a neighbor's
   *  buffer identity only for undo grouping, never for
   *  actual text input, so a click there gets no composer to type into. Only
   *  a "text" row is that buffer's real owner: focusing a "choice" row always
   *  resets the buffer it borrows (see setFactEditorFocus), because a choice
   *  row never has a selection or cut of its own to preserve there. */
  readonly kind: "text" | "choice";
  readonly composer: (editor: FactEditorSession) => ComposerState;
}

/** One entry per FACT_EDITOR_ROWS row, typed as a record so every row has one
 *  — an array looked up with `.find(...)!` let a row be added to
 *  FACT_EDITOR_ROWS without a table entry and fail only at runtime, the
 *  first time focus reached it (issue #281 review finding C). Every "which
 *  buffer backs this row" and "which row does this click source belong to"
 *  lookup derives from here —
 *  see setFactEditorFocus and handleFactEditorHistory below, which used to
 *  re-encode this same mapping by hand. */
const FACT_EDITOR_ROW_TABLE: Record<FactEditorRow, FactEditorRowSpec> = {
  tag: {
    row: "tag", sourceId: FACT_TAG_COMPOSER_SOURCE, kind: "text",
    composer: (editor) => editor.tag
  },
  activation: {
    row: "activation", sourceId: FACT_ACTIVATION_COMPOSER_SOURCE, kind: "choice",
    composer: (editor) => editor.keys
  },
  keys: {
    row: "keys", sourceId: FACT_KEYS_COMPOSER_SOURCE, kind: "text",
    composer: (editor) => editor.keys
  },
  secondary: {
    row: "secondary", sourceId: FACT_SECONDARY_COMPOSER_SOURCE, kind: "text",
    composer: (editor) => editor.secondary
  },
  match: {
    row: "match", sourceId: FACT_MATCH_COMPOSER_SOURCE, kind: "choice",
    composer: (editor) => editor.secondary
  },
  scan: {
    row: "scan", sourceId: FACT_SCAN_COMPOSER_SOURCE, kind: "text",
    composer: (editor) => editor.scan
  },
  chain: {
    row: "chain", sourceId: FACT_CHAIN_COMPOSER_SOURCE, kind: "choice",
    composer: (editor) => editor.scan
  },
  priority: {
    row: "priority", sourceId: FACT_PRIORITY_COMPOSER_SOURCE, kind: "choice",
    composer: (editor) => editor.budget
  },
  budget: {
    row: "budget", sourceId: FACT_BUDGET_COMPOSER_SOURCE, kind: "text",
    composer: (editor) => editor.budget
  },
  body: {
    row: "body", sourceId: FACT_BODY_COMPOSER_SOURCE, kind: "text",
    composer: (editor) => editor.composer
  }
};

const ACTIVATION_TEXT_ACTIONS = new Set<ResolvedKey["action"]>([
  "input", "backspace", "delete-forward", "delete-word-left", "delete-word-right",
  "delete-line", "delete-line-start", "delete-line-end", "paste-clipboard",
  "cut-selection", "select-all", "cursor-word-left", "cursor-word-right",
  "cursor-line-start", "cursor-line-end", "cursor-buffer-start", "cursor-buffer-end",
  "cursor-page-up", "cursor-page-down"
]);

/** Fact-only editor commands. */
export function handleFactEditorCommand(
  resolved: ResolvedKey,
  state: RuntimeState,
  editor: FactEditorSession
): boolean {
  if (resolved.action === "cycle") {
    if (editor.focus === "activation") {
      cycleFactEditorActivation(editor);
      return true;
    }
    if (editor.focus === "priority") {
      cycleFactEditorPriority(editor, resolved.index === -1 ? -1 : 1);
      return true;
    }
    if (editor.focus === "match") {
      cycleSecondaryMode(editor, resolved.index === -1 ? -1 : 1);
      return true;
    }
    if (editor.focus === "chain") {
      cycleRecursion(editor, resolved.index === -1 ? -1 : 1);
      return true;
    }
    // Keys and budget have no presets of their own to tab through — Tab
    // instead skips them to their neighbor, in the same row order the
    // vertical-move handler below navigates by.
    if (["keys", "secondary", "scan", "budget"].includes(editor.focus)) {
      setFactEditorFocus(editor, nextFactEditorRow(editor.focus, resolved.index === -1 ? -1 : 1));
      return true;
    }
    cycleFactEditorTag(state, editor, resolved.index === -1 ? -1 : 1);
    return true;
  }
  if (editor.focus === "activation"
    && handleChoiceRowKeys(resolved, state, "activation", () => cycleFactEditorActivation(editor))) {
    return true;
  }
  if (editor.focus === "priority"
    && handleChoiceRowKeys(resolved, state, "priority", (direction) => cycleFactEditorPriority(editor, direction))) {
    return true;
  }
  if (
    editor.focus === "match"
    && handleChoiceRowKeys(resolved, state, "secondary match", (direction) => cycleSecondaryMode(editor, direction))
  ) {
    return true;
  }
  if (
    editor.focus === "chain"
    && handleChoiceRowKeys(resolved, state, "recursion", (direction) => cycleRecursion(editor, direction))
  ) {
    return true;
  }
  if (resolved.action === "edit-tag") {
    selectFactEditorTag(state, editor);
    return true;
  }
  return false;
}

/** Left/right (and newline, for parity with every other row) cycle a
 *  choice-row value in place; every text-editing gesture is blocked with an
 *  explanation instead of silently doing nothing. Shared by activation and
 *  priority, the editor's two small fixed-option fields. */
function handleChoiceRowKeys(
  resolved: ResolvedKey,
  state: RuntimeState,
  label: string,
  cycle: (direction: -1 | 1) => void
): boolean {
  if (resolved.action === "cursor-left") {
    cycle(-1);
    return true;
  }
  if (resolved.action === "cursor-right" || resolved.action === "newline") {
    cycle(1);
    return true;
  }
  if (ACTIVATION_TEXT_ACTIONS.has(resolved.action)) {
    state.toast = `use left or right to select Fact ${label}`;
    return true;
  }
  return false;
}

/** Tab walks presets and saved custom tags, then returns input to the body. */
export function cycleFactEditorTag(
  state: RuntimeState,
  editor: FactEditorSession,
  direction: -1 | 1
): void {
  disarmFactEditor(editor);
  const current = factEditorTag(editor);
  const options = factTagPresets(state.payload.facts, current);
  const at = Math.max(0, options.indexOf(current));
  replaceTagText(
    editor,
    options[(at + direction + options.length) % options.length] ?? null
  );
  setFactEditorFocus(editor, "body");
}

/** Ctrl+T selects the typed tag field for custom entry. */
export function selectFactEditorTag(
  state: RuntimeState,
  editor: FactEditorSession
): void {
  disarmFactEditor(editor);
  setFactEditorFocus(editor, "tag");
  editor.tag.anchor = 0;
  editor.tag.cursor = tagLength(editor.tag.text);
  state.toast = "type a custom tag · saved tags join this slider";
}

/** Centralize Fact editor focus changes and clear sibling selection/cut
 *  ownership. Iterates FACT_EDITOR_ROW_TABLE's text rows, the buffer-owning
 *  rows, clearing each one's selection and cut-confirmation, except the
 *  buffer the new focus itself owns. A choice row (activation, priority)
 *  never owns a buffer, so focusing one always resets whichever buffer it
 *  borrows: it has no selection or cut of its own there to preserve. */
export function setFactEditorFocus(
  editor: FactEditorSession,
  focus: FactEditorSession["focus"]
): void {
  editor.focus = focus;
  const focusSpec = factEditorRowSpec(focus);
  const focusedComposer = focusSpec.composer(editor);
  for (const spec of Object.values(FACT_EDITOR_ROW_TABLE)) {
    if (spec.kind !== "text") continue;
    if (focusSpec.kind === "text" && spec.composer(editor) === focusedComposer) continue;
    spec.composer(editor).anchor = null;
    spec.composer(editor).cutConfirmation = null;
  }
}

/** Keep the tag, keys, and budget fields on one line. */
export function factEditorInsert(
  editor: FactEditorSession,
  raw: string,
  source: "paste" | "input" | "newline"
): { text: string } | { blocked: string } {
  if (editor.focus === "body") return { text: raw };
  if (editor.focus === "activation") return choiceRowBlocked("activation");
  if (editor.focus === "match") return choiceRowBlocked("secondary match");
  if (editor.focus === "chain") return choiceRowBlocked("recursion");
  if (editor.focus === "priority") {
    return { blocked: "use left or right to select Fact priority" };
  }
  if (source === "newline" || /^[\r\n\u2028\u2029]+$/u.test(raw)) {
    const label = factEditorSingleLineLabel(editor.focus);
    return { blocked: `${label} stay on one line` };
  }
  return {
    text: raw.replace(/[\r\n\u2028\u2029]+/gu, " ")
  };
}

function factEditorSingleLineLabel(focus: FactEditorSession["focus"]): string {
  if (focus === "tag") return "fact tags";
  if (focus === "keys") return "fact keys";
  if (focus === "secondary") return "fact secondary keys";
  if (focus === "scan") return "fact scan depth";
  return "fact budget";
}

function choiceRowBlocked(label: string): { blocked: string } {
  return { blocked: `use left or right to select Fact ${label}` };
}

export function factEditorActiveComposer(
  editor: FactEditorSession
): ComposerState {
  return factEditorRowSpec(editor.focus).composer(editor);
}

/** Resolve generic projected source identity at the Fact editor boundary. */
export function factEditorComposerForSource(
  editor: FactEditorSession,
  sourceId: string | undefined
): ComposerState | null {
  if (sourceId === undefined) return factEditorActiveComposer(editor);
  const spec = Object.values(FACT_EDITOR_ROW_TABLE).find((candidate) => candidate.sourceId === sourceId);
  if (spec === undefined) return null;
  setFactEditorFocus(editor, spec.row);
  // A choice row (activation, priority) has no text composer of its own to
  // offer a click — see FactEditorRowSpec.kind.
  return spec.kind === "choice" ? null : spec.composer(editor);
}

/** Return only a composer that the focused Fact row can edit. */
export function factEditorActiveTextComposer(
  editor: FactEditorSession
): ComposerState | null {
  const spec = factEditorRowSpec(editor.focus);
  return spec.kind === "text" ? spec.composer(editor) : null;
}

function factEditorRowSpec(row: FactEditorRow): FactEditorRowSpec {
  return FACT_EDITOR_ROW_TABLE[row];
}

export function factEditorSelectionMessage(
  kind: "mixed" | "uneditable"
): string {
  return kind === "mixed"
    ? "select the Fact tag, keys, or text"
    : "Fact choices use their row controls";
}

/** Undo and redo follow the shared bounded delta journal. */
export function handleFactEditorHistory(
  resolved: ResolvedKey,
  state: RuntimeState,
  editor: FactEditorSession
): boolean {
  if (resolved.action !== "undo-edit" && resolved.action !== "redo-edit") {
    return false;
  }
  const redo = resolved.action === "redo-edit";
  const owner = redo
    ? redoComposerEditOwner(editor.composer)
    : undoComposerEditOwner(editor.composer);
  if (owner === null) {
    state.toast = redo ? "nothing to redo" : "nothing to undo";
    return true;
  }
  setFactEditorFocus(editor, factEditorRowForComposer(editor, owner));
  disarmFactEditor(editor);
  return true;
}

/** Which row owns `composer` as its buffer — the text row, never a choice
 *  row that only borrows it (see FactEditorRowSpec.kind). `owner` always
 *  comes from one of the four text buffers, so this always finds one; the
 *  fallback exists only to keep the return type total. */
function factEditorRowForComposer(editor: FactEditorSession, owner: ComposerState): FactEditorRow {
  return Object.values(FACT_EDITOR_ROW_TABLE).find(
    (candidate) => candidate.kind === "text" && candidate.composer(editor) === owner
  )?.row ?? "body";
}

/** Link the editable Fact fields to one bounded delta journal. */
export function initializeFactEditorHistory(
  editor: Pick<FactEditorSession, "tag" | "keys" | "secondary" | "scan" | "budget" | "composer">
): void {
  shareComposerEditHistory([editor.tag, editor.keys, editor.secondary, editor.scan, editor.budget, editor.composer]);
}

/** Reset the composite journal after an authoritative buffer replacement. */
export function resetFactEditorHistory(editor: FactEditorSession): void {
  resetComposerEditHistory(editor.tag);
  resetComposerEditHistory(editor.keys);
  resetComposerEditHistory(editor.secondary);
  resetComposerEditHistory(editor.scan);
  resetComposerEditHistory(editor.budget);
  resetComposerEditHistory(editor.composer);
}

/** Return the buffer that owns the focused Fact row. */
export function factEditorBuffer(editor: FactEditorSession): { composer: ComposerState } {
  const spec = factEditorRowSpec(editor.focus);
  return { composer: spec.composer(editor) };
}

/** Move through the Fact fields and the first body visual row. Every row but
 *  the body moves to its FACT_EDITOR_ROWS neighbor, clamped at either end —
 *  the body is multi-line, so it only yields focus on Up from its own first
 *  visual row, and never yields it on Down at all. */
export function handleFactEditorVerticalMove(
  resolved: ResolvedKey,
  editor: FactEditorSession,
  wrapWidth: number
): boolean {
  if (resolved.action !== "cursor-up" && resolved.action !== "cursor-down") {
    return false;
  }
  const direction = resolved.action === "cursor-up" ? -1 : 1;
  if (editor.focus !== "body") {
    setFactEditorFocus(editor, nextFactEditorRow(editor.focus, direction));
    return true;
  }
  const layout = wrappedComposerLayout(editor.composer, wrapWidth);
  if (resolved.action === "cursor-up" && layout.cursorRow === 0) {
    setFactEditorFocus(editor, "budget");
    editor.budget.anchor = null;
    editor.budget.cursor = Math.min(
      tagLength(editor.budget.text),
      composerPosition(editor.composer).column
    );
    return true;
  }
  return false;
}

function cycleFactEditorActivation(editor: FactEditorSession): void {
  disarmFactEditor(editor);
  editor.activation = editor.activation === "always" ? "keyed" : "always";
}

function cycleFactEditorPriority(editor: FactEditorSession, direction: -1 | 1): void {
  disarmFactEditor(editor);
  const at = FACT_PRIORITIES.indexOf(editor.priority);
  editor.priority = FACT_PRIORITIES[(at + direction + FACT_PRIORITIES.length) % FACT_PRIORITIES.length]!;
}

function cycleSecondaryMode(editor: FactEditorSession, direction: -1 | 1): void {
  const at = FACT_SECONDARY_MODES.indexOf(editor.secondaryMode);
  editor.secondaryMode = FACT_SECONDARY_MODES[
    (at + direction + FACT_SECONDARY_MODES.length) % FACT_SECONDARY_MODES.length
  ]!;
}

function cycleRecursion(editor: FactEditorSession, direction: -1 | 1): void {
  const at = FACT_RECURSIONS.indexOf(editor.recursion);
  editor.recursion = FACT_RECURSIONS[
    (at + direction + FACT_RECURSIONS.length) % FACT_RECURSIONS.length
  ]!;
}

function replaceTagText(
  editor: FactEditorSession,
  tag: string | null
): void {
  const text = tag ?? "";
  replaceComposerTextRange(
    editor.tag,
    0,
    tagLength(editor.tag.text),
    text,
    { cursor: tagLength(text), anchor: null }
  );
}

function tagLength(text: string): number {
  return graphemeCells(text).length;
}

function disarmFactEditor(editor: FactEditorSession): void {
  if (editor.conflict !== null) editor.conflict.armed = false;
  // Read FACT_EDITOR_ROW_TABLE so a future text row joins this reset by default.
  for (const spec of Object.values(FACT_EDITOR_ROW_TABLE)) {
    spec.composer(editor).cutConfirmation = null;
  }
}
