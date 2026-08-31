import { MAX_FACT_TEXT_CHARS } from "../../../../shared/types.js";
import {
  canonicalFactStates,
  isFactEndState,
  type FactState
} from "../../../../shared/fact-state.js";
import { unicodeScalarLength } from "../../../../shared/unicode.js";
import { composerPosition } from "../../composer-model.js";
import { factEditorTagLabel } from "../../fact-editor-draft.js";
import {
  FACT_ACTIVATION_COMPOSER_SOURCE,
  FACT_BUDGET_COMPOSER_SOURCE,
  FACT_EDITOR_FOOTER,
  FACT_BODY_COMPOSER_SOURCE,
  FACT_KEYS_COMPOSER_SOURCE,
  FACT_SECONDARY_COMPOSER_SOURCE,
  FACT_MATCH_COMPOSER_SOURCE,
  FACT_SCAN_COMPOSER_SOURCE,
  FACT_CHAIN_COMPOSER_SOURCE,
  FACT_NAME_COMPOSER_SOURCE,
  FACT_SCOPE_COMPOSER_SOURCE,
  FACT_PRIORITY_COMPOSER_SOURCE,
  FACT_TAG_COMPOSER_SOURCE
} from "../../fact-editor-policy.js";
import { factEditorAdvancedPinned, factEditorVisibleRows } from "../../fact-editor-rows.js";
import type { ComposerState } from "../../composer-model.js";
import type { FactEditorSession } from "../../state.js";
import { wrapText } from "../../wrap.js";
import {
  renderComposerInput,
  renderComposerLayout,
  type ComposerLayout
} from "./composer.js";
import {
  composerFieldLine,
  type ComposerStatus
} from "./composer-chrome.js";
import { renderComposerChoiceRow } from "./composer-choice.js";
import { hintItem, segment, visibleWidth, type FrameLine } from "./frame.js";

interface FactEditorLayoutOptions {
  width: number;
  height: number;
  footerNotice: string | null;
  scrollTop: number;
  narrow: boolean;
  softWrap: boolean;
  followCursor: boolean;
  viewMode?: "simple" | "advanced";
}

