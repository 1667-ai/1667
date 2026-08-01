import {
  boundedModelPickerCursor,
  modelPickerRows
} from "../settings-model-picker.js";
import { settingsModelChoices } from "../settings-model-discovery.js";
import { settingsModelDisplayText } from "../settings-profile-controls.js";
import type { SettingsOverlayState } from "../state.js";
import { raisedSegment } from "./overlay.js";
import type { SettingsFormRow } from "./settings-form.js";
import {
  truncate,
  TYPING_CARET,
  visibleWidth,
  type FrameLine
} from "./story/frame.js";

export interface ModelOptionColumn {
  /** Chrome above the column: the live query and the match count. It never
   *  scrolls, so a long list cannot hide what was typed. */
  readonly filter: FrameLine;
  readonly choices: SettingsFormRow[];
}

/** C-15 · option column: more than eight options, each with a description, so
 *  it owns `↑↓` and replaces the field list rather than sharing a surface with
 *  it. Typing narrows it live, the way the palette narrows commands. */
export function modelPickerColumn(
  overlay: SettingsOverlayState,
  picker: NonNullable<SettingsOverlayState["modelPicker"]>,
  contentWidth: number
): ModelOptionColumn {
  const rows = modelPickerRows(overlay, picker.query);
  // One stop past the choices: `use what you typed`. The reducer counts the
  // same way, or the highlight and `↵` would disagree about the selection.
  const cursor = boundedModelPickerCursor(picker.cursor, rows.length + 1);
  const nameWidth = Math.min(32, Math.max(8, Math.floor(contentWidth / 2)));
  const filter: FrameLine = [
    raisedSegment("  › model: ", "accent · deep"),
    raisedSegment(picker.query, "streaming"),
    raisedSegment(TYPING_CARET, "focus / accent"),
    raisedSegment(`  ${rows.length} of ${settingsModelChoices(overlay).length}`, "chrome")
  ];
  const painted: SettingsFormRow[] = [];
  for (const [index, choice] of rows.entries()) {
    const selected = index === cursor;
    painted.push({
      line: [
        raisedSegment(selected ? "  ▸ " : "    ", selected ? "focus / accent" : "chrome"),
        raisedSegment(pad(truncate(settingsModelDisplayText(choice.name), nameWidth), nameWidth),
          selected ? "prose" : "prose · dim"),
        raisedSegment(truncate(settingsModelDisplayText(choice.remoteId),
          Math.max(0, contentWidth - nameWidth - 6)), "chrome")
      ],
      target: { kind: "list", index, selected },
      overrides: []
    });
  }
  // The last stop is always the typed identifier, so a name the provider never
  // listed — or one that merely prefixes a name it did — stays reachable.
  const typed = picker.query.trim();
  const selected = cursor === rows.length;
  painted.push({
    line: [
      raisedSegment(selected ? "  ▸ " : "    ", selected ? "focus / accent" : "chrome"),
      raisedSegment(typed.length === 0
        ? "type an identifier this provider did not list"
        : `use “${settingsModelDisplayText(typed)}” as typed`,
      selected ? "prose" : "prose · dim")
    ],
    target: { kind: "list", index: rows.length, selected },
    overrides: []
  });
  return { filter, choices: painted };
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
