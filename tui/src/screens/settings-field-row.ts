import { graphemeCells } from "../cell-width.js";
import { composerPosition } from "../composer-model.js";
import {
  settingsEditDisplayComposer,
  settingsRowHasArrows,
  type SettingsRowPresentation
} from "../settings-overlay-model.js";
import type { OverlayState } from "../state.js";
import { renderComposerInput } from "./story/composer.js";
import {
  truncate,
  visibleWidth,
  type FrameLine
} from "./story/frame.js";
import { raisedSegment } from "./overlay.js";

const SETTINGS_LEAD_WIDTH = 4;
const SETTINGS_LABEL_WIDTH = 20;

interface PaintedSettingsRow {
  readonly line: FrameLine;
  readonly arrows: { readonly previous: number; readonly next: number } | null;
}

/** C-07 field row with the C-08 closed-choice affordance. */
export function settingsFieldRow(
  row: SettingsRowPresentation,
  index: number,
  overlay: NonNullable<OverlayState["settings"]>,
  contentWidth: number
): PaintedSettingsRow {
  const selected = index === overlay.cursor;
  const edit = selected && overlay.edit?.kind === "inline"
    ? overlay.edit
    : null;
  const valueLeft = settingsValueLeft(row.label);
  const valueWidth = Math.max(1, contentWidth - valueLeft);
  const lead = `${selected ? "  ▸ " : "    "}${row.label}`;
  const prefix = raisedSegment(
    lead + " ".repeat(Math.max(0, valueLeft - visibleWidth(lead))),
    selected ? "focus / accent" : "chrome"
  );
  if (edit === null) {
    const drawn = truncate(row.value, valueWidth);
    return {
      line: [
        prefix,
        raisedSegment(drawn, selected ? "focus / accent" : "prose")
      ],
      arrows: settingsRowHasArrows(overlay, row.id)
        ? bracketArrows(drawn, valueLeft)
        : null
    };
  }
  const displayComposer = settingsEditDisplayComposer(edit);
  return {
    line: [
      prefix,
      raisedSegment("[", "chrome"),
      ...renderComposerInput(
        displayComposer,
        0,
        composerPosition(displayComposer).column,
        Math.max(1, valueWidth - 2),
        "streaming",
        false,
        ""
      ),
      raisedSegment("]", "chrome")
    ],
    arrows: null
  };
}

function settingsValueLeft(label: string): number {
  return SETTINGS_LEAD_WIDTH + Math.max(SETTINGS_LABEL_WIDTH, visibleWidth(label) + 1);
}

function bracketArrows(
  drawn: string,
  valueLeft: number
): PaintedSettingsRow["arrows"] {
  const cells = graphemeCells(drawn);
  const opening = cells[0]?.text;
  if (opening !== "‹" && opening !== "[") return null;
  let column = 0;
  for (const cell of cells) {
    if (column > 0 && (cell.text === "›" || cell.text === "]")) {
      return { previous: valueLeft, next: valueLeft + column };
    }
    column += cell.width;
  }
  return null;
}