/** Render the typed tag field as a sibling of the Fact body composer. */
export function renderFactEditorLayout(
  editor: FactEditorSession,
  options: FactEditorLayoutOptions
): ComposerLayout {
  const hasName = editor.name !== undefined;
  const viewMode = options.viewMode ?? "advanced";
  const creatingFact = editor.target.factId === null && editor.stateCreating !== true;
  const visibleRows = factEditorVisibleRows(editor, viewMode, creatingFact)
    .filter((row) => row !== "name" || hasName);
  const scopeLine = creatingFact ? factEditorScopeLine(editor, options.width) : null;
  const showAdvanced = visibleRows.includes("activation");
  const states = editor.target.base === null
    ? []
    : [...canonicalFactStates(editor.target.base)];
  const stateLine = factEditorStateLine(editor, states);
  const advancedPinned = viewMode === "simple" && factEditorAdvancedPinned(editor);
  const helpTarget = factEditorHelpTarget(editor);
  const helpLines = factEditorHelpLines(editor, helpTarget, options.width);
  const headerRows = 1 + (hasName ? 1 : 0) + (scopeLine === null ? 0 : 1) + (showAdvanced ? 8 : 0)
    + (stateLine === null ? 0 : 1) + helpLines.length;
  const body = renderComposerLayout({
    composer: editor.composer,
    fullscreen: true,
    terminalWidth: options.width,
    // The header rows below are inserted above the body, so the body composer
    // must lay out against the height that is left. A smaller reservation
    // scrolls the body against rows the terminal never shows, which puts the
    // cursor below the bottom of the screen.
    terminalHeight: Math.max(4, options.height - headerRows),
    measure: options.width,
    title: editor.title,
    footerHints: FACT_EDITOR_FOOTER,
    footerActions: factEditorFooterActions(viewMode),
    placeholder: editor.placeholder,
    footerNotice: options.footerNotice,
    scrollTop: options.scrollTop,
    followCursor: options.followCursor,
    narrow: options.narrow,
    softWrap: options.softWrap,
    caret: editor.focus === "body" ? "focused" : "none",
    status: factTextCounterStatus(editor.composer.text)
  });
  const name = hasName
    ? renderTextInput(editor.name!, editor.focus === "name", "name", "optional", body.fieldWidth, FACT_NAME_COMPOSER_SOURCE)
    : null;
  const scope = scopeLine;
  const tagLabel = factEditorTagLabel(editor);
  const viewHeader: FrameLine = [segment(
    `┃   ${showAdvanced ? "▾ advanced" : "▸ advanced"}${advancedPinned ? " ·" : ""}`,
    editor.chromeFocus === "view" ? "focus / accent" : "chrome",
    { kind: "action", action: "toggle-view-mode" }
  )];
  const tag = editor.focus === "tag"
    ? renderTextInput(editor.tag, true, "tag", "none", body.fieldWidth,
        FACT_TAG_COMPOSER_SOURCE)
    : composerHitSource(renderComposerChoiceRow({
        indent: "",
        fieldWidth: body.fieldWidth,
        label: "tag",
        value: tagLabel,
        sourceId: FACT_TAG_COMPOSER_SOURCE,
        sourceStart: tagLabel === editor.tag.text ? 0 : null,
        focused: false
      }), FACT_TAG_COMPOSER_SOURCE, true);
  const activation = composerHitSource(renderComposerChoiceRow({
    indent: "",
    fieldWidth: body.fieldWidth,
    label: "activation",
    value: editor.activation,
    sourceId: FACT_ACTIVATION_COMPOSER_SOURCE,
    sourceStart: null,
    focused: editor.focus === "activation"
  }), FACT_ACTIVATION_COMPOSER_SOURCE, false);
  const keys = renderTextInput(
    editor.keys,
    editor.focus === "keys",
    "keys",
    "none",
    body.fieldWidth,
    FACT_KEYS_COMPOSER_SOURCE
  );
  const secondary = renderTextInput(editor.secondary, editor.focus === "secondary", "secondary", "none", body.fieldWidth, FACT_SECONDARY_COMPOSER_SOURCE);
  const match = composerHitSource(renderComposerChoiceRow({ indent: "", fieldWidth: body.fieldWidth, label: "match", value: editor.secondaryMode, sourceId: FACT_MATCH_COMPOSER_SOURCE, sourceStart: null, focused: editor.focus === "match" }), FACT_MATCH_COMPOSER_SOURCE, false);
  const scan = renderTextInput(editor.scan, editor.focus === "scan", "scan", "default 3", body.fieldWidth, FACT_SCAN_COMPOSER_SOURCE);
  const chain = composerHitSource(renderComposerChoiceRow({ indent: "", fieldWidth: body.fieldWidth, label: "chain", value: editor.recursion, sourceId: FACT_CHAIN_COMPOSER_SOURCE, sourceStart: null, focused: editor.focus === "chain" }), FACT_CHAIN_COMPOSER_SOURCE, false);
  const priority = composerHitSource(renderComposerChoiceRow({
    indent: "",
    fieldWidth: body.fieldWidth,
    label: "priority",
    value: editor.priority,
    sourceId: FACT_PRIORITY_COMPOSER_SOURCE,
    sourceStart: null,
    focused: editor.focus === "priority"
  }), FACT_PRIORITY_COMPOSER_SOURCE, false);
  const budget = renderTextInput(
    editor.budget,
    editor.focus === "budget",
    "budget",
    "uncapped",
    body.fieldWidth,
    FACT_BUDGET_COMPOSER_SOURCE
  );
  const withHelp = (line: FrameLine, target: FactEditorHelpTarget): FrameLine[] => [
    line,
    ...(helpTarget === target ? helpLines : [])
  ];
  const header: FrameLine[] = [
    ...withHelp(viewHeader, "view"),
    ...(name === null ? [] : withHelp(name, "name")),
    ...withHelp(tag, "tag"),
    ...(scope === null ? [] : withHelp(scope, "scope")),
    ...(showAdvanced
      ? [
          ...withHelp(activation, "activation"),
          ...withHelp(keys, "keys"),
          ...withHelp(secondary, "secondary"),
          ...withHelp(match, "match"),
          ...withHelp(scan, "scan"),
          ...withHelp(chain, "chain"),
          ...withHelp(priority, "priority"),
          ...withHelp(budget, "budget")
        ]
      : []),
    ...(stateLine === null ? [] : withHelp(stateLine, "state")),
    ...(helpTarget === "body" ? helpLines : [])
  ];
  return {
    ...body,
    lines: [
      body.lines[0]!,
      ...header,
      ...body.lines.slice(1).map((line, index) => {
        const sourced = composerSource(line, FACT_BODY_COMPOSER_SOURCE);
        return index < body.bodyRows
          ? composerHitSource(sourced, FACT_BODY_COMPOSER_SOURCE, true)
          : sourced;
      })
    ],
    lineCount: body.lineCount + headerRows,
    bodyRows: body.bodyRows + headerRows,
    // Every row but the body sits at its FACT_EDITOR_ROWS index, in the
    // header lines inserted above; the body's own viewport row shifts down
    // same number of inserted header rows.
    cursorViewportRow: editor.chromeFocus === "view"
      ? 0
      : editor.chromeFocus === "state" && stateLine !== null
        ? 1 + (hasName ? 1 : 0) + (scopeLine === null ? 0 : 1) + (showAdvanced ? 8 : 0)
        : editor.focus === "body"
          ? body.cursorViewportRow + headerRows
          : Math.max(0, visibleRows.indexOf(editor.focus)) + 1
  };
}

