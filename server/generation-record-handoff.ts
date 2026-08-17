import type { ContinuationPromptEntry } from "../shared/continuation-plan.js";
import {
  promptEntriesSourceRevisionIds,
  type GenerationRecord,
  type GenerationRecordEffectiveParameters,
  type GenerationRecordPromptEntry
} from "../shared/generation-record.js";
import type { PromptOperation } from "../shared/prompt-plan.js";
import type { CapturedReasoning } from "../shared/reasoning.js";
import type { Provider, Story } from "../shared/types.js";
import type { GenerationRecordCollector } from "./generation-record-capture.js";
import { finalizeGenerationRecord, unsupportedGenerationRecord } from "./generation-record-finalize.js";
import { continuationRecordEntries } from "./generation-record-prompt.js";
import { sha256 } from "./story-format.js";

/**
 * The stop-and-save handoff (Generation Records project): what a continuation
 * request that got cancelled mid-stream leaves behind for the later, separate
 * `createNode` call the client makes to save whatever text it already
 * received. `GenerationAdmissionRegistry` carries one of these per
 * (storyId, genId), the same bounded, story/gen-scoped slot that already
 * carries the model string a stop-save reuses.
 *
 * Captured once, synchronously, right after the provider stream settles (
 * `server/generation-http.ts`'s `continueStory`, in its `raw === null`
 * branch) — never a live reference into the request's own mutable collector
 * or `Story` snapshot, both of which a later, unrelated request could still
 * be touching. `effective` is the collector's already-frozen final value
 * (every attempt's `finish()` replaces the whole object, never mutates one
 * in place — see `server/generation-record-capture.ts`), and `entries` is
 * the bounded, revision-referenced array `continuationRecordEntries` already
 * builds for a normal commit, computed eagerly instead of deferred so the
 * handoff never has to retain the `Story` or `ContinuationPlan` it was built
 * from.
 */
export interface GenerationRecordHandoff {
  readonly provider: Provider;
  readonly model: string;
  readonly operation: PromptOperation;
  /** The append target's text length before this request's own output, or
   *  null when this request was never an append. Placed relative to the
   *  target as it stood for THIS request — a later commit still supplies its
   *  own committed text length to complete the range. */
  readonly appendSegmentStart: number | null;
  readonly effective: GenerationRecordEffectiveParameters;
  readonly entries:
    | { readonly ok: true; readonly entries: readonly GenerationRecordPromptEntry[] }
    | { readonly ok: false; readonly reason: string };
  /** sha256 of exactly what this attempt emitted to `onDelta` before it
   *  stopped — not the text itself, which this bounded, story/gen-scoped
   *  slot must not retain in full. Two digests, not one, because a later
   *  stop-save commit's own append-vs-new-take decision (which can differ
   *  from this request's, e.g. a chapter break landed on the target in
   *  between — see `finalizeHandoffGenerationRecord`) decides whether the
   *  client's text should match this raw emission or its trimmed form:
   *  `emittedRawDigest` for an append (the client resends the exact streamed
   *  delta), `emittedTrimmedDigest` for a new take (every client trims
   *  trailing/leading whitespace before saving, same as a normal completion
   *  does in `generation-http.ts`). */
  readonly emittedRawDigest: string;
  readonly emittedTrimmedDigest: string;
  /** The credential-safe thought captured before the stream stopped. The
   *  later save attaches it only when its prose matches these digests. */
  readonly reasoning: CapturedReasoning | null;
}

/** Every text-revision id a handoff's captured entries reference — what
 *  `server/generation-admission.ts` pins for the life of the handoff, so the
 *  later, separate stop-save commit that finalizes this into a real
 *  Generation Record still finds those revisions readable no matter what
 *  else happened to the story in between. Empty (nothing to pin) when the
 *  entries themselves failed to capture. */
export function generationRecordHandoffRevisionIds(
  handoff: GenerationRecordHandoff
): readonly string[] {
  return handoff.entries.ok ? promptEntriesSourceRevisionIds(handoff.entries.entries) : [];
}

/** Builds a handoff from a continuation request's own state once its stream
 *  has settled. Returns null when nothing is worth handing off — the
 *  provider layer never captured an effective-parameters snapshot, which
 *  happens exactly when no attempt ever streamed a byte (`server/providers.ts`
 *  only calls the collector's `finish()` once something streamed). A caller
 *  that gets null must not register anything: there is nothing truthful to
 *  attach to a later stop-save commit. */
