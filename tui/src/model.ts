import { deriveChapters } from "../../shared/chapters.js";
import { createStoryIndex } from "../../shared/story-model.js";
import { childrenOf, takeIndex } from "../../shared/story-tree.js";
import type { ChapterBreak, NodeStub, StoryNode, StoryPayload, TextRange } from "../../shared/types.js";
import type { RemovedChapterBreak } from "./api.js";
import type { StreamView } from "./state.js";
import { projectStreamedPayload } from "./stream-projection.js";

export interface StoryPart {
  kind: "part";
  id: string;
  /** One-based prose/legacy-summary position on the active line. */
  number: number;
  pathIndex: number;
  chapterNumber: number;
  node: StoryNode;
  stub: NodeStub;
  siblingCount: number;
  takeIndex: number;
  /** Decision 18 carried to the page: one flag per sibling take, true where that
   *  take branches into subtakes of its own, so the strip can ring it. */
  takeSubtakes: readonly boolean[];
  /** Legacy reset-summary only; chapter summaries use their own row kind. */
  isSummary: boolean;
  instruction: string;
  humanSpans: TextRange[];
  words: number;
}

export interface StoryChapter {
  number: number;
  title: string;
  openingBreakId: string | null;
  closedBy: ChapterBreak | null;
  rawTokens: number;
  parts: StoryPart[];
  summary: NodeStub | null;
  stale: boolean;
  startPart: number | null;
  endPart: number | null;
}

export interface ChapterSummaryRow {
  kind: "chapter-summary";
  id: string;
  chapter: StoryChapter;
  summary: NodeStub;
}

export interface ChapterDividerRow {
  kind: "chapter-divider";
  id: string;
  break: ChapterBreak;
  closingChapter: StoryChapter;
  openingChapter: StoryChapter;
}

export type StoryRow = StoryPart | ChapterSummaryRow | ChapterDividerRow;

export interface StoryViewModel {
  /** Canonical payload represented by every row, total, and active identity. */
  visiblePayload: StoryPayload;
  rows: StoryRow[];
  parts: StoryPart[];
  chapters: StoryChapter[];
  totalWords: number;
  activeLeafId: string | null;
}

export type SwitchDirection = -1 | 1;

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
  const visibleParts = createParts(visiblePayload);
  const chapterPath = visibleParts.map((part) => ({
    ...part.stub,
    text: part.node.text,
    instruction: part.node.instruction,
    updatedAt: part.node.updatedAt ?? part.stub.updatedAt
  }));
  const derived = deriveChapters(chapterPath, visiblePayload.chapterBreaks, visiblePayload.nodes);
  const partsById = new Map(visibleParts.map((part) => [part.id, part] as const));
  const chapters: StoryChapter[] = derived.map((chapter, index) => {
    const parts = chapter.parts.flatMap((part) => {
      const row = partsById.get(part.id);
      return row === undefined ? [] : [row];
    });
    const summary = chapter.summary as NodeStub | null;
    return {
      number: chapter.number,
      title: chapter.title,
      openingBreakId: index === 0 ? null : derived[index - 1]!.closedBy?.id ?? null,
      closedBy: chapter.closedBy,
      rawTokens: chapter.rawTokens,
      parts,
      summary,
      stale: chapter.stale,
      startPart: parts[0]?.number ?? null,
      endPart: parts.at(-1)?.number ?? null
    };
  });
  const chapterByPartId = new Map<string, StoryChapter>();
  for (const chapter of chapters) for (const part of chapter.parts) chapterByPartId.set(part.id, chapter);
  const parts = visibleParts.map((part) => ({
    ...part,
    chapterNumber: chapterByPartId.get(part.id)?.number ?? 1
  }));
  const replacedPartById = new Map(parts.map((part) => [part.id, part] as const));
  for (const chapter of chapters) chapter.parts = chapter.parts.map((part) => replacedPartById.get(part.id) ?? part);

  const rows: StoryRow[] = [];
  const closingChapterByParentId = new Map<string, number>();
  for (const [index, chapter] of chapters.entries()) {
    if (chapter.closedBy !== null) closingChapterByParentId.set(chapter.closedBy.parentPartId, index);
  }
  for (const part of parts) {
    rows.push(part);
    const closingIndex = closingChapterByParentId.get(part.id);
    if (closingIndex === undefined) continue;
    const closing = chapters[closingIndex]!;
    if (closing.summary !== null) {
      rows.push({ kind: "chapter-summary", id: `chapter-summary:${closing.summary.id}`, chapter: closing, summary: closing.summary });
    }
    const opening = chapters[closingIndex + 1];
    if (opening !== undefined && closing.closedBy !== null) {
      rows.push({
        kind: "chapter-divider",
        id: `chapter-divider:${closing.closedBy.id}`,
        break: closing.closedBy,
        closingChapter: closing,
        openingChapter: opening
      });
    }
  }
  return {
    visiblePayload,
    rows,
    parts,
    chapters,
    totalWords: parts.reduce((sum, part) => sum + part.words, 0),
    activeLeafId: parts.at(-1)?.id ?? null
  };
}

