import { estimateTokens } from "./tokens.js";

export const MAX_AUTHORS_NOTE_CHARS = 4_000;
export const AUTHORS_NOTE_WARN_TOKENS = 300;

/** How many story parts from the end the note lands before. 1 is today's
 *  fixed placement: immediately before the last part. */
export const DEFAULT_AUTHORS_NOTE_DEPTH = 1;
export const MIN_AUTHORS_NOTE_DEPTH = 1;
export const MAX_AUTHORS_NOTE_DEPTH = 10;

export function normalizeAuthorsNote(note: string): string | null {
  return note.trim().length === 0 ? null : note;
}

/** The note text and how many story parts from the end it lands before. */
export interface AuthorsNotePlacement {
  text: string;
  depth: number;
}

/** Depth is an integer from `MIN_AUTHORS_NOTE_DEPTH` to
 *  `MAX_AUTHORS_NOTE_DEPTH`. */
export function isValidAuthorsNoteDepth(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_AUTHORS_NOTE_DEPTH
    && value <= MAX_AUTHORS_NOTE_DEPTH;
}

/** Hold a depth inside its domain while the writer steps it in the editor. */
export function clampAuthorsNoteDepth(depth: number): number {
  return Math.min(MAX_AUTHORS_NOTE_DEPTH, Math.max(MIN_AUTHORS_NOTE_DEPTH, depth));
}

/** An absent stored depth means today's fixed placement. */
export function resolveAuthorsNoteDepth(stored: number | undefined): number {
  return stored ?? DEFAULT_AUTHORS_NOTE_DEPTH;
}

/** Store the depth only when it differs from the default placement — the same
 *  rule an empty `authorsNote` follows: a value that means nothing is absent. */
export function normalizeAuthorsNoteDepth(depth: number): number | null {
  return depth === DEFAULT_AUTHORS_NOTE_DEPTH ? null : depth;
}

/** The depth a manifest or a payload carries: absent when there is no note to
 *  place, and absent at the default, which absence already means. Every wire
 *  boundary uses this, so a depth that arrives explicit and default from
 *  another writer canonicalizes here instead of riding along forever. */
export function storedAuthorsNoteDepth(
  note: string | undefined,
  depth: number | undefined
): number | undefined {
  // A note that is only whitespace is no note: the prompt builder already
  // drops it, so a depth kept beside it would place prose the writer never
  // sees a note for. Another writer's manifest can hold exactly that.
  if (note === undefined || normalizeAuthorsNote(note) === null) return undefined;
  if (depth === undefined) return undefined;
  return normalizeAuthorsNoteDepth(depth) ?? undefined;
}

/** Choose the longest useful warning that fits the panel status cell. */
export function authorsNoteWarning(
  note: string,
  maxWidth = Number.POSITIVE_INFINITY
): string | null {
  const tokens = estimateTokens(note);
  if (tokens <= AUTHORS_NOTE_WARN_TOKENS) return null;
  const candidates = [
    `· ${tokens.toLocaleString("en-US")} tokens — a long note crowds the prose it steers`,
    `· ${tokens.toLocaleString("en-US")} tokens — long notes crowd the prose`,
    `· ${tokens.toLocaleString("en-US")} tokens`
  ];
  return candidates.find((candidate) => [...candidate].length <= maxWidth)
    ?? candidates.at(-1)!;
}
