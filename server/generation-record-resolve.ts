import type {
  GenerationRecord,
  GenerationRecordPromptEntry,
  ResolvedGenerationRecord,
  ResolvedGenerationRecordPromptEntry,
  ResolvedGenerationRecordSourcePart
} from "../shared/generation-record.js";
import { StoryFormatError } from "./story-format.js";
import { createStoryReadCache, type StoryObjectStore, type StoryReadCache } from "./story-objects.js";

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
  objects: StoryObjectStore
): Promise<ResolvedGenerationRecord> {
  const cache = createStoryReadCache();
  const entries = await Promise.all(record.prompt.entries.map((entry) => resolvePromptEntry(entry, objects, cache)));
  return { ...record, prompt: { operation: record.prompt.operation, entries } };
}

async function resolvePromptEntry(
  entry: GenerationRecordPromptEntry,
  objects: StoryObjectStore,
  cache: StoryReadCache
): Promise<ResolvedGenerationRecordPromptEntry> {
  if (entry.source !== "revisions") return entry;
  const parts = await Promise.all(entry.parts.map(async (part): Promise<ResolvedGenerationRecordSourcePart> => {
    const text = await objects.readText(part.revisionId, cache);
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
  }));
  return { stability: entry.stability, kind: entry.kind, source: entry.source, parts };
}
