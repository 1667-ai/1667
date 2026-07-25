import {
  composerLineLength,
  composerLineSelection,
  composerLineSlice,
  composerLineStart,
  type ComposerState
} from "../../composer-model.js";
import type { DisplayRole, FrameLine, FrameSegment } from "./frame.js";

/** Paint one raw composer range with both selection styling and source offsets.
 * Wrapped and unwrapped editors share this path so mouse and keyboard
 * selections cannot drift apart. */
export function renderComposerRange(
  composer: ComposerState,
  line: number,
  start: number,
  end: number,
  selectedBackground: DisplayRole = "focus / accent"
): FrameLine {
  if (end <= start) return [];
  const lineStart = composerLineStart(composer, line);
  const slice = (
    sliceStart: number,
    sliceEnd: number,
    selected = false
  ): FrameSegment => ({
    text: composerLineSlice(composer, line, sliceStart, sliceEnd),
    role: selected ? "background" : "streaming",
    ...(selected ? { background: selectedBackground } : {}),
    composerStart: lineStart + sliceStart
  });
  const selection = composerLineSelection(composer, line);
  if (selection === null || selection.end <= start || selection.start >= end) {
    return [slice(start, end)];
  }
  const selectedStart = Math.max(start, selection.start);
  const selectedEnd = Math.min(end, selection.end);
  return [
    ...(selectedStart > start ? [slice(start, selectedStart)] : []),
    slice(selectedStart, selectedEnd, true),
    ...(selectedEnd < end ? [slice(selectedEnd, end)] : [])
  ];
}

export function renderComposerLineBreak(
  composer: ComposerState,
  line: number,
  selected: boolean,
  selectedBackground: DisplayRole = "focus / accent"
): FrameSegment {
  return {
    text: " ",
    role: selected ? "background" : "streaming",
    ...(selected ? { background: selectedBackground } : {}),
    composerStart: composerLineStart(composer, line) + composerLineLength(composer, line)
  };
}