function createParts(payload: StoryPayload): StoryPart[] {
  const index = createStoryIndex(payload);
  return payload.path.flatMap((node, pathIndex): StoryPart[] => {
    const stub = index.tree.nodesById.get(node.id);
    if (stub === undefined) return [];
    const position = takeIndex(index.tree, node.id);
    return [{
      kind: "part",
      id: node.id,
      number: pathIndex + 1,
      pathIndex,
      chapterNumber: 1,
      node,
      stub,
      siblingCount: position.count,
      takeIndex: position.index,
      takeSubtakes: childrenOf(index.tree, node.parentId)
        .map((sibling) => childrenOf(index.tree, sibling.id).length > 0),
      isSummary: node.role === "summary",
      instruction: node.instruction,
      humanSpans: node.attribution?.source === "human" ? node.attribution.ranges : [],
      words: stub.words
    }];
  });
}

export function rowPart(view: StoryViewModel, rowIndex: number): StoryPart | null {
  const row = view.rows[rowIndex];
  return row?.kind === "part" ? row : null;
}

export function rowIndexForNode(view: StoryViewModel, nodeId: string): number {
  return view.rows.findIndex((row) => row.kind === "part" && row.id === nodeId);
}

export function rowIndexForPathIndex(view: StoryViewModel, pathIndex: number): number {
  return view.rows.findIndex((row) => row.kind === "part" && row.pathIndex === pathIndex);
}

export function lastPartRowIndex(view: StoryViewModel): number {
  for (let index = view.rows.length - 1; index >= 0; index -= 1) {
    if (view.rows[index]?.kind === "part") return index;
  }
  return 0;
}

export function chapterForRow(view: StoryViewModel, rowIndex: number): StoryChapter | null {
  const row = view.rows[rowIndex];
  if (row === undefined) return null;
  if (row.kind === "part") return view.chapters.find((chapter) => chapter.number === row.chapterNumber) ?? null;
  return row.kind === "chapter-summary" ? row.chapter : row.openingChapter;
}

export function resolveSwitchTarget(
  payload: StoryPayload,
  nodeId: string,
  direction: SwitchDirection
): { id: string; index: number; count: number } | null {
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const siblings = childrenOf(index.tree, node.parentId);
  if (siblings.length < 2) return null;
  const current = siblings.findIndex((candidate) => candidate.id === nodeId);
  if (current === -1) return null;
  const targetIndex = (current + direction + siblings.length) % siblings.length;
  return { id: siblings[targetIndex]!.id, index: targetIndex + 1, count: siblings.length };
}

export function resolveTakeTarget(
  payload: StoryPayload,
  nodeId: string,
  take: number
): { id: string; index: number; count: number } | null {
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const siblings = childrenOf(index.tree, node.parentId);
  const target = siblings[take - 1];
  if (target === undefined) return null;
  return { id: target.id, index: take, count: siblings.length };
}

export function popUndo(stack: readonly UndoEntry[]): { entry: UndoEntry | null; rest: UndoEntry[] } {
  if (stack.length === 0) return { entry: null, rest: [] };
  return { entry: stack.at(-1)!, rest: stack.slice(0, -1) };
}
