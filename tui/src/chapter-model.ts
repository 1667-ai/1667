import type { StoryPayload } from "../../shared/types.js";
import { formatTokensScaled } from "./rail.js";
import type { NextRequestEstimate, RequestChapterProjection } from "./request-projection.js";
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
  estimate: NextRequestEstimate,
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

/** What a chapter is called on screen.
 *
 * Chapter one is opened by no break, so before it is named it has no title of
 * its own and reads as the story — which is exactly what the export does, where
 * an unnamed chapter one takes no heading because the document title already
 * names it. Calling it "(untitled)" said the opposite of that. */
export function chapterDisplayTitle(chapter: StoryChapter, storyTitle: string): string {
  if (chapter.title !== "") return chapter.title;
  return chapter.number === 1 && storyTitle !== "" ? storyTitle : "(untitled)";
}

export function chapterStatus(projection: RequestChapterProjection | undefined): string {
  if (projection?.included !== true) return "not sent";
  const tokens = formatTokensScaled(projection.tokens);
  if (projection.summarized) {
    return projection.stale ? `${tokens} stale ↻` : `${tokens} ✓ summary`;
  }
  return projection.closed ? `${tokens} raw — no summary` : `current · ${tokens} raw`;
}

export function extentLabel(chapter: StoryChapter): string {
  if (chapter.startPart === null || chapter.endPart === null) return "opens next";
  return chapter.startPart === chapter.endPart
    ? `part ${chapter.startPart}`
    : `parts ${chapter.startPart}–${chapter.endPart}`;
}

export function chapterWindow(total: number, cursor: number, budget: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, budget));
  const start = Math.max(0, Math.min(Math.max(0, total - size), cursor - Math.floor(size / 2)));
  return { start, end: Math.min(total, start + size) };
}

export function chapterWord(number: number): string {
  const small = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"
  ];
  if (number < small.length) return small[number]!;
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (number < 100) return `${tens[Math.floor(number / 10)]}${number % 10 === 0 ? "" : `-${small[number % 10]!.toLowerCase()}`}`;
  return number.toLocaleString("en-US");
}
