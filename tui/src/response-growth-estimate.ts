import { isChapterSummary } from "../../shared/story-tree.js";
import { estimateTokens } from "../../shared/tokens.js";
import type { StoryNode, StoryPayload } from "../../shared/types.js";

/** Conservative likely-response size when the story has no usable generation history. */
export const COLD_START_RESPONSE_GROWTH_TOKENS = 512;

/** How many recent ordinary prose generations feed the robust sample. */
export const RESPONSE_GROWTH_HISTORY_SAMPLE = 5;

export interface ResponseGrowthEstimateArgs {
  /** Active path with full StoryNode text for clean generation samples. */
  payload: Pick<StoryPayload, "path">;
  /** Configured hard output cap; the bar never uses this alone as growth. */
  maxOutputTokens: number;
  /** Token count of the exact projected next request. */
  requestTokens: number;
  /** Provider context window, or null when unknown. */
  contextWindow: number | null;
}

/**
 * Likely tokens a provider response will add to the next assembled context.
 *
 * Uses a small recent median of clean single-generation provider prose on the
 * active path. Samples `estimateTokens` of each node's full text only — never
 * instruction size, and never NodeStub.tokens (which can include instruction).
 *
 * Samples require a `genId` (provider generation identity). Human nodes,
 * summaries, cuts, edits, and mutated prose are excluded. Cold start uses a
 * conservative fallback. The result is clamped to the output cap and, when a
 * window exists, to free capacity after the projected request.
 *
 * Retake and other replacement operations already drop the replaced target from
 * the request projection, so this value is the generation size — not size minus
 * a target the projection already excludes.
 */
export function estimateResponseGrowthTokens(args: ResponseGrowthEstimateArgs): number {
  const likely = likelyResponseTokens(args.payload);
  const byCap = Math.min(likely, Math.max(0, args.maxOutputTokens));
  if (args.contextWindow === null || args.contextWindow <= 0) {
    return Math.max(0, Math.round(byCap));
  }
  const free = Math.max(0, args.contextWindow - Math.max(0, args.requestTokens));
  return Math.max(0, Math.round(Math.min(byCap, free)));
}

/** Unclamped history median or cold-start fallback. */
export function likelyResponseTokens(payload: Pick<StoryPayload, "path">): number {
  const sample = recentProviderProseTokenCounts(payload);
  if (sample.length === 0) return COLD_START_RESPONSE_GROWTH_TOKENS;
  return medianTokenCount(sample);
}

/**
 * Token counts from a small recent sample of clean provider-generated ordinary
 * prose on the active path (newest first). Full StoryNode text is required, so
 * off-path stubs are never used — their full prose is unavailable.
 */
export function recentProviderProseTokenCounts(
  payload: Pick<StoryPayload, "path">
): number[] {
  const counts: number[] = [];
  for (const node of payload.path.slice().reverse()) {
    if (!isCleanSingleGenerationProviderProse(node)) continue;
    const tokens = estimateTokens(node.text);
    if (tokens <= 0) continue;
    counts.push(tokens);
    if (counts.length >= RESPONSE_GROWTH_HISTORY_SAMPLE) return counts;
  }
  return counts;
}

/**
 * Clean single-generation evidence: completed provider ordinary prose that has
 * not been enlarged or rewritten after the first write.
 *
 * Provenance boundary: require `genId`. Current provider commits set it. Human
 * commits, edited siblings, and cut takes omit it. Legacy provider nodes
 * without `genId` are not guessed — fall back to other clean samples or cold
 * start.
 *
 * Defensive exclusions (readable even when genId is absent):
 * - human-originated takes (`human`)
 * - all summary takes (legacy `role:"summary"` and chapter summaries)
 * - any in-place mutation (`updatedAt`: append, rewrite, human edit). Append
 *   also rewrites `genId` on the same node, so `updatedAt` still rejects
 *   cumulative multi-generation text.
 * - human-mutated prose marked without `updatedAt` (`attribution` on
 *   edit-as-sibling / cut takes that retain spans)
 */
function isCleanSingleGenerationProviderProse(node: StoryNode): boolean {
  // Canonical: one provider generation leaves a genId; cut/edit/human omit it.
  if (node.genId === undefined) return false;
  if (node.human === true) return false;
  if (node.role === "summary" || isChapterSummary(node)) return false;
  // Append / rewrite / in-place edit stack into the same node and set updatedAt.
  // Empty Continue can append multiple generations into one text.
  if (node.updatedAt !== undefined) return false;
  // Edit-as-sibling and cut can carry human spans without updatedAt.
  if (node.attribution != null) return false;
  return true;
}

function medianTokenCount(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
