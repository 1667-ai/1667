import {
  chapterForRow,
  createManuscriptModel,
  lastPartRowIndex,
  rowIndexForNode,
  rowPart,
  type ChapterDividerRow,
  type ChapterSummaryRow,
  type ManuscriptModel,
  type StoryChapter,
  type StoryPart,
  type StoryRow
} from "../../shared/manuscript-model.js";
import { resolveSwitchTarget, resolveTakeTarget, type SwitchDirection } from "../../shared/story-model.js";
import type { StoryPayload } from "../../shared/types.js";
import type { RemovedChapterBreak } from "./api.js";
import type { StreamView } from "./state.js";
import { projectStreamedPayload } from "./stream-projection.js";

// Re-exported so the 40+ TUI modules that import these from "./model.js"
// (the stream-free rows/parts/chapters model, and the row-lookup helpers)
// keep working unchanged — the implementation moved to
// shared/manuscript-model.ts (max reuse with the web manuscript view) and
// shared/story-model.ts (take-switch target resolution).
export {
  chapterForRow,
  createManuscriptModel,
  lastPartRowIndex,
  resolveSwitchTarget,
  resolveTakeTarget,
  rowIndexForNode,
  rowPart
};
export type {
  ChapterDividerRow,
  ChapterSummaryRow,
  StoryChapter,
  StoryPart,
  StoryRow,
  SwitchDirection
};

export interface StoryViewModel extends ManuscriptModel {
  /** Canonical payload represented by every row, total, and active identity. */
  visiblePayload: StoryPayload;
}

/** What `u` can take back.
 *
 * Every entry is a change to stored data. Take switching is deliberately absent:
 * it changes which take the line reads, the arrows reverse it directly, and an
 * undo stack that mixed the two taught the reader that `u` reaches further back
 * into their prose than it does. */
export type UndoEntry =
  | { kind: "create-break"; breakId: string }
  | { kind: "remove-break"; breakId: string; removed: RemovedChapterBreak };

export function createStoryViewModel(payload: StoryPayload, stream: StreamView | null = null): StoryViewModel {
  const visiblePayload = projectStreamedPayload(payload, stream, { includePendingTake: true });
  return { visiblePayload, ...createManuscriptModel(visiblePayload) };
}

export function rowIndexForPathIndex(view: StoryViewModel, pathIndex: number): number {
  return view.rows.findIndex((row) => row.kind === "part" && row.pathIndex === pathIndex);
}

export function popUndo(stack: readonly UndoEntry[]): { entry: UndoEntry | null; rest: UndoEntry[] } {
  if (stack.length === 0) return { entry: null, rest: [] };
  return { entry: stack.at(-1)!, rest: stack.slice(0, -1) };
}
