import type { StoryNode, StoryPayload, TextRange } from "./types.js";

/** A range of one part's prose that a rewrite will replace. `expected` is the
 * text the range held when the writer chose it. */
export interface RewriteTarget extends TextRange {
  readonly node: StoryNode;
  readonly expected: string;
}

export interface RewriteTargetError {
  readonly error: string;
}

export const NO_SELECTION_MESSAGE = "highlight story text before rewriting it";
export const STALE_SELECTION_MESSAGE = "the story changed · highlight it again";

/** The staleness check behind a rewrite: the range is read again against the
 * live part, because the story can change between the moment a passage is
 * chosen and the moment the writer confirms the rewrite. Shared by the TUI
 * and the web UI. */
export function resolveRewriteRange(
  payload: StoryPayload,
  partId: string,
  start: number,
  end: number,
  expected: string
): RewriteTarget | RewriteTargetError {
  const node = payload.path.find((candidate) => candidate.id === partId);
  if (node === undefined || end <= start) return { error: NO_SELECTION_MESSAGE };
  const live = node.text.slice(start, end);
  if (live !== expected) return { error: STALE_SELECTION_MESSAGE };
  return { node, start, end, expected: live };
}