export function captureGenerationRecordHandoff(input: {
  readonly provider: Provider;
  readonly model: string;
  readonly operation: PromptOperation;
  readonly appendSegmentStart: number | null;
  readonly collector: GenerationRecordCollector;
  readonly story: Story;
  /** The continuation's own entries, already folded (or not) exactly as the
   *  same generation's provider request was — the caller decides that once,
   *  via `providerFoldsAuthorsNote`, and hands the result straight through
   *  rather than this function re-deciding it. */
  readonly entries: readonly ContinuationPromptEntry[];
  /** Exactly what this attempt emitted to `onDelta` before it stopped —
   *  `server/generation-http.ts`'s own `partialOutput` collector, the same
   *  text the client's stream actually received. Hashed below, never
   *  retained. */
  readonly emittedText: string;
  /** Already checked against the raw and trimmed emitted prose for provider
   *  credentials. */
  readonly reasoning: CapturedReasoning | null;
}): GenerationRecordHandoff | null {
  const effective = input.collector.effective;
  if (effective === null) return null;
  let entries: GenerationRecordHandoff["entries"];
  try {
    entries = {
      ok: true,
      entries: continuationRecordEntries(input.story, input.entries)
    };
  } catch (error) {
    entries = {
      ok: false,
      reason: error instanceof Error ? error.message : "Generation record prompt entries could not be captured."
    };
  }
  return {
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    appendSegmentStart: input.appendSegmentStart,
    effective,
    entries,
    emittedRawDigest: sha256(input.emittedText),
    emittedTrimmedDigest: sha256(input.emittedText.trim()),
    reasoning: input.reasoning
  };
}

function handoffMatchesCommittedText(
  handoff: GenerationRecordHandoff,
  appendTo: string | null,
  committedText: string
): boolean {
  const expectedDigest = appendTo === null ? handoff.emittedTrimmedDigest : handoff.emittedRawDigest;
  return sha256(committedText) === expectedDigest;
}

/**
 * Turns a captured handoff into the Generation Record a stop-save commit
 * attaches, deciding kind and range from what this commit actually does —
 * not from what the original request expected — since the story (a new
 * chapter break, say) can change between the stream stopping and the client
 * saving. An append whose range was never captured (this request was not
 * an append) becomes an explicit `kind: "unsupported"` record instead of a
 * guessed range, matching how `finalizeGenerationRecord` already turns any
 * other unsatisfiable bound into an honest stand-in rather than a silent
 * omission or a truncation.
 *
 * `input.committedText` must hash to the handoff's own digest of what this
 * genId actually streamed (raw for an append, trimmed for a new take —
 * `captureGenerationRecordHandoff` computes both) before any provenance
 * attaches. A client can reuse a real, known genId while resubmitting
 * different prose than the partial that genId actually streamed; without
 * this check the record it gets back would still cite this genId's true
 * provider, prompt, and settings for text that provider never produced. A
 * mismatch is not a guess to fall back on — it becomes the same explicit
 * `kind: "unsupported"` stand-in as any other unsatisfiable bound here,
 * never a silent omission and never a truncated match.
 */
export function finalizeHandoffGenerationRecord(
  handoff: GenerationRecordHandoff,
  input: { readonly appendTo: string | null; readonly committedText: string; readonly createdAt: string }
): GenerationRecord {
  const common = {
    createdAt: input.createdAt,
    provider: handoff.provider,
    model: handoff.model,
    operation: handoff.operation,
    collector: { effective: handoff.effective } satisfies GenerationRecordCollector
  };
  if (!handoff.entries.ok) {
    return unsupportedGenerationRecord(common, new Error(handoff.entries.reason));
  }
  if (input.appendTo !== null && handoff.appendSegmentStart === null) {
    return unsupportedGenerationRecord(
      common,
      new Error("This append's affected range was not captured before the generation stopped.")
    );
  }
  if (!handoffMatchesCommittedText(handoff, input.appendTo, input.committedText)) {
    return unsupportedGenerationRecord(
      common,
      new Error("The saved text does not match what this generation actually streamed.")
    );
  }
  const entries = handoff.entries.entries;
  const record = finalizeGenerationRecord({
    ...common,
    kind: input.appendTo === null ? "continue" : "append",
    ...(input.appendTo === null ? {} : {
      range: {
        start: handoff.appendSegmentStart!,
        end: handoff.appendSegmentStart! + input.committedText.length
      }
    }),
    entries: () => entries
  });
  // A handoff always carries a non-null `effective` (captureGenerationRecordHandoff's
  // own gate), so finalizeGenerationRecord — which returns null only when the
  // collector it reads has none — never returns null here.
  if (record === null) throw new Error("Unreachable: a Generation Record handoff always carries effective parameters");
  return record;
}

/** Returns a stopped generation's thought only for the prose that the same
 *  generation streamed. */
export function reasoningForHandoff(
  handoff: GenerationRecordHandoff | undefined,
  appendTo: string | null,
  committedText: string
): CapturedReasoning | undefined {
  if (handoff === undefined || handoff.reasoning === null) return undefined;
  return handoffMatchesCommittedText(handoff, appendTo, committedText)
    ? handoff.reasoning
    : undefined;
}

/** The stop-save Generation Record builder both commit paths need
 *  (`server/node-commit.ts`'s locked path and `server/story-service-local.ts`'s
 *  session path): finalize whatever handoff `GenerationAdmissionRegistry.
 *  withGenerationRecordHandoff` handed to this commit's own lease callback
 *  against this commit's own `appendTo`/length/time — never the original
 *  streaming request's. Returns undefined for a human take, a duplicate
 *  settle, or a genId this process never saw a handoff for — any case where
 *  the callback receives no handoff at all. */
export function generationRecordForHandoff(
  handoff: GenerationRecordHandoff | undefined,
  appendTo: string | null,
  committedText: string,
  createdAt: string
): GenerationRecord | undefined {
  if (handoff === undefined) return undefined;
  return finalizeHandoffGenerationRecord(handoff, { appendTo, committedText, createdAt });
}
