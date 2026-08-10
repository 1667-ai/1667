import type { RewriteNodeEffect } from "./story-provider-effect.js";
import { stripEchoedContext } from "./rewrite-output.js";
import { ServiceError } from "./errors.js";
import {
  MAX_GENERATION_RECORD_BYTES,
  serializeGenerationRecord,
  type GenerationRecord
} from "../shared/generation-record.js";

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
  /** Fixed-size identity of the exact prose that the stream delivered. */
  readonly streamedDigest: string;
  /** Precomputed by `rewriteNode` with the request's own tag, boundary
   * whitespace, destination, and idempotency ids. `updatedAt` is stamped at
   * commit time; `cancelled` is deliberately absent — the settle is an
   * intentional post-stop save. */
  readonly effect: Omit<RewriteNodeEffect, "cancelled" | "updatedAt">;
}

const MAX_STASHED_PARTIALS = 64;
export const MAX_STASHED_PARTIAL_BYTES = 64 * 1024 * 1024;

const RETAINED_RECORD_BASE_BYTES = 512;
const RETAINED_STRING_BASE_BYTES = 16;
const RETAINED_RANGE_BYTES = 32;
const RETAINED_GENERATION_RECORD_BASE_BYTES = 512;
/** Worst case a finalized `effect.generationRecord` can ever retain: the
 *  codec's own `MAX_GENERATION_RECORD_BYTES` cap on its canonical UTF-8
 *  encoding, doubled the same way `retainedStringBytes` doubles a string's
 *  byte length to bound its UTF-16 storage. */
const MAXIMUM_GENERATION_RECORD_RETAINED_BYTES = RETAINED_GENERATION_RECORD_BASE_BYTES
  + MAX_GENERATION_RECORD_BYTES * 2;

/** Deterministic upper estimate for the variable storage one partial record
 * retains. The entry-count limit covers fixed Map and object overhead. */
export function partialRewriteRecordRetainedBytes(
  record: PartialRewriteRecord
): number {
  const effect = record.effect;
  let bytes = RETAINED_RECORD_BASE_BYTES
    + retainedStringBytes(record.storyId)
    + retainedStringBytes(record.nodeId)
    + retainedStringBytes(record.attemptId)
    + retainedStringBytes(record.streamedDigest)
    + retainedStringBytes(effect.kind)
    + retainedStringBytes(effect.nodeId)
    + retainedStringBytes(effect.expectedText)
    + retainedStringBytes(effect.expectedInstruction)
    + retainedStringBytes(effect.text);
  if (effect.expectedUpdatedAt !== undefined) {
    bytes += retainedStringBytes(effect.expectedUpdatedAt);
  }
  if (effect.rewriteId !== undefined) bytes += retainedStringBytes(effect.rewriteId);
  if (effect.takeId !== undefined) bytes += retainedStringBytes(effect.takeId);
  if (effect.destination !== undefined) bytes += retainedStringBytes(effect.destination);
  if (effect.attribution !== undefined && effect.attribution !== null) {
    bytes += 64
      + retainedStringBytes(effect.attribution.source)
      + effect.attribution.ranges.length * RETAINED_RANGE_BYTES;
  }
  if (effect.rewrittenSpans !== undefined) {
    bytes += 32 + effect.rewrittenSpans.length * RETAINED_RANGE_BYTES;
  }
  bytes += generationRecordRetainedBytes(effect.generationRecord);
  return bytes;
}

/** Every stashed rewrite carries the Generation Record its own commit will
 *  attach — this is that record's contribution to the retained-byte total,
 *  computed from its canonical serialized form so the estimate tracks the
 *  same bytes `MAX_GENERATION_RECORD_BYTES` bounds. */
function generationRecordRetainedBytes(record: GenerationRecord): number {
  const serialized = serializeGenerationRecord(record);
  return RETAINED_GENERATION_RECORD_BASE_BYTES
    + Math.max(Buffer.byteLength(serialized), serialized.length * 2);
}

