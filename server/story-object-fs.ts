import { readBoundedFile } from "./bounded-file.js";
import { StoryFormatError, sha256, type ObjectHash } from "./story-format.js";

/**
 * Pure filesystem helpers for `server/story-objects.ts`'s `StoryObjectStore`,
 * split out to keep that stateful class under the repository's file-size
 * guideline. Nothing here touches `this` — every function takes exactly the
 * bytes, path, kind, or error it needs.
 */

/** The kinds of immutable object a story bundle stores. A revision's chunks
 * are the prose; a revision is the ordered chunk list; a probabilities
 * object is one take's captured token probabilities (issue #291 phase 3); a
 * generation-records object is one Generation Record event (Generation
 * Records project). */
export type ObjectKind = "chunks" | "revisions" | "probabilities" | "generation-records";

export class SweepCancelled extends Error {}

export function requireSweepActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new SweepCancelled();
}

export async function readIfPresent(file: string, maxBytes: number, label: string): Promise<Buffer | null> {
  try {
    return await readBoundedFile(file, maxBytes, label);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export function verifyExactObject(
  actual: Buffer,
  expected: Buffer,
  kind: ObjectKind,
  hash: ObjectHash
): void {
  if (sha256(actual) !== hash || !actual.equals(expected)) {
    throw new StoryFormatError(`Existing ${kind} object is corrupt: ${hash}`);
  }
}

export function objectFilename(kind: ObjectKind, hash: ObjectHash): string {
  return `${hash}${kind === "chunks" ? ".txt" : ".json"}`;
}

export function isLinkFallback(error: unknown): boolean {
  return ["EXDEV", "EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ENOENT"]
    .some((code) => isErrorCode(error, code));
}

export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function drainPromises(promises: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}
