import type {
  GenerationRecord,
  GenerationRecordPromptEntry,
  ResolvedGenerationRecord,
  ResolvedGenerationRecordPromptEntry,
  ResolvedGenerationRecordSourcePart
} from "../shared/generation-record.js";
import { mapWithConcurrency } from "./concurrency.js";
import { StoryFormatError } from "./story-format.js";
import { createStoryReadCache, type StoryObjectStore, type StoryReadCache } from "./story-objects.js";

/** Matches `StoryObjectStore`'s own `TEXT_IO_CONCURRENCY` — the bound it
 *  already applies to bulk full-text reads elsewhere (`readTexts`,
 *  `storeTexts`). A source entry can carry up to `MAX_GENERATION_RECORD_
 *  SOURCE_PARTS` (8,192) parts, so resolving them with a plain `Promise.all`
 *  could open thousands of file descriptors at once. */
const SOURCE_PART_IO_CONCURRENCY = 4;

/**
 * Resolves a stored, reference-based Generation Record into the read model
 * `server/stories.ts`'s `loadGenerationRecord` hands to the HTTP route and
 * the worker protocol: every source part's prose read back from its exact
 * historical text-revision, verified by content hash on the way (
 * `StoryObjectStore.readText` never returns bytes that don't match the
 * revision they were requested by). The stored shape stays reference-based
 * so a record never duplicates the story's own growing prose — this is the
 * one place that pays the read cost, on demand, per record.
 */
export async function resolveGenerationRecord(
  record: GenerationRecord,
  objects: StoryObjectStore,
  signal?: AbortSignal
): Promise<ResolvedGenerationRecord> {
  signal?.throwIfAborted();
  const cache = createStoryReadCache();
  // Resolve source entries one at a time. Each source entry has its own
  // bounded worker pool below. This keeps the limit global to one detail
  // read instead of multiplying it by the number of source entries.
  const entries = await mapWithConcurrency(
    record.prompt.entries,
    1,
    (entry) => resolvePromptEntry(entry, objects, cache, signal)
  );
  signal?.throwIfAborted();
  return { ...record, prompt: { operation: record.prompt.operation, entries } };
}

async function resolvePromptEntry(
  entry: GenerationRecordPromptEntry,
  objects: StoryObjectStore,
  cache: StoryReadCache,
  signal?: AbortSignal
): Promise<ResolvedGenerationRecordPromptEntry> {
  signal?.throwIfAborted();
  if (entry.source !== "revisions") return entry;
  const parts = await mapWithConcurrency(
    entry.parts,
    SOURCE_PART_IO_CONCURRENCY,
    async (part): Promise<ResolvedGenerationRecordSourcePart> => {
      signal?.throwIfAborted();
      const text = await objects.readText(part.revisionId, cache);
      signal?.throwIfAborted();
      if (text.length !== part.textLength) {
        throw new StoryFormatError(
          `Generation record source text length mismatch for node ${part.nodeId}: expected ${part.textLength}, read ${text.length}`
        );
      }
      return {
        nodeId: part.nodeId,
        category: part.category,
        instruction: part.instruction,
        revisionId: part.revisionId,
        text
      };
    }
  );
  return { stability: entry.stability, kind: entry.kind, source: entry.source, parts };
}
