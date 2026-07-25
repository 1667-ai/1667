import type { StorySelectionSpan } from "../../selection-projection.js";
import type { FrameLine, FrameSegment } from "./frame.js";

/** Paint semantic story spans without keeping OpenTUI's buffer-relative
 * selection alive underneath an overlay. */
export function paintStorySelection(
  lines: readonly FrameLine[],
  spans: readonly StorySelectionSpan[]
): FrameLine[] {
  if (spans.length === 0) return lines.map((line) => [...line]);
  const byKey = new Map<string, StorySelectionSpan[]>();
  for (const span of spans) {
    const existing = byKey.get(span.key) ?? [];
    existing.push(span);
    byKey.set(span.key, existing);
  }
  return lines.map((line) => line.flatMap((part) => {
    const source = part.storySource;
    const selections = source === undefined
      ? undefined
      : byKey.get(source.key)?.filter((span) => span.text === source.text);
    if (source === undefined || selections === undefined || selections.length === 0) return [part];
    return splitHighlight(part, source, selections);
  }));
}

function splitHighlight(
  part: FrameSegment,
  source: NonNullable<FrameSegment["storySource"]>,
  spans: readonly StorySelectionSpan[]
): FrameSegment[] {
  const sourceStart = source.start;
  const sourceEnd = sourceStart + part.text.length;
  const boundaries = new Set([sourceStart, sourceEnd]);
  for (const span of spans) {
    if (span.end <= sourceStart || span.start >= sourceEnd) continue;
    boundaries.add(Math.max(sourceStart, span.start));
    boundaries.add(Math.min(sourceEnd, span.end));
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  return ordered.slice(0, -1).flatMap((start, index) => {
    const end = ordered[index + 1]!;
    if (end <= start) return [];
    const selected = spans.some((span) => span.start < end && span.end > start);
    return [{
      ...part,
      text: part.text.slice(start - sourceStart, end - sourceStart),
      storySource: { ...source, start },
      ...(selected ? { role: "background" as const, background: "focus / accent" as const } : {})
    }];
  });
}
