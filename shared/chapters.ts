import { estimateTokens } from "./tokens.js";
import { contextSlice, isChapterSummary } from "./story-tree.js";
import type { ChapterBreak, CoveredExtent, StoryNode } from "./types.js";

export const SUMMARY_TARGET_TOKENS = 240;

/** Canonical prompt attached to chapter-summary nodes and carried over the
 * v3 HTTP payload boundary for exact client-side request projection. */
export function summaryNodeInstruction(sourceTitle: string): string {
  return `Inherited continuity summary of ${JSON.stringify(sourceTitle)} up to this point. Treat every supported detail below as established context; continue from the exact final state without retelling the summary.`;
}

export interface ChapterPartLike {
  id: string;
  parentId: string | null;
  instruction?: string;
  text?: string;
  tokens?: number;
  createdAt?: string;
  updatedAt?: string;
  role?: "summary";
  chapterBreakId?: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
  editedByUser?: true;
}

/** Provider-ready chapter context. Optional display stubs must be hydrated to
 * this boundary before prompt construction. */
export interface PromptPart extends ChapterPartLike {
  instruction: string;
  text: string;
}

export interface DerivedChapter<Node extends ChapterPartLike> {
  number: number;
  title: string;
  extent: CoveredExtent | null;
  closedBy: ChapterBreak | null;
  rawTokens: number;
  parts: Node[];
  summary: Node | null;
  stale: boolean;
}

export function deriveChapters<Node extends ChapterPartLike>(
  path: readonly Node[],
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[]
): DerivedChapter<Node>[] {
  const visiblePath = path.filter((node) => !isChapterSummary(node));
  if (visiblePath.length === 0) return [];
  const pathIds = new Set(visiblePath.map((node) => node.id));
  const breaksByParent = new Map<string, ChapterBreak>();
  for (const chapterBreak of chapterBreaks) {
    if (pathIds.has(chapterBreak.parentPartId)) breaksByParent.set(chapterBreak.parentPartId, chapterBreak);
  }
  const summariesByBreak = new Map<string, Node>();
  for (const node of nodes) {
    if (node.role === "summary" && isChapterSummary(node)) {
      summariesByBreak.set(node.chapterBreakId, node);
    }
  }

  const chapters: DerivedChapter<Node>[] = [];
  let title = "";
  let parts: Node[] = [];
  for (const part of visiblePath) {
    parts.push(part);
    const closingBreak = breaksByParent.get(part.id);
    if (closingBreak === undefined) continue;
    chapters.push(buildChapter(chapters.length + 1, title, parts, closingBreak, summariesByBreak));
    title = closingBreak.title;
    parts = [];
  }
  chapters.push(buildChapter(chapters.length + 1, title, parts, null, summariesByBreak));
  return chapters;
}

export function assembleChapterContext<Node extends ChapterPartLike>(
  path: readonly StoryNode[],
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[]
): Array<StoryNode | Node> {
  const pathIds = new Set(path.map((node) => node.id));
  if (!chapterBreaks.some((chapterBreak) => pathIds.has(chapterBreak.parentPartId))) {
    return contextSlice([...path]);
  }
  const legacySummaryIndex = path.findLastIndex(
    (node) => node.role === "summary" && !isChapterSummary(node)
  );
  const segment = path.slice(legacySummaryIndex === -1 ? 0 : legacySummaryIndex);
  const chapters = deriveChapters<StoryNode | Node>(segment, chapterBreaks, nodes);
  return chapters.flatMap((chapter) => chapter.closedBy !== null && chapter.summary !== null
    ? [chapter.summary]
    : chapter.parts);
}

export function isChapterSummaryStale<Node extends ChapterPartLike>(
  summary: Node,
  extent: CoveredExtent | null,
  parts: readonly Node[]
): boolean {
  if (extent === null || summary.coveredExtent === undefined || summary.madeAt === undefined) return true;
  if (
    summary.coveredExtent.fromPartId !== extent.fromPartId
    || summary.coveredExtent.toPartId !== extent.toPartId
  ) return true;
  for (const part of parts) {
    if (part.updatedAt !== undefined && part.updatedAt > summary.madeAt) return true;
  }
  return false;
}

function buildChapter<Node extends ChapterPartLike>(
  number: number,
  title: string,
  parts: Node[],
  closedBy: ChapterBreak | null,
  summariesByBreak: ReadonlyMap<string, Node>
): DerivedChapter<Node> {
  const extent = parts.length === 0
    ? null
    : { fromPartId: parts[0]!.id, toPartId: parts.at(-1)!.id };
  const candidate = closedBy === null ? null : summariesByBreak.get(closedBy.id) ?? null;
  const summary = candidate !== null && extent !== null && candidate.parentId === extent.toPartId ? candidate : null;
  return {
    number,
    title,
    extent,
    closedBy,
    rawTokens: parts.reduce((sum, part) => sum + partTokens(part), 0),
    parts,
    summary,
    stale: summary === null ? false : isChapterSummaryStale(summary, extent, parts)
  };
}

function partTokens(part: ChapterPartLike): number {
  if (part.tokens !== undefined) return part.tokens;
  return estimateTokens(part.instruction ?? "") + estimateTokens(part.text ?? "");
}
