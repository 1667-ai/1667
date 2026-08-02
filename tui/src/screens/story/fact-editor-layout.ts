import { composerPosition } from "../../composer-model.js";
import {
  FACT_ACTIVATION_COMPOSER_SOURCE,
  FACT_BUDGET_COMPOSER_SOURCE,
  FACT_EDITOR_FOOTER,
  FACT_BODY_COMPOSER_SOURCE,
  FACT_KEYS_COMPOSER_SOURCE,
  FACT_PRIORITY_COMPOSER_SOURCE,
  FACT_TAG_COMPOSER_SOURCE,
  factEditorTagLabel
} from "../../fact-editor-policy.js";
import { FACT_EDITOR_ROWS } from "../../fact-editor-rows.js";
import type { ComposerState } from "../../composer-model.js";
import type { FactEditorSession } from "../../state.js";
import {
  renderComposerInput,
  renderComposerLayout,
  type ComposerLayout
} from "./composer.js";
import {
  composerFieldLine
} from "./composer-chrome.js";
import { renderComposerChoiceRow } from "./composer-choice.js";
import { segment, visibleWidth, type FrameLine } from "./frame.js";

interface FactEditorLayoutOptions {
  width: number;
  height: number;
  footerNotice: string | null;
  scrollTop: number;
  narrow: boolean;
}

/** Render the typed tag field as a sibling of the Fact body composer. */
export function renderFactEditorLayout(
  editor: FactEditorSession,
  options: FactEditorLayoutOptions
): ComposerLayout {
  const body = renderComposerLayout({
    composer: editor.composer,
    fullscreen: true,
    terminalWidth: options.width,
    terminalHeight: Math.max(4, options.height - 3),
    measure: options.width,
    title: editor.title,
    footerHints: FACT_EDITOR_FOOTER,
    placeholder: editor.placeholder,
    footerNotice: options.footerNotice,
    scrollTop: options.scrollTop,
    narrow: options.narrow,
    softWrap: true,
    caret: editor.focus === "body" ? "focused" : "none"
  });
  const tagLabel = factEditorTagLabel(editor);
  const tag = editor.focus === "tag"
    ? renderTextInput(editor.tag, true, "tag", "none", body.fieldWidth,
        FACT_TAG_COMPOSER_SOURCE)
    : renderComposerChoiceRow({
        indent: "",
        fieldWidth: body.fieldWidth,
        label: "tag",
        value: tagLabel,
        sourceId: FACT_TAG_COMPOSER_SOURCE,
        sourceStart: tagLabel === editor.tag.text ? 0 : null,
        focused: false
      });
  const activation = renderComposerChoiceRow({
    indent: "",
    fieldWidth: body.fieldWidth,
    label: "activation",
    value: editor.activation,
    sourceId: FACT_ACTIVATION_COMPOSER_SOURCE,
    sourceStart: null,
    focused: editor.focus === "activation"
  });
  const keys = renderTextInput(
    editor.keys,
    editor.focus === "keys",
    "keys",
    "none",
    body.fieldWidth,
    FACT_KEYS_COMPOSER_SOURCE
  );
  const priority = renderComposerChoiceRow({
    indent: "",
    fieldWidth: body.fieldWidth,
    label: "priority",
    value: editor.priority,
    sourceId: FACT_PRIORITY_COMPOSER_SOURCE,
    sourceStart: null,
    focused: editor.focus === "priority"
  });
  const budget = renderTextInput(
    editor.budget,
    editor.focus === "budget",
    "budget",
    "uncapped",
    body.fieldWidth,
    FACT_BUDGET_COMPOSER_SOURCE
  );
  return {
    ...body,
    lines: [
      body.lines[0]!,
      tag,
      activation,
      keys,
      priority,
      budget,
      ...body.lines.slice(1).map((line) =>
        composerSource(line, FACT_BODY_COMPOSER_SOURCE))
    ],
    lineCount: body.lineCount + 5,
    bodyRows: body.bodyRows + 5,
    // Every row but the body sits at its FACT_EDITOR_ROWS index, in the five
    // header lines inserted above; the body's own viewport row shifts down
    // by that same five.
    cursorViewportRow: editor.focus === "body"
      ? body.cursorViewportRow + 5
      : FACT_EDITOR_ROWS.indexOf(editor.focus)
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
  return composerSource(composerFieldLine("", fieldWidth, [
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
  ]), sourceId);
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
