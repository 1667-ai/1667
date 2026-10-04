import type { TokenProbabilityRecord } from "../../shared/token-probabilities.js";
import { type StyleRun, type WrappedLine, wrapText } from "./wrap.js";

// The model of the token probability viewer lives in `shared/` (the web page
// uses it too); only the excerpt, which wraps for the terminal, stays here.
export * from "../../shared/token-probabilities-model.js";

export type TokenProbabilityExcerptLine = WrappedLine<"selected">;

export interface TokenProbabilityExcerpt {
  readonly lines: readonly TokenProbabilityExcerptLine[];
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
}

/** Wrap the take's whole text with the selected token as a style run, then
 *  keep only the window of lines around it — the whole part can run to
 *  thousands of words, and the viewer shows a passage, not the take. */
export function tokenProbabilityExcerpt(
  text: string,
  highlight: { readonly start: number; readonly end: number },
  measure: number,
  contextLines = 1
): TokenProbabilityExcerpt {
  const runs: StyleRun<"selected">[] = highlight.end > highlight.start
    ? [{ start: highlight.start, end: highlight.end, style: "selected" }]
    : [];
  const wrapped = wrapText(text, runs, Math.max(1, measure));
  const centerIndex = Math.max(0, wrapped.findIndex((line) =>
    line.start < highlight.end && line.end > highlight.start
  ));
  const from = Math.max(0, centerIndex - contextLines);
  const to = Math.min(wrapped.length, centerIndex + contextLines + 1);
  return {
    lines: wrapped.slice(from, to),
    truncatedStart: from > 0,
    truncatedEnd: to < wrapped.length
  };
}

