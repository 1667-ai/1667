import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  parseMutationReceipt,
  type MutationReceipt,
  type RemovedChapterBreakResult
} from "./mutation-receipt-codec.js";
import type { ObjectHash } from "./story-format.js";
import { readUnsealedFile } from "./vault-file-read.js";

export const MUTATION_RECEIPT_DIRECTORY = "mutation-receipts";

/** The narrow read StoryStore needs from the receipt store: the Generation
 *  Record ids a durable chapter-break removal receipt still holds live for
 *  one story. Injected so StoryStore never learns receipt paths or codecs. */
export type ChapterBreakUndoLiveness = (storyId: string) => readonly ObjectHash[];

/** Isolated StoryStore callers (most tests, offline tooling) have no receipt
 *  store to ask, and never exercise chapter-break undo: nothing is live. */
export const NO_CHAPTER_BREAK_UNDO_LIVENESS: ChapterBreakUndoLiveness = () => [];

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

  async hydrate(
    dir: string,
    onMalformed: (mutationId: string, error: unknown) => Promise<void> | void
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const mutationId = entry.name.slice(0, -".json".length);
      try {
        const file = path.join(dir, entry.name);
        const receipt = parseMutationReceipt(
          JSON.parse((await readUnsealedFile(file)).toString("utf8")),
          mutationId
        );
        this.observe(receipt);
      } catch (error) {
        await onMalformed(mutationId, error);
      }
    }
  }

  /** Fold one receipt's chapter-break removal liveness into the view. Safe to
   *  call for every receipt save, of every method: a receipt with no such
   *  artifact or result simply contributes nothing. */
  observe(receipt: MutationReceipt): void {
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
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
