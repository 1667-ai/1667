import type { CommandMatch, CommandPaletteRenderRow } from "../command-model.js";
import { cellPad, cellPadStart } from "./panel-table-layout.js";
import { truncate, type FrameLine, type FrameSegment } from "./story/frame.js";

/** Cells the name column reserves so a long name never touches its description. */
const NAME_GAP = 2;

export function commandPaletteLine(
  row: CommandPaletteRenderRow,
  cursor: number,
  width: number
): FrameLine {
  if (row.kind === "section") return [{
    text: `  ${row.section.label}`,
    role: "accent · deep",
    background: "raised",
    bold: true
  }];
  return commandLine(row.match, row.selectableIndex === cursor, width);
}

function commandLine(match: CommandMatch, selected: boolean, width: number): FrameLine {
  const leadWidth = Math.min(2, width);
  const shortcutWidth = Math.min(6, Math.max(0, width - leadWidth));
  const bodyWidth = Math.max(0, width - leadWidth - shortcutWidth);
  const nameWidth = Math.min(28, bodyWidth);
  const descriptionWidth = Math.max(0, bodyWidth - nameWidth);
  // Two cells of the name column always belong to the gap. A name that filled
  // it ran straight into its own description with no space between them.
  const shownName = cellPad(truncate(match.command.name, Math.max(0, nameWidth - NAME_GAP)), nameWidth);
  const shownDescription = cellPad(match.command.description, descriptionWidth);
  const shownShortcut = cellPadStart(match.command.shortcut ?? "", shortcutWidth);
  const highlighted = new Set(match.indices);
  const line: FrameLine = [commandSegment(" ".repeat(leadWidth), "raised", selected)];
  for (const [index, character] of [...shownName].entries()) {
    line.push(commandSegment(character, highlighted.has(index) ? "focus / accent" : "prose", selected, true));
  }
  line.push(
    commandSegment(shownDescription, "chrome", selected),
    commandSegment(shownShortcut, "chrome", selected)
  );
  return line;
}

function commandSegment(
  text: string,
  role: FrameSegment["role"],
  selected: boolean,
  bold = false
): FrameSegment {
  return {
    text,
    role: selected ? "background" : role,
    background: selected ? "focus / accent" : "raised",
    bold: bold && selected
  };
}
