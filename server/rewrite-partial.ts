import type { RewriteNodeEffect } from "./story-provider-effect.js";
import { stripEchoedContext } from "./rewrite-output.js";

/**
 * One rewrite's splice decisions, shared byte-for-byte by the full commit in
 * `rewriteNode` (server/generation-http.ts) and the partial commit a stopped
 * or timed-out rewrite stashes for `commitPartialRewrite`. Marker stripping,
 * boundary whitespace, and the plain-regenerate word band cannot drift
 * between the two paths because both call this one function.
 */
export interface RewriteReplacementInput {
  /** Prose the stream delivered after the anchored output filter. */
  readonly streamed: string;
  readonly tag: string;
  readonly endMarker: string;
  readonly phraseMode: boolean;
  readonly bareMode: boolean;
  /** The selection's word count when the request was a plain regenerate;
   * null otherwise. The absolute word-band ceiling applies only then. */
  readonly plainRegenerateWords: number | null;
  readonly originalText: string;
  readonly start: number;
  readonly end: number;
  readonly leadingWhitespace: string;
  readonly trailingWhitespace: string;
}

export type RewriteReplacementResult =
  | { readonly kind: "replacement"; readonly text: string }
  | { readonly kind: "empty" }
  | {
      readonly kind: "over-band";
      readonly selectionWords: number;
      readonly replacementWords: number;
    };

export function rewriteReplacement(
  input: RewriteReplacementInput
): RewriteReplacementResult {
  // Small models echo the markers back despite being told not to; splicing
  // that in would put a literal <rewrite> tag into the prose. Strip them
  // defensively, including the -left/-right/-excerpt/-story wrapper variants.
  let cleaned = input.streamed.replace(
    new RegExp(`</?${input.tag}(?:-[a-z]+)?>`, "gi"),
    ""
  );
  if (input.endMarker.length > 0) {
    cleaned = cleaned.replaceAll(input.endMarker, "");
  }
  if (input.phraseMode) cleaned = stripWrappingQuotes(cleaned.trim());
  // A bare passage reply sometimes opens or closes by repeating adjacent
  // story text; that text survives the splice on both sides, so drop the
  // overlap.
  if (input.bareMode && !input.phraseMode) {
    cleaned = stripEchoedContext(
      cleaned.trim(),
      input.originalText.slice(0, input.start),
      input.originalText.slice(input.end)
    );
  }
  if (cleaned.trim().length === 0) return { kind: "empty" };
  // The word band is advisory when the user gave an instruction (it may ask
  // for more), but a plain regenerate promises "the same passage, fresh
  // words" — a model that ignores the band must not silently splice
  // paragraphs into the story, whole or truncated.
  if (input.plainRegenerateWords !== null) {
    const { high, slack } = wordBand(input.plainRegenerateWords);
    const replacementWords = countWordsForTarget(cleaned) ?? 0;
    if (replacementWords > high + slack) {
      return {
        kind: "over-band",
        selectionWords: input.plainRegenerateWords,
        replacementWords
      };
    }
  }
  return {
    kind: "replacement",
    text: input.leadingWhitespace + cleaned.trim() + input.trailingWhitespace
  };
}

export function wordBand(
  words: number
): { low: number; high: number; slack: number } {
  const slack = Math.max(3, Math.round(words * 0.2));
  return { low: Math.max(1, words - slack), high: words + slack, slack };
}

/** Unicode word segmentation, because splitting on whitespace counts a whole
 *  Chinese, Japanese, or Thai paragraph as one "word" — and the target would
 *  then order the model to collapse it into a handful. null = no trustworthy
 *  count, in which case no numeric target is sent at all. */
export function countWordsForTarget(passage: string): number | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(passage)) {
    if (segment.isWordLike === true) count++;
  }
  return count > 0 ? count : null;
}

/** Small models often wrap a bare-phrase reply in quotes despite being told
 *  not to. Strip one matched surrounding pair; interior quotes are prose and
 *  stay. */
function stripWrappingQuotes(value: string): string {
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»" };
  const first = value.length >= 2 ? value[0] : undefined;
  if (first !== undefined && pairs[first] === value.at(-1)) return value.slice(1, -1).trim();
  return value;
}

/** The verified partial a stopped or timed-out rewrite left behind, held for
 * the settle that follows the terminal. */
export interface PartialRewriteRecord {
  readonly storyId: string;
  readonly nodeId: string;
  /** The client token for the one stream that produced this prose. */
  readonly attemptId: string;
  /** The exact prose the stream delivered. The settle request must present
   * the same bytes, so the writer commits exactly what they watched arrive. */
  readonly streamed: string;
  /** Precomputed by `rewriteNode` with the request's own tag, boundary
   * whitespace, destination, and idempotency ids. `updatedAt` is stamped at
   * commit time; `cancelled` is deliberately absent — the settle is an
   * intentional post-stop save. */
  readonly effect: Omit<RewriteNodeEffect, "cancelled" | "updatedAt">;
}

const MAX_STASHED_PARTIALS = 64;

/**
 * Process-local memory of verified partial rewrites, keyed by story part and
 * attempt.
 * `rewriteNode` records at most one entry per attempt, only when the left
 * seam was verified and the cleaned prose is committable; every rejection
 * path records nothing, so a settle after a rejected boundary or echo
 * rewrite finds nothing and changes nothing. A process stop empties the
 * stash: the settle then refuses, exactly like a stopped continuation whose
 * caller-held prose died with its process.
 */
export class PartialRewriteStash {
  private readonly entries = new Map<string, PartialRewriteRecord>();

  remember(record: PartialRewriteRecord): void {
    const key = stashKey(record.storyId, record.nodeId, record.attemptId);
    this.entries.delete(key);
    if (this.entries.size >= MAX_STASHED_PARTIALS) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, record);
  }

  /** Read without consuming. The durable commit clears the record only
   * after it succeeds, so a transport or storage retry can use it again. */
  get(storyId: string, nodeId: string, attemptId: string): PartialRewriteRecord | null {
    const key = stashKey(storyId, nodeId, attemptId);
    const record = this.entries.get(key);
    return record ?? null;
  }

  /** Clear only the exact record a caller used. A delayed attempt cannot
   * clear a newer record that reused its token. */
  clear(record: PartialRewriteRecord): void {
    const key = stashKey(record.storyId, record.nodeId, record.attemptId);
    if (this.entries.get(key) === record) this.entries.delete(key);
  }
}

function stashKey(storyId: string, nodeId: string, attemptId: string): string {
  return `${storyId.length}:${storyId}${nodeId.length}:${nodeId}${attemptId}`;
}
