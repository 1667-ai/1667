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

/** `createSummaryTake` chose an earlier point than requested (issue #139):
 *  tell the writer how much of the story the summary actually covers,
 *  reusing the same eligible-parts count (`stretch`) the summary overlay
 *  already showed while it streamed, so the two never disagree about what
 *  was on offer. */
export function narrowedSummaryToast(
  requestedPath: readonly { id: string }[],
  stretch: { start: number; total: number },
  narrowedTo: { nodeId: string }
): string {
  const used = summaryPointProgress(requestedPath, stretch, narrowedTo.nodeId);
  if (used === null) {
    return "◈ summary take saved · covers less of the story than requested — the full prefix filled the context window";
  }
  // "N of M parts" pluralizes on the total (the list being counted from),
  // not the count itself — "1 of 2 parts", not "1 of 2 part".
  return `◈ summary take saved · covers ${used} of ${stretch.total} ${stretch.total === 1 ? "part" : "parts"} — the rest filled the context window`;
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
