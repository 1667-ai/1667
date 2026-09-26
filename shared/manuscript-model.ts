import { deriveChapters } from "./chapters.js";
import { createStoryIndex } from "./story-model.js";
import { childrenOf, takeIndex } from "./story-tree.js";
import type { ChapterBreak, NodeStub, StoryNode, StoryPayload, TextRange } from "./types.js";

/**
 * The stream-free part of the TUI's `createStoryViewModel` (parts, chapters,
 * rows, and the row-lookup helpers) — max reuse between the TUI's own
 * `tui/src/model.ts` (which layers a streamed take on top, see
 * `projectStreamedPayload`) and the web manuscript view, which has no stream
 * to project and calls this directly on a loaded `StoryPayload`.
 */

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
  /** Ranges of prose a rewrite replaced (issue #319) — parallel to
   *  `humanSpans`, painted its own way (row-layout.ts). */
  rewrittenSpans: TextRange[];
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

export interface ManuscriptModel {
  rows: StoryRow[];
  parts: StoryPart[];
  chapters: StoryChapter[];
  totalWords: number;
  activeLeafId: string | null;
}

// Verified fact, checked against a real regression before landing (review
// asked for a `createStoryIndex`-style WeakMap cache here): unlike
// `createStoryIndex`, whose cache deliberately holds only structural data
// (ids, parent links — see its own contract note in shared/story-model.ts)
// and never a text-bearing field, this model's `StoryPart` rows embed each
// take's live `node` object and derived fields computed from it
// (`rewrittenSpans`, `humanSpans`, `words`, …). The TUI mutates a node's
// fields in place on the SAME `StoryPayload` object in at least one real
// path (confirmed by `tui/test/selection-rewrite.test.ts`, which sets
// `node.attribution`/`node.rewrittenSpans` directly on an already-built
// payload and expects the very next `createStoryViewModel` call to see it) —
// a payload-identity cache would serve the pre-mutation model back and read
// as a correctness bug, not a speed-up. So: not memoized here.
export function createManuscriptModel(payload: StoryPayload): ManuscriptModel {
  const visibleParts = createParts(payload);
  const chapterPath = visibleParts.map((part) => ({
    ...part.stub,
    text: part.node.text,
    instruction: part.node.instruction,
    updatedAt: part.node.updatedAt ?? part.stub.updatedAt
  }));
  const derived = deriveChapters(
    chapterPath,
    payload.chapterBreaks,
    payload.nodes,
    payload.firstChapterTitle ?? ""
  );
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
      rewrittenSpans: node.rewrittenSpans ?? [],
      words: stub.words
    }];
  });
}

export function rowPart(view: Pick<ManuscriptModel, "rows">, rowIndex: number): StoryPart | null {
  const row = view.rows[rowIndex];
  return row?.kind === "part" ? row : null;
}

export function rowIndexForNode(view: Pick<ManuscriptModel, "rows">, nodeId: string): number {
  return view.rows.findIndex((row) => row.kind === "part" && row.id === nodeId);
}

export function lastPartRowIndex(view: Pick<ManuscriptModel, "rows">): number {
  for (let index = view.rows.length - 1; index >= 0; index -= 1) {
    if (view.rows[index]?.kind === "part") return index;
  }
  return 0;
}

export function chapterForRow(
  view: Pick<ManuscriptModel, "rows" | "chapters">,
  rowIndex: number
): StoryChapter | null {
  const row = view.rows[rowIndex];
  if (row === undefined) return null;
  if (row.kind === "part") return view.chapters.find((chapter) => chapter.number === row.chapterNumber) ?? null;
  return row.kind === "chapter-summary" ? row.chapter : row.openingChapter;
}
