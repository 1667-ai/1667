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
  return composerFieldLine(options.indent, options.fieldWidth, [
    segment("┃ ", "compose accent"),
    segment("  ", "compose accent"),
    segment(label, "chrome"),
    segment("‹ ", "focus / accent"),
    ...(mappedValue.length === 0 ? [] : clipped || options.sourceStart === null
      ? [{
          text: mappedValue,
          role: "focus / accent" as const,
          composerSource: {
            id: options.sourceId,
            editable: false
          }
        }]
      : [{
            text: mappedValue,
            role: "focus / accent" as const,
            composerStart: options.sourceStart,
            composerSource: {
              id: options.sourceId,
              editable: true
            }
          }]),
    ...(clipped ? [segment("…", "focus / accent")] : []),
    segment(" ›", "focus / accent")
  ]);
}