function factEditorScopeLine(editor: FactEditorSession, fieldWidth: number): FrameLine {
  const scoped = editor.factAnchorPartId !== null && editor.factAnchorPartId !== undefined;
  const line = composerHitSource(renderComposerChoiceRow({
    indent: "",
    fieldWidth,
    label: "scope",
    value: scoped ? "from here on ◆" : "the whole story",
    sourceId: FACT_SCOPE_COMPOSER_SOURCE,
    sourceStart: null,
    focused: editor.chromeFocus === "scope"
  }), FACT_SCOPE_COMPOSER_SOURCE, false);
  return line.map((part) => ({
    ...part,
    hit: part.hit ?? { kind: "action", action: "cycle-fact-scope" }
  }));
}

type FactEditorHelpTarget = "view" | "name" | "tag" | "scope" | "activation"
  | "keys" | "secondary" | "match" | "scan" | "chain" | "priority" | "budget"
  | "state" | "body";

function factEditorHelpTarget(editor: FactEditorSession): FactEditorHelpTarget {
  if (editor.chromeFocus === "view") return "view";
  if (editor.chromeFocus === "state") return "state";
  if (editor.chromeFocus === "scope") return "scope";
  return editor.focus;
}

/** Show one short, selected-row explanation. The note uses the same visual
 * treatment as Settings so every Fact option has a plain-English answer. */
function factEditorHelpLines(
  editor: FactEditorSession,
  target: FactEditorHelpTarget,
  width: number
): FrameLine[] {
  const inset = visibleWidth("┃     · ");
  const measure = Math.max(1, width - inset - 1);
  return wrapText(factEditorHelpText(editor, target), [], measure).map(({ text }) => [
    segment("┃     ", "chrome"),
    segment(`· ${text}`, "context note")
  ]);
}

function factEditorHelpText(
  editor: FactEditorSession,
  target: FactEditorHelpTarget
): string {
  if (target === "view") return "Show the controls that decide when and where this Fact is used.";
  if (target === "name") return "Optional name shown in the Facts list.";
  if (target === "tag") return "Groups similar Facts together.";
  if (target === "scope") return "Choose whether this Fact applies everywhere or starts from this story part.";
  if (target === "activation") {
    return editor.activation === "always"
      ? "Always sends this Fact when a request is made."
      : "Sends this Fact only when its keys match the story.";
  }
  if (target === "keys") return "Words or phrases that activate a keyed Fact. Separate entries with commas.";
  if (target === "secondary") return "An optional second key list for the match rule below.";
  if (target === "match") {
    return editor.secondaryMode === "not"
      ? "Needs a primary key and no matching secondary key."
      : "Needs one primary key and one secondary key.";
  }
  if (target === "scan") return "How many recent story parts to check. Empty uses three parts.";
  if (target === "chain") return "Let this Fact activate other keyed Facts.";
  if (target === "priority") return "When the request is full, low priority Facts drop first.";
  if (target === "budget") return "Optional token limit for this Fact. Empty means no limit.";
  if (target === "body") return "Write the names, places, items, or rules the provider should remember.";
  if (editor.stateCreating) return "New state starts at the story cursor. Type its text, then save.";
  return "A state keeps one Fact text at a story point. Add one here or move the selected state here.";
}

function factEditorStateLine(
  editor: FactEditorSession,
  states: readonly FactState[]
): FrameLine | null {
  const stateful = editor.stateCreating === true || editor.target.base !== null;
  if (!stateful) return null;
  const selected = editor.stateIndex ?? 0;
  const controls: FrameLine = [segment(
    "┃   states ",
    editor.chromeFocus === "state" ? "focus / accent" : "chrome"
  )];
  if (editor.stateCreating) {
    controls.push(segment("[new]", "focus / accent"));
  } else {
    states.forEach((state, index) => {
      const marker = isFactEndState(state) ? " ✕" : state.anchorPartId === undefined ? "" : " ◆";
      controls.push(segment(
        `${index === selected ? "▸" : ""}[${index + 1}${marker}]`,
        index === selected ? "focus / accent" : "chrome",
        { kind: "action", action: "cycle-state", index, rowId: state.id }
      ));
      if (index < states.length - 1) controls.push(segment(" ", "chrome"));
    });
  }
  if (editor.stateId !== undefined && editor.stateId !== null) {
    const anchor = editor.stateAnchorPartId;
    if (anchor !== null && anchor !== undefined) {
      controls.push(segment(" · ↵ anchor", "chrome", {
        kind: "action", action: "open-state-anchor", rowId: anchor
      }));
    }
  }
  if (editor.target.factId !== null
    && editor.stateCursorAnchorId !== undefined && editor.stateCursorAnchorId !== null) {
    if (!editor.stateCreating) {
      controls.push(segment(" · s add state here ◆", "chrome", {
        kind: "action", action: "new-state"
      }));
    }
    controls.push(segment(" · a move here ◆", "chrome", {
      kind: "action", action: "reanchor-state", rowId: editor.stateCursorAnchorId
    }));
  }
  if (editor.stateId !== undefined && editor.stateId !== null) {
    controls.push(segment(` · ${editor.stateIsEnd === true ? "convert text" : "convert ✕"}`, "chrome", {
      kind: "action", action: "convert-state", rowId: editor.stateId
    }));
    controls.push(segment(" · delete", editor.stateDeleteArmedId === editor.stateId ? "danger text" : "chrome", {
      kind: "action", action: "delete-state", rowId: editor.stateId
    }));
  }
  return controls;
}

