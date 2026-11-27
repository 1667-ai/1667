/**
 * The object kinds a story bundle stores and their on-disk extensions.
 *
 * This module imports nothing. `server/story-object-fs.ts` re-exports both
 * declarations, so every existing reader keeps its import site, and
 * `server/vault-seal-binding.ts` can read the same table without pulling in
 * `server/bounded-file.ts`, which depends on the vault key registry the
 * binding itself serves.
 */

/** The kinds of immutable object a story bundle stores. */
export type ObjectKind =
  | "chunks"
  | "revisions"
  | "probabilities"
  | "generation-records"
  | "reasoning"
  | "images"
  | "aside"
  | "fact-consistency";

/** The on-disk extension for one object kind, kept as the single table every
 * writer and reader shares. `objectFilename` and `objectPath`
 * (server/story-objects.ts), the sweep's suffix strip, and the vault seal
 * binding all read this same table rather than repeating the choice, so they
 * can never disagree — a disagreement would make the sweep silently ignore or
 * delete files of that kind, or make a sealed object fail to authenticate.
 * Text kinds keep `.json`; `chunks` keeps its historical `.txt`; an image is
 * binary, so it gets its own extension and no JSON codec. */
export const OBJECT_EXTENSIONS: Record<ObjectKind, string> = {
  chunks: ".txt",
  revisions: ".json",
  probabilities: ".json",
  "generation-records": ".json",
  reasoning: ".json",
  images: ".bin",
  aside: ".json",
  "fact-consistency": ".json"
};

export function isObjectKind(value: string): value is ObjectKind {
  return Object.prototype.hasOwnProperty.call(OBJECT_EXTENSIONS, value);
}
