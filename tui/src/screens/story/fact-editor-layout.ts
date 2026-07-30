import { composerPosition } from "../../composer-model.js";
import {
  FACT_EDITOR_FOOTER,
  FACT_BODY_COMPOSER_SOURCE,
  FACT_TAG_COMPOSER_SOURCE,
  factEditorTagLabel
} from "../../fact-editor-policy.js";
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
    terminalHeight: Math.max(4, options.height - 1),
    measure: options.width,
    title: editor.title,
    footerHints: FACT_EDITOR_FOOTER,
    placeholder: editor.placeholder,
    footerNotice: options.footerNotice,
    scrollTop: options.scrollTop,
    narrow: options.narrow,
    softWrap: true,
    caret: editor.focus === "body" ? "focused" : "unfocused"
  });
  const tagLabel = factEditorTagLabel(editor);
  const tag = editor.focus === "tag"
    ? renderTagInput(editor, body.fieldWidth)
    : renderComposerChoiceRow({
        indent: "",
        fieldWidth: body.fieldWidth,
        label: "tag",
        value: tagLabel,
        sourceId: FACT_TAG_COMPOSER_SOURCE,
        sourceStart: tagLabel === editor.tag.text ? 0 : null
      });
  return {
    ...body,
    lines: [
      body.lines[0]!,
      tag,
      ...body.lines.slice(1).map((line) =>
        composerSource(line, FACT_BODY_COMPOSER_SOURCE))
    ],
    lineCount: body.lineCount + 1,
    bodyRows: body.bodyRows + 1,
    cursorViewportRow: editor.focus === "tag"
      ? 0
      : body.cursorViewportRow + 1
  };
}

function renderTagInput(
  editor: FactEditorSession,
  fieldWidth: number
): FrameLine {
  const prefix = "┃   ";
  const labelWidth = Math.max(
    visibleWidth("tag") + 1,
    Math.min(18, fieldWidth - visibleWidth(prefix) - 1)
  );
  const label = `tag${" ".repeat(Math.max(1, labelWidth - 3))}`;
  const inputWidth = Math.max(
    1,
    fieldWidth - visibleWidth(prefix) - visibleWidth(label) - visibleWidth("[  ]")
  );
  const position = composerPosition(editor.tag);
  return composerSource(composerFieldLine("", fieldWidth, [
    segment("┃ ", "compose accent"),
    segment("  ", "compose accent"),
    segment(label, "chrome"),
    segment("[ ", "focus / accent"),
    ...renderComposerInput(
      editor.tag,
      position.line,
      position.column,
      inputWidth,
      "focused",
      editor.tag.text.length === 0,
      "none"
    ),
    segment(" ]", "focus / accent")
  ]), FACT_TAG_COMPOSER_SOURCE);
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
