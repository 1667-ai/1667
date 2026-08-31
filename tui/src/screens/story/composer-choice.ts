import { composerFieldLine } from "./composer-chrome.js";
import {
  segment,
  truncate,
  visibleWidth,
  type FrameLine
} from "./frame.js";

export function renderComposerChoiceRow(options: {
  indent: string;
  fieldWidth: number;
  label: string;
  value: string;
  sourceId: string;
  sourceStart: number | null;
  /** C-07: rest is a dim label with chrome chevrons; focused lifts both. */
  focused: boolean;
}): FrameLine {
  const prefixWidth = visibleWidth("┃   ");
  const labelWidth = Math.max(
    visibleWidth(options.label) + 1,
    Math.min(18, options.fieldWidth - prefixWidth - 1)
  );
  const label = options.label
    + " ".repeat(Math.max(1, labelWidth - visibleWidth(options.label)));
  const valueWidth = Math.max(
    1,
    options.fieldWidth - prefixWidth - visibleWidth(label)
  );
  const framedValueWidth = Math.max(1, valueWidth - visibleWidth("‹  ›"));
  const displayedValue = truncate(options.value, framedValueWidth);
  const clipped = displayedValue !== options.value && displayedValue.endsWith("…");
  const mappedValue = clipped ? displayedValue.slice(0, -1) : displayedValue;
  const valueRole = options.focused ? "focus / accent" as const : "prose · dim" as const;
  return composerFieldLine(options.indent, options.fieldWidth, [
    segment("┃ ", "compose accent"),
    segment(options.focused ? "▸ " : "  ", "focus / accent"),
    segment(label, options.focused ? "prose" : "chrome"),
    segment("‹ ", valueRole, {
      kind: "action",
      action: "take-previous",
      composerSourceId: options.sourceId
    }),
    ...(mappedValue.length === 0 ? [] : clipped || options.sourceStart === null
      ? [{
          text: mappedValue,
          role: valueRole,
          composerSource: {
            id: options.sourceId,
            editable: false
          }
        }]
      : [{
            text: mappedValue,
            role: valueRole,
            composerStart: options.sourceStart,
            composerSource: {
              id: options.sourceId,
              editable: true
            }
          }]),
    ...(clipped ? [segment("…", valueRole)] : []),
    segment(" ›", valueRole, {
      kind: "action",
      action: "take-next",
      composerSourceId: options.sourceId
    })
  ]);
}
