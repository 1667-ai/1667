import {
  createGenerationRecord,
  GenerationRecordFormatError,
  type GenerationRecord,
  type GenerationRecordKind,
  type GenerationRecordPromptEntry,
  type GenerationRecordRange
} from "../shared/generation-record.js";
import type { PromptOperation } from "../shared/prompt-plan.js";
import type { Provider } from "../shared/types.js";
import type { GenerationRecordCollector } from "./generation-record-capture.js";

export interface FinalizeGenerationRecordInput {
  readonly kind: Exclude<GenerationRecordKind, "unsupported">;
  readonly createdAt: string;
  readonly range?: GenerationRecordRange;
  readonly provider: Provider;
  readonly model: string;
  readonly operation: PromptOperation;
  /** A thunk, not a precomputed array: building entries (resolving each
   *  context part's reusable revision id and validating complete text) can
   *  itself throw on a bound this module's own inputs cannot satisfy. Calling
   *  it inside this function's own try/catch, rather than letting a caller
   *  compute it up front, is what keeps that failure from escaping as an
   *  unhandled error and losing an otherwise-successful generation — it
   *  becomes an explicit `kind: "unsupported"` record instead, same as any
   *  other bound violation this function catches. */
  readonly entries: () => readonly GenerationRecordPromptEntry[];
  readonly collector: GenerationRecordCollector;
}

/** Build the record a successful (or stopped-partial) generation commits
 *  alongside its node. Returns null only when the provider layer never
 *  reached a point worth recording — `options.generationRecord` was passed
 *  through but no attempt ever streamed output — which happens only when the
 *  caller ultimately has no take to attach a record to either. A bound this
 *  module's own inputs cannot satisfy (a pathologically large prompt, a
 *  malformed field) is never silently dropped: it becomes an explicit
 *  `kind: "unsupported"` record instead, so the history stays honest. */
export function finalizeGenerationRecord(input: FinalizeGenerationRecordInput): GenerationRecord | null {
  const effective = input.collector.effective;
  if (effective === null) return null;
  try {
    return createGenerationRecord({
      kind: input.kind,
      createdAt: input.createdAt,
      ...(input.range === undefined ? {} : { range: input.range }),
      provider: { provider: input.provider, model: input.model },
      effective,
      prompt: { operation: input.operation, entries: input.entries() }
    });
  } catch (error) {
    return unsupportedGenerationRecord(input, error);
  }
}

/** Every provider effect that succeeds must carry a Generation Record — this
 *  is the one call `continueStory`, `rewriteNode`, `createSummaryTake`, and
 *  `summarizeChapter` each make instead of `finalizeGenerationRecord`
 *  directly, so none of them can construct their effect with a record
 *  omitted. `finalizeGenerationRecord` returns null only when the provider
 *  layer never reached a point worth recording (no attempt ever streamed
 *  output) — a state each of those callers only reaches before it has any
 *  take to attach a record to, never on the success path that builds the
 *  effect. The explicit `unsupported` stand-in below covers that gap
 *  honestly instead of leaving the field absent. */
export function finalizeRequiredGenerationRecord(input: FinalizeGenerationRecordInput): GenerationRecord {
  return finalizeGenerationRecord(input) ?? unsupportedGenerationRecord(
    input,
    new Error("No provider output was captured before this generation record was finalized.")
  );
}

/** An explicit stand-in for a production path that could not safely capture
 *  a full record — never a silent omission. Callers that have not yet wired
 *  a capture seam for one generation kind can call this directly instead of
 *  `finalizeGenerationRecord`. */
export function unsupportedGenerationRecord(
  input: Pick<FinalizeGenerationRecordInput, "createdAt" | "range" | "provider" | "model" | "operation" | "collector">,
  reason: unknown
): GenerationRecord {
  const effective = input.collector.effective ?? { wireProtocol: "dry-run" as const, fields: [], adjustments: [] };
  return createGenerationRecord({
    kind: "unsupported",
    createdAt: input.createdAt,
    ...(input.range === undefined ? {} : { range: input.range }),
    provider: { provider: input.provider, model: input.model },
    effective,
    prompt: { operation: input.operation, entries: [] },
    unsupportedReason: reason instanceof GenerationRecordFormatError || reason instanceof Error
      ? reason.message
      : "Generation record capture could not be completed for this request."
  });
}

/** A request that started as an append can become a new take at commit time
 * when a chapter break appears behind its target while the model streams.
 * Move the historical event into the new take's coordinate space: an append
 * becomes a whole-take continuation, and any unsupported event loses the
 * stale range it inherited from the old target. */
export function generationRecordRetargetedToNewTake(record: GenerationRecord): GenerationRecord {
  if (record.kind !== "append" && record.range === undefined) return record;
  return createGenerationRecord({
    kind: record.kind === "append" ? "continue" : record.kind,
    createdAt: record.createdAt,
    provider: record.provider,
    effective: record.effective,
    prompt: record.prompt,
    ...(record.unsupportedReason === undefined ? {} : { unsupportedReason: record.unsupportedReason })
  });
}

/** A rewrite requested against `take` can still land in place — a
 *  chapter-summary target always replaces in place, no matter what the
 *  caller asked for (`applyRewrite`, server/story-provider-effect.ts, is the
 *  one place that decides this). The record built before that decision was
 *  known still says `rewrite-take`; correct it here so the immutable record
 *  never claims a take that was never minted. The splice range is unaffected
 *  by where the result lands, so it carries over unchanged. */
export function generationRecordSettledInPlace(record: GenerationRecord): GenerationRecord {
  if (record.kind !== "rewrite-take") return record;
  return createGenerationRecord({
    kind: "rewrite-in-place",
    createdAt: record.createdAt,
    ...(record.range === undefined ? {} : { range: record.range }),
    provider: record.provider,
    effective: record.effective,
    prompt: record.prompt,
    ...(record.unsupportedReason === undefined ? {} : { unsupportedReason: record.unsupportedReason })
  });
}
