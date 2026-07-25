import { deriveChapters } from "../../shared/chapters.js";
import { activePath } from "../../shared/story-tree.js";
import type { Story, StoryNode } from "../../shared/types.js";
import type { RemovedChapterBreak } from "./api.js";

export const DEMO_SUMMARY_TEXT = "Maren keeps the lantern-house above a storm-locked inn. The traveler Ashe pays in nameless coin, burns no oil, and carries a compass that points at want. One lantern has already gone dark, and the needle now points at Maren herself.";

export function createDemoChapterBreak(story: Story, parentPartId: string, title: string, createdAt: string): string {
  if (!story.nodes.some((node) => node.id === parentPartId && node.chapterBreakId === undefined)) {
    throw new Error(`Unknown demo part: ${parentPartId}`);
  }
  if (story.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === parentPartId)) {
    throw new Error("This seam already has a chapter break");
  }
  const breakId = `demo-chapter-break-${story.chapterBreaks.length + 1}`;
  story.chapterBreaks.push({ id: breakId, parentPartId, title, createdAt });
  return breakId;
}

export function renameDemoChapterBreak(story: Story, breakId: string, title: string): void {
  const chapterBreak = story.chapterBreaks.find((candidate) => candidate.id === breakId);
  if (chapterBreak === undefined) throw new Error(`Unknown demo chapter break: ${breakId}`);
  chapterBreak.title = title;
}

export function removeDemoChapterBreak(story: Story, breakId: string): RemovedChapterBreak {
  const chapterBreak = story.chapterBreaks.find((candidate) => candidate.id === breakId);
  if (chapterBreak === undefined) throw new Error(`Unknown demo chapter break: ${breakId}`);
  const summaries = story.nodes.filter((node) => node.chapterBreakId === breakId).map((node) => structuredClone(node));
  const summaryIds = new Set(summaries.map((node) => node.id));
  story.chapterBreaks = story.chapterBreaks.filter((candidate) => candidate.id !== breakId);
  story.nodes = story.nodes.filter((node) => !summaryIds.has(node.id));
  return { break: { ...chapterBreak }, summaries };
}

export function restoreDemoChapterBreak(story: Story, breakId: string, removed: RemovedChapterBreak): void {
  if (removed.break.id !== breakId) throw new Error("Restored chapter break id does not match");
  if (story.chapterBreaks.some((candidate) => candidate.id === breakId || candidate.parentPartId === removed.break.parentPartId)) {
    throw new Error("Chapter break restore conflicts with current story");
  }
  story.chapterBreaks.push({ ...removed.break });
  story.nodes.push(...removed.summaries.map((summary) => structuredClone(summary)));
}

export function summarizeDemoChapter(story: Story, breakId: string, madeAt: string): void {
  const chapter = deriveChapters(activePath(story), story.chapterBreaks, story.nodes)
    .find((candidate) => candidate.closedBy?.id === breakId);
  if (chapter?.extent === null || chapter?.extent === undefined) throw new Error("Chapter has no prose to summarize");
  const existing = story.nodes.find((node) => node.chapterBreakId === breakId);
  const text = chapter.number === 1 ? DEMO_SUMMARY_TEXT
    : `Chapter ${chapter.number} closes around the dark lantern, the old coin, and the compass that points at Maren.`;
  if (existing !== undefined) {
    existing.text = text;
    existing.coveredExtent = { ...chapter.extent };
    existing.madeAt = madeAt;
    delete existing.editedByUser;
    return;
  }
  story.nodes.push({
    id: `chapter-summary-${story.nodes.length + 1}`,
    parentId: chapter.extent.toPartId,
    instruction: "summarize this chapter",
    text,
    model: "qwen3-32b",
    createdAt: madeAt,
    activeChildId: null,
    role: "summary",
    chapterBreakId: breakId,
    coveredExtent: { ...chapter.extent },
    madeAt
  });
}

export function editDemoChapterSummary(story: Story, summaryId: string, text: string, editedAt: string): void {
  const summary = story.nodes.find((node) => node.id === summaryId && node.chapterBreakId !== undefined);
  if (summary === undefined) throw new Error(`Unknown demo chapter summary: ${summaryId}`);
  summary.text = text;
  summary.editedByUser = true;
  summary.updatedAt = editedAt;
}

export function demoChapterSummaryNode(createdAt: string): StoryNode {
  return {
    id: "chapter-summary-1",
    parentId: "p5",
    instruction: "summarize this chapter",
    text: DEMO_SUMMARY_TEXT,
    model: "qwen3-32b",
    createdAt,
    activeChildId: null,
    role: "summary",
    chapterBreakId: "chapter-break-1",
    coveredExtent: { fromPartId: "p1", toPartId: "p5" },
    madeAt: createdAt
  };
}
