import type { FrameDeadlineCollector } from "../animation-deadline.js";
import type { DisplayRole, FrameLine, FrameSegment } from "./story/frame.js";

const WORK_LIGHT_FRAME_MS = 120;
const WORK_LIGHT_EDGE_FRAMES = 2;
const STREAM_LIVENESS_MARKS = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"
] as const;
const STREAM_LIVENESS_FRAME_MS = 250;

/** Move the liveness dots once around their cell before the cycle repeats. */
export function streamLivenessMark(
  now: number,
  deadlines?: FrameDeadlineCollector
): string {
  const frame = Math.floor(now / STREAM_LIVENESS_FRAME_MS);
  deadlines?.at((frame + 1) * STREAM_LIVENESS_FRAME_MS);
  return STREAM_LIVENESS_MARKS[frame % STREAM_LIVENESS_MARKS.length]!;
}

/** Move one light band through a visible work-state keyword. */
export function lightWorkKeyword(
  line: FrameLine,
  keyword: "working" | "writing" | "thinking",
  now: number,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  const partIndex = line.findIndex((part) => part.text.includes(keyword));
  if (partIndex < 0) return line;
  const part = line[partIndex]!;
  const keywordStart = part.text.indexOf(keyword);
  const frame = Math.floor(now / WORK_LIGHT_FRAME_MS);
  const cycle = keyword.length + WORK_LIGHT_EDGE_FRAMES * 2;
  const head = frame % cycle - WORK_LIGHT_EDGE_FRAMES;
  deadlines?.at((frame + 1) * WORK_LIGHT_FRAME_MS);

  const lit = Array.from(keyword, (character, index): FrameSegment => ({
    ...part,
    text: character,
    role: workLightRole(Math.abs(index - head))
  }));
  return [
    ...line.slice(0, partIndex),
    ...(keywordStart === 0 ? [] : [{ ...part, text: part.text.slice(0, keywordStart) }]),
    ...lit,
    ...(keywordStart + keyword.length === part.text.length
      ? []
      : [{ ...part, text: part.text.slice(keywordStart + keyword.length) }]),
    ...line.slice(partIndex + 1)
  ];
}

function workLightRole(distance: number): DisplayRole {
  if (distance === 0) return "streaming";
  if (distance === 1) return "focus / accent";
  if (distance === 2) return "brass dim";
  return "chrome";
}
