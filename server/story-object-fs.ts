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
 * Records project); a reasoning object is one take's captured thought
 * (shared/reasoning.ts); an images object is one Normalized Image's raw
 * bytes (shared/image-attachment.ts), hashed and stored with no JSON codec;
 * an aside object is one story's bounded Side Note document
 * (shared/aside.ts). */
export type ObjectKind =
  | "chunks"
  | "revisions"
  | "probabilities"
  | "generation-records"
  | "reasoning"
  | "images"
  | "aside";

/** The on-disk extension for one object kind, kept as the single table every
 * writer and reader shares. `objectFilename` below, `objectPath`
 * (server/story-objects.ts), and the sweep's suffix strip all read this same
 * table rather than repeating the choice, so the three can never disagree —
 * a disagreement would make the sweep silently ignore or delete files of
 * that kind. Text kinds keep `.json`; `chunks` keeps its historical `.txt`;
 * an image is binary, so it gets its own extension and no JSON codec. */
export const OBJECT_EXTENSIONS: Record<ObjectKind, string> = {
  chunks: ".txt",
  revisions: ".json",
  probabilities: ".json",
  "generation-records": ".json",
  reasoning: ".json",
  images: ".bin",
  aside: ".json"
};

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
  return `${hash}${OBJECT_EXTENSIONS[kind]}`;
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
