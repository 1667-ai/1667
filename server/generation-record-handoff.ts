import type { ContinuationPlan } from "../shared/continuation-plan.js";
import {
  promptEntriesSourceRevisionIds,
  type GenerationRecord,
  type GenerationRecordEffectiveParameters,
  type GenerationRecordPromptEntry
} from "../shared/generation-record.js";
import type { PromptOperation } from "../shared/prompt-plan.js";
import type { Provider, Story } from "../shared/types.js";
import type { GenerationRecordCollector } from "./generation-record-capture.js";
import { finalizeGenerationRecord, unsupportedGenerationRecord } from "./generation-record-finalize.js";
import { continuationRecordEntries } from "./generation-record-prompt.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";

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
  readonly continuation: ContinuationPlan;
  readonly foldAuthorsNote?: boolean;
}): GenerationRecordHandoff | null {
  const effective = input.collector.effective;
  if (effective === null) return null;
  let entries: GenerationRecordHandoff["entries"];
  try {
    entries = {
      ok: true,
      entries: continuationRecordEntries(input.story, input.continuation, input.foldAuthorsNote)
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
    entries
  };
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
 */
export function finalizeHandoffGenerationRecord(
  handoff: GenerationRecordHandoff,
  input: { readonly appendTo: string | null; readonly committedTextLength: number; readonly createdAt: string }
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
  const entries = handoff.entries.entries;
  const record = finalizeGenerationRecord({
    ...common,
    kind: input.appendTo === null ? "continue" : "append",
    ...(input.appendTo === null ? {} : {
      range: {
        start: handoff.appendSegmentStart!,
        end: handoff.appendSegmentStart! + input.committedTextLength
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

/** The stop-save Generation Record lookup both commit paths need
 *  (`server/node-commit.ts`'s locked path and `server/story-service-local.ts`'s
 *  session path): read back whatever `captureGenerationRecordHandoff` left in
 *  the registry for this genId, keyed the same way `modelFor` already is, and
 *  finalize it against this commit's own `appendTo`/length/time — never the
 *  original streaming request's. Returns undefined for a human take (`genId`
 *  null) or a genId this process never saw a handoff for. */
export function generationRecordForCommit(
  registry: GenerationAdmissionRegistry,
  storyId: string,
  genId: string | null,
  appendTo: string | null,
  committedTextLength: number,
  createdAt: string
): GenerationRecord | undefined {
  if (genId === null) return undefined;
  const handoff = registry.generationRecordHandoffFor(storyId, genId);
  if (handoff === undefined) return undefined;
  return finalizeHandoffGenerationRecord(handoff, { appendTo, committedTextLength, createdAt });
}