/** Reserve before streaming against the largest record this request can
 *  produce, including provider-secret redaction expansion and the Generation
 *  Record the eventual commit will attach. `originalRecord` is built before
 *  the stream starts, so its `effect.generationRecord` is normally still the
 *  small `unsupported` stand-in `finalizeRequiredGenerationRecord`
 *  (server/generation-record-finalize.ts) falls back to before the capture
 *  collector resolves — but the reservation must already cover the worst
 *  case the later `remember()` can present. Topping the existing
 *  contribution up to the codec's own max (rather than always adding the
 *  max) keeps this correct even if a caller ever does pass an
 *  already-populated record. */
export function maximumPartialRewriteRecordRetainedBytes(
  originalRecord: PartialRewriteRecord,
  maximumRetainedProviderOutputBytes: number
): number {
  if (!Number.isSafeInteger(maximumRetainedProviderOutputBytes)
    || maximumRetainedProviderOutputBytes < 0) {
    throw new Error("Partial rewrite output reservation must be a non-negative safe integer");
  }
  const existingGenerationRecordBytes = generationRecordRetainedBytes(
    originalRecord.effect.generationRecord
  );
  const maximumRecordBytes = partialRewriteRecordRetainedBytes(originalRecord)
    + maximumRetainedProviderOutputBytes
    + Math.max(0, MAXIMUM_GENERATION_RECORD_RETAINED_BYTES - existingGenerationRecordBytes);
  if (!Number.isSafeInteger(maximumRecordBytes)) {
    throw new Error("Partial rewrite storage reservation exceeds the safe integer range");
  }
  return maximumRecordBytes;
}

function retainedStringBytes(value: string): number {
  return RETAINED_STRING_BASE_BYTES
    + Math.max(Buffer.byteLength(value), value.length * 2);
}

