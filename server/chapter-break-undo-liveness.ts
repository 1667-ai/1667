import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseMutationReceipt, type RemovedChapterBreakResult } from "./mutation-receipt-codec.js";
import type { ObjectHash } from "./story-format.js";
import { readUnsealedFile } from "./vault-file-read.js";

export const MUTATION_RECEIPT_DIRECTORY = "mutation-receipts";

/** Generation Record objects held by durable chapter-break removal receipts.
 *  The receipt is the undo payload's durable lease: it exists before the
 *  summary leaves the manifest and remains available for request replay. */
export async function chapterBreakUndoGenerationRecordIds(
  receiptDir: string,
  storyId: string,
  signal?: AbortSignal
): Promise<ObjectHash[]> {
  let entries;
  try {
    entries = await readdir(receiptDir, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const ids = new Set<ObjectHash>();
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const mutationId = entry.name.slice(0, -".json".length);
    const file = path.join(receiptDir, entry.name);
    const receipt = parseMutationReceipt(JSON.parse((await readUnsealedFile(file)).toString("utf8")), mutationId);
    const result = receipt.result?.type === "chapter-break-removed" ? receipt.result : undefined;
    const artifact = receipt.artifact?.kind === "chapter-break-removal" ? receipt.artifact : undefined;
    const owner = artifact?.storyId ?? result?.id;
    if (owner !== storyId) continue;
    const removed: RemovedChapterBreakResult | undefined = artifact?.value ?? result?.removed;
    for (const summary of removed?.summaries ?? []) {
      for (const id of summary.generationRecordIds ?? []) ids.add(id as ObjectHash);
    }
  }
  return [...ids];
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
