import type { ResolvedGenerationRecord } from "../../shared/generation-record.js";

/** How many resolved details the Generation Record Viewer keeps warm at
 *  once. A take can carry up to `MAX_GENERATION_RECORD_IDS` (4,096, see
 *  shared/types.ts) Generation Records, so caching every fully resolved
 *  detail seen while paging through one would retain unbounded memory. This
 *  bound trades a re-fetch at the tail of a long paging session for a fixed
 *  ceiling, while keeping the common case — stepping a few events back and
 *  forth — instant. */
export const GENERATION_RECORD_DETAIL_CACHE_BOUND = 8;

/** Least-recently-used cache for resolved Generation Record details, bounded
 *  to `GENERATION_RECORD_DETAIL_CACHE_BOUND` entries by default. `get` counts
 *  as a use: it promotes the entry to most-recently-used the same as `set`,
 *  so repeated back-navigation within the bound never evicts the entries it
 *  depends on. */
export interface GenerationRecordDetailCache {
  get(id: string): ResolvedGenerationRecord | undefined;
  set(id: string, detail: ResolvedGenerationRecord): void;
}

export function createGenerationRecordDetailCache(
  bound: number = GENERATION_RECORD_DETAIL_CACHE_BOUND
): GenerationRecordDetailCache {
  const entries = new Map<string, ResolvedGenerationRecord>();
  return {
    get(id) {
      const detail = entries.get(id);
      if (detail === undefined) return undefined;
      // Reinsert to move this key to the end — Map iteration order is
      // insertion order, so the front is always the least recently used.
      entries.delete(id);
      entries.set(id, detail);
      return detail;
    },
    set(id, detail) {
      entries.delete(id);
      entries.set(id, detail);
      if (entries.size > bound) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    }
  };
}