export interface PartialRewriteReservation {
  readonly storyId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  record: PartialRewriteRecord | null;
  settlementId: string | null;
  accountedBytes: number;
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
}

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
  private readonly entries = new Map<string, PartialRewriteReservation>();
  private readonly claims = new Set<PartialRewriteReservation>();
  private accountedBytes = 0;

  /** Reserve before provider work can emit text. A full stash refuses the
   * next rewrite instead of evicting prose that another writer can settle. */
  reserve(
    storyId: string,
    nodeId: string,
    attemptId: string,
    maximumRecordBytes: number
  ): PartialRewriteReservation {
    const key = stashKey(storyId, nodeId, attemptId);
    if (this.entries.has(key)) {
      throw new ServiceError(409, "This rewrite attempt is already active.");
    }
    if (this.entries.size >= MAX_STASHED_PARTIALS) {
      throw new ServiceError(
        429,
        "Too many rewrites are waiting to finish. Settle a stopped rewrite and try again."
      );
    }
    if (!Number.isSafeInteger(maximumRecordBytes) || maximumRecordBytes < 0) {
      throw new Error("Partial rewrite reservation must be a non-negative safe integer");
    }
    if (maximumRecordBytes > MAX_STASHED_PARTIAL_BYTES - this.accountedBytes) {
      throw new ServiceError(
        429,
        "Too much rewrite text is waiting to finish. Settle a stopped rewrite and try again."
      );
    }
    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const reservation = {
      storyId,
      nodeId,
      attemptId,
      record: null,
      settlementId: null,
      accountedBytes: maximumRecordBytes,
      ready,
      resolveReady
    };
    this.entries.set(key, reservation);
    this.accountedBytes += maximumRecordBytes;
    return reservation;
  }

  remember(
    reservation: PartialRewriteReservation,
    record: PartialRewriteRecord
  ): void {
    const key = stashKey(record.storyId, record.nodeId, record.attemptId);
    if (this.entries.get(key) !== reservation) {
      throw new Error("Partial rewrite reservation is no longer active");
    }
    const retainedBytes = partialRewriteRecordRetainedBytes(record);
    if (retainedBytes > reservation.accountedBytes) {
      throw new Error("Partial rewrite exceeded its pre-stream storage reservation");
    }
    this.accountedBytes -= reservation.accountedBytes - retainedBytes;
    reservation.accountedBytes = retainedBytes;
    reservation.record = record;
    reservation.resolveReady();
  }

  /** Read without consuming. Generation tests and diagnostics use this to
   * inspect the verified record; settlement uses `claim` instead. */
  get(storyId: string, nodeId: string, attemptId: string): PartialRewriteRecord | null {
    const key = stashKey(storyId, nodeId, attemptId);
    return this.entries.get(key)?.record ?? null;
  }

  /** Atomically grant one settlement exclusive use of the record. A failed
   * durable commit releases the claim, while success clears the record. */
  async claim(
    storyId: string,
    nodeId: string,
    attemptId: string
  ): Promise<PartialRewriteRecord | null> {
    const key = stashKey(
      storyId,
      nodeId,
      attemptId
    );
    let reservation = this.entries.get(key);
    if (reservation?.record === null) {
      // Stop settlement can overtake the generation handler while it still
      // validates and records the accepted tail. Wait for remember() or the
      // handler's finally block instead of reporting a permanent miss.
      await reservation.ready;
      reservation = this.entries.get(key);
    }
    if (reservation === undefined
      || reservation.record === null
      || this.claims.has(reservation)) {
      return null;
    }
    this.claims.add(reservation);
    return reservation.record;
  }

  releaseClaim(record: PartialRewriteRecord): void {
    const reservation = this.entries.get(stashKey(
      record.storyId,
      record.nodeId,
      record.attemptId
    ));
    if (reservation?.record === record) this.claims.delete(reservation);
  }

  /** Bind the record to the first canonical mutation that tries to settle it.
   * A retry with that identity can retire the record after ledger recovery;
   * another identity cannot apply the same verified prose again. */
  bindSettlement(record: PartialRewriteRecord, settlementId: string): boolean {
    const reservation = this.entries.get(stashKey(
      record.storyId,
      record.nodeId,
      record.attemptId
    ));
    if (reservation?.record !== record) return false;
    reservation.settlementId ??= settlementId;
    return reservation.settlementId === settlementId;
  }

  settlementMatches(record: PartialRewriteRecord, settlementId: string): boolean {
    const reservation = this.entries.get(stashKey(
      record.storyId,
      record.nodeId,
      record.attemptId
    ));
    return reservation?.record === record
      && reservation.settlementId === settlementId;
  }

  /** Clear only the exact record a caller used. A delayed attempt cannot
   * clear a newer record that reused its token. */
  clear(record: PartialRewriteRecord): void {
    const key = stashKey(record.storyId, record.nodeId, record.attemptId);
    const reservation = this.entries.get(key);
    if (reservation?.record === record) {
      reservation.resolveReady();
      this.claims.delete(reservation);
      this.entries.delete(key);
      this.accountedBytes -= reservation.accountedBytes;
    }
  }

  releaseEmpty(reservation: PartialRewriteReservation): void {
    const key = stashKey(
      reservation.storyId,
      reservation.nodeId,
      reservation.attemptId
    );
    if (this.entries.get(key) === reservation && reservation.record === null) {
      reservation.resolveReady();
      this.entries.delete(key);
      this.accountedBytes -= reservation.accountedBytes;
    }
  }

  /** Release all volatile rewrite prose when its service closes. */
  clearAll(): void {
    for (const reservation of this.entries.values()) {
      reservation.resolveReady();
    }
    this.claims.clear();
    this.entries.clear();
    this.accountedBytes = 0;
  }
}

function stashKey(storyId: string, nodeId: string, attemptId: string): string {
  return `${storyId.length}:${storyId}${nodeId.length}:${nodeId}${attemptId}`;
}
