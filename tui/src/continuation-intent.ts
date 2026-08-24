import type { StoryNode, StoryPayload } from "../../shared/types.js";
import { DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import { resolveDefaultContinueDirection } from "../../shared/writing-prompt-runtime.js";

/** One canonical description of the continuation the TUI is about to ask for.
 * Generation owns transport details; the meter consumes the same context shape. */
export interface ContinuationIntent {
  leaf: StoryNode | null;
  contextParts: StoryNode[];
  instruction: string;
  requestAppend: boolean;
  appendLast: boolean;
  fromSeam: boolean;
  focusPathIndex: number;
  parentId: string | null;
}

export function continuationIntent(
  payload: StoryPayload,
  focusedPathId: string | null,
  requestedInstruction: string,
  regenerateNode: StoryNode | null = null,
  defaultContinueDirection: string = DEFAULT_INSTRUCTION
): ContinuationIntent {
  const path = payload.path;
  const leaf = path.at(-1) ?? null;
  const focusPathIndex = focusedPathId === null
    ? -1
    : path.findIndex((part) => part.id === focusedPathId);
  const focused = focusPathIndex < 0 ? null : path[focusPathIndex]!;
  const fromSeam = regenerateNode === null
    && leaf !== null
    && focused !== null
    && focused.id !== leaf.id;
  const requestAppend = regenerateNode === null
    && !fromSeam
    && requestedInstruction.trim().length === 0
    && leaf !== null
    && leaf.role !== "summary";
  const crossesChapterBreak = requestAppend && payload.chapterBreaks.some(
    (chapterBreak) => chapterBreak.parentPartId === leaf?.id
  );
  const parentId = regenerateNode !== null ? regenerateNode.parentId
    : fromSeam ? focused!.id
    : requestAppend ? crossesChapterBreak ? leaf!.id : leaf!.parentId
    : leaf?.id ?? null;
  const contextEnd = regenerateNode !== null
    ? path.findIndex((part) => part.id === regenerateNode.parentId)
    : fromSeam ? focusPathIndex : path.length - 1;
  return {
    leaf,
    contextParts: contextEnd < 0 ? [] : path.slice(0, contextEnd + 1),
    instruction: requestedInstruction.trim()
      || (requestAppend && !crossesChapterBreak
        ? DEFAULT_INSTRUCTION
        : resolveDefaultContinueDirection(defaultContinueDirection)),
    requestAppend,
    appendLast: requestAppend && !crossesChapterBreak,
    fromSeam,
    focusPathIndex,
    parentId
  };
}
