export interface SummaryProgress { consumedParts: number | null; totalParts: number; words: number }

export function summaryStretch(path: readonly { role?: "summary" }[]): { start: number; end: number; total: number } {
  const end = path.length;
  const previous = path.slice(0, -1).findLastIndex((node) => node.role === "summary");
  const start = previous + 2;
  return { start, end, total: Math.max(0, end - start + 1) };
}

/** Providers do not expose source-consumption events. Honor an explicit ¶ marker; otherwise report honest word progress. */
export function deriveSummaryProgress(text: string, totalParts: number): SummaryProgress {
  const matches = [...text.matchAll(/¶\s*(\d+)(?:\s+of\s+(\d+))?/gi)];
  const last = matches.at(-1);
  const marked = last === undefined ? null : Number(last[1]);
  const markedTotal = last?.[2] === undefined ? totalParts : Number(last[2]);
  const valid = marked !== null && Number.isSafeInteger(marked) && marked >= 0 && marked <= markedTotal && markedTotal === totalParts;
  return {
    consumedParts: valid ? marked : null,
    totalParts,
    words: text.trim().split(/\s+/).filter(Boolean).length
  };
}
