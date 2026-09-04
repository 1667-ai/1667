import { readdir } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "./concurrency.js";
import {
  parseMutationReceipt,
  type MutationReceipt,
  type RemovedChapterBreakResult
} from "./mutation-receipt-codec.js";
import type { ObjectHash } from "./story-format.js";
import { readUnsealedFile } from "./vault-file-read.js";

export const MUTATION_RECEIPT_DIRECTORY = "mutation-receipts";

/** Receipt replay keeps run leaves live for the receipt retention period, so a
 *  story's directory can accumulate many receipts; bound hydration's
 *  concurrent reads instead of opening every file at once (matches the small,
 *  explicit IO ceilings elsewhere, e.g. `story-objects.ts`'s
 *  `TEXT_IO_CONCURRENCY`). */
const HYDRATE_IO_CONCURRENCY = 8;

/** The narrow read StoryStore needs from the receipt store: the Generation
 *  Record ids a durable chapter-break removal receipt still holds live for
 *  one story. Injected so StoryStore never learns receipt paths or codecs. */
export type ChapterBreakUndoLiveness = (storyId: string) => readonly ObjectHash[];
export type FactConsistencyRunLiveness = (storyId: string) => readonly ObjectHash[];

/** Isolated StoryStore callers (most tests, offline tooling) have no receipt
 *  store to ask, and never exercise chapter-break undo: nothing is live. */
export const NO_CHAPTER_BREAK_UNDO_LIVENESS: ChapterBreakUndoLiveness = () => [];
export const NO_FACT_CONSISTENCY_RUN_LIVENESS: FactConsistencyRunLiveness = () => [];

/** Story-indexed view of Generation Record ids held live by a durable
 *  chapter-break removal receipt: its pre-commit artifact lease, or a
 *  completed receipt's legacy inline result. `hydrate` builds the view once,
 *  by scanning the receipt directory; after that, `observe` keeps it current
 *  from receipts the owning store has itself just saved durably, so the view
 *  never needs to rescan the directory or re-read a file it has already
 *  parsed. A malformed file that `hydrate` cannot parse is reported through
 *  its caller and otherwise skipped, so it never withholds liveness for
 *  every other story. */
export class ChapterBreakLivenessIndex {
  private readonly byStory = new Map<string, Set<ObjectHash>>();
  private readonly factConsistencyByStory = new Map<
    string,
    Map<ObjectHash, FactConsistencyRunLease>
  >();

  async hydrate(
    dir: string,
    onMalformed: (mutationId: string, error: unknown) => Promise<void> | void,
    readFile: (file: string) => Promise<Buffer> = readUnsealedFile
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    const receiptFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    // Each file's parse and `observe` fold run inside the worker's own
    // try/catch, so a slow or malformed reader never blocks another file's
    // read; `observe`'s set unions are commutative and JS callbacks never
    // interleave mid-statement, so completion order cannot change the result.
    await mapWithConcurrency(receiptFiles, HYDRATE_IO_CONCURRENCY, async (name) => {
      const mutationId = name.slice(0, -".json".length);
      try {
        const file = path.join(dir, name);
        const receipt = parseMutationReceipt(
          JSON.parse((await readFile(file)).toString("utf8")),
          mutationId
        );
        this.observe(receipt);
      } catch (error) {
        await onMalformed(mutationId, error);
      }
    });
  }

  /** Fold one receipt's chapter-break removal liveness into the view. Safe to
   *  call for every receipt save, of every method: a receipt with no such
   *  artifact or result simply contributes nothing. */
  observe(receipt: MutationReceipt): void {
    const factConsistency = receipt.result?.type === "fact-consistency"
      ? { storyId: receipt.result.id, runHash: receipt.result.runHash }
      : receipt.artifact?.kind === "fact-consistency-run"
        ? { storyId: receipt.artifact.storyId, runHash: receipt.artifact.runHash }
        : undefined;
    if (factConsistency?.runHash !== undefined) {
      const leases = this.factConsistencyByStory.get(factConsistency.storyId)
        ?? new Map<ObjectHash, FactConsistencyRunLease>();
      const storyId = factConsistency.storyId;
      const runHash = factConsistency.runHash;
      leases.set(runHash as ObjectHash, {
        runHash: runHash as ObjectHash,
        createdAt: receipt.createdAt,
        mutationId: receipt.mutationId
      });
      // A completed worker receipt remains replayable for the same retention
      // period as every other receipt. Keep every receipt-owned run live so
      // cleanup cannot break an older exact replay when a story has many runs.
      this.factConsistencyByStory.set(storyId, leases);
    }
    const result = receipt.result?.type === "chapter-break-removed" ? receipt.result : undefined;
    const artifact = receipt.artifact?.kind === "chapter-break-removal" ? receipt.artifact : undefined;
    const storyId = artifact?.storyId ?? result?.id;
    if (storyId === undefined) return;
    const removed: RemovedChapterBreakResult | undefined = artifact?.value ?? result?.removed;
    if (removed === undefined) return;
    const ids = this.byStory.get(storyId) ?? new Set<ObjectHash>();
    for (const summary of removed.summaries) {
      for (const id of summary.generationRecordIds ?? []) ids.add(id as ObjectHash);
    }
    if (ids.size > 0) this.byStory.set(storyId, ids);
  }

  liveGenerationRecordIds(storyId: string): readonly ObjectHash[] {
    return [...(this.byStory.get(storyId) ?? [])];
  }

  /** Keep every receipt-owned Fact consistency run readable for completed-
   *  receipt replay, even after newer runs replace the story pointer. */
  liveFactConsistencyRunIds(storyId: string): readonly ObjectHash[] {
    return [...(this.factConsistencyByStory.get(storyId)?.values() ?? [])]
      .sort(compareFactConsistencyLeases)
      .map((lease) => lease.runHash);
  }
}

interface FactConsistencyRunLease {
  readonly runHash: ObjectHash;
  readonly createdAt: string;
  readonly mutationId: string;
}

function compareFactConsistencyLeases(
  left: FactConsistencyRunLease,
  right: FactConsistencyRunLease
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.mutationId.localeCompare(right.mutationId);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
