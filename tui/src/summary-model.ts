export interface SummaryProgress { consumedParts: number | null; totalParts: number; words: number }

export function summaryStretch(path: readonly { role?: "summary" }[]): { start: number; end: number; total: number } {
  const end = path.length;
  const previous = path.slice(0, -1).findLastIndex((node) => node.role === "summary");
  const start = previous + 2;
  return { start, end, total: Math.max(0, end - start + 1) };
}

/** How many of `stretch.total` eligible parts `nodeId` actually covers,
 *  1-based — the server's own answer, via `createSummaryTake`'s
 *  `narrowedTo`, to "how much of the request got summarized" (issue #139).
 *  `path` is the pre-summary active path `stretch` was computed from. null
 *  when `nodeId` is not on that path at all — defensive only, since every
 *  point a real response reports is already an ancestor on it. */
export function summaryPointProgress(
  path: readonly { id: string }[],
  stretch: { start: number },
  nodeId: string
): number | null {
  const index = path.findIndex((node) => node.id === nodeId);
  return index === -1 ? null : index - stretch.start + 2;
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
