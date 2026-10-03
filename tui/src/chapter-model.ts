import type { StoryPayload } from "../../shared/types.js";
import { extentLabel } from "../../shared/chapter-labels.js";
import { formatTokensScaled } from "./rail.js";
import type { RequestChapterProjection, RequestTokenEstimate } from "./request-projection.js";
import { createStoryViewModel, type StoryChapter, type StoryViewModel } from "./model.js";

export interface ChapterListRow {
  chapter: StoryChapter;
  extent: string;
  status: string;
  sent: boolean;
  stale: boolean;
  biggestFix: boolean;
  savings: number;
}

export interface ChapterListModel {
  rows: ChapterListRow[];
  totalTokens: number;
  contextWindow: number | null;
  over: number;
  biggestUnsummarized: StoryChapter | null;
}

export function chapterListModel(
  payload: StoryPayload,
  contextWindow: number | null,
  estimate: RequestTokenEstimate,
  view: StoryViewModel = createStoryViewModel(payload)
): ChapterListModel {
  const totalTokens = estimate.tokens;
  const over = contextWindow === null || contextWindow <= 0 ? 0 : Math.max(0, totalTokens - contextWindow);
  const projectionByNumber = new Map(estimate.chapters.map((chapter) => [chapter.number, chapter] as const));
  const candidates = view.chapters.flatMap((chapter) => {
    const projection = projectionByNumber.get(chapter.number);
    return projection?.included === true && projection.closed && !projection.summarized && projection.savings > 0
      ? [{ chapter, savings: projection.savings }] : [];
  })
    .sort((left, right) => right.savings - left.savings);
  const biggestUnsummarized = over > 0 ? candidates[0]?.chapter ?? null : null;
  const rows = view.chapters.map((chapter): ChapterListRow => {
    const projection = projectionByNumber.get(chapter.number);
    const sent = projection?.included ?? false;
    const savings = projection?.savings ?? 0;
    return {
      chapter,
      extent: extentLabel(chapter),
      status: chapterStatus(projection),
      sent,
      stale: projection?.stale ?? false,
      biggestFix: biggestUnsummarized?.number === chapter.number,
      savings
    };
  });
  return { rows, totalTokens, contextWindow, over, biggestUnsummarized };
}

export function chapterStatus(projection: RequestChapterProjection | undefined): string {
  if (projection?.included !== true) return "not sent";
  const tokens = formatTokensScaled(projection.tokens);
  if (projection.summarized) {
    return projection.stale ? `${tokens} stale ↻` : `${tokens} ✓ summary`;
  }
  return projection.closed ? `${tokens} raw — no summary` : `current · ${tokens} raw`;
}

export function chapterWindow(total: number, cursor: number, budget: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, budget));
  const start = Math.max(0, Math.min(Math.max(0, total - size), cursor - Math.floor(size / 2)));
  return { start, end: Math.min(total, start + size) };
}