function factEditorFooterActions(viewMode: "simple" | "advanced") {
  return [
    hintItem([segment("tab choose", "chrome", { kind: "action", action: "cycle" })]),
    hintItem([segment("ctrl+t tag", "chrome", { kind: "action", action: "edit-tag" })], 1),
    hintItem([segment(`m ${viewMode === "simple" ? "advanced" : "simple"}`, "chrome", {
      kind: "action",
      action: "toggle-view-mode"
    })], 1),
    hintItem([segment("ctrl+s save", "chrome", { kind: "action", action: "save-edit" })], 1),
    hintItem([segment("esc cancel", "chrome", { kind: "action", action: "cancel" })])
  ];
}

/** Only the "context warning" (≥80%) and "danger text" (at/over the limit)
 *  bands of `contextSeverity` (rail.ts) apply here — below that a Fact is
 *  nowhere near its own ceiling, and the top rule stays quiet the same way a
 *  fullscreen composer already shows no status by default. The `.length`
 *  check first is a cheap lower bound (UTF-16 length never undercounts
 *  Unicode scalars), so an ordinary small Fact never pays for the exact scan. */
const FACT_TEXT_COUNTER_WARNING_FILL = 0.8;

function factTextCounterStatus(text: string): ComposerStatus | undefined {
  const warningFloor = Math.ceil(MAX_FACT_TEXT_CHARS * FACT_TEXT_COUNTER_WARNING_FILL);
  if (text.length < warningFloor) return undefined;
  const count = unicodeScalarLength(text);
  if (count < warningFloor) return undefined;
  return {
    text: `${count.toLocaleString()} / ${MAX_FACT_TEXT_CHARS.toLocaleString()} chars`,
    role: count >= MAX_FACT_TEXT_CHARS ? "danger text" : "context warning"
  };
}

function renderTextInput(
  composer: ComposerState,
  focused: boolean,
  fieldName: string,
  placeholder: string,
  fieldWidth: number,
  sourceId: string
): FrameLine {
  const prefix = "┃   ";
  const labelWidth = Math.max(
    visibleWidth(fieldName) + 1,
    Math.min(18, fieldWidth - visibleWidth(prefix) - 1)
  );
  const label = `${fieldName}${" ".repeat(Math.max(
    1,
    labelWidth - visibleWidth(fieldName)
  ))}`;
  const inputWidth = Math.max(
    1,
    fieldWidth - visibleWidth(prefix) - visibleWidth(label) - visibleWidth("[  ]")
  );
  const position = composerPosition(composer);
  return composerHitSource(composerSource(composerFieldLine("", fieldWidth, [
    segment("┃ ", "compose accent"),
    segment(focused ? "▸ " : "  ", "focus / accent"),
    segment(label, focused ? "prose" : "chrome"),
    segment("[ ", focused ? "focus / accent" : "chrome"),
    ...renderComposerInput(
      composer,
      position.line,
      position.column,
      inputWidth,
      focused ? "focused" : "none",
      composer.text.length === 0,
      placeholder
    ),
    segment(" ]", focused ? "focus / accent" : "chrome")
  ]), sourceId), sourceId, true);
}

function composerHitSource(
  line: FrameLine,
  sourceId: string,
  editable: boolean
): FrameLine {
  return line.map((part) => ({
    ...part,
    composerHitSource: { id: sourceId, editable }
  }));
}

function composerSource(
  line: FrameLine,
  sourceId: string
): FrameLine {
  return line.map((part) => part.composerStart === undefined
    ? part
    : {
        ...part,
        composerSource: { id: sourceId, editable: true }
      });
}
