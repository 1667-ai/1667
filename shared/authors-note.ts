import { estimateTokens } from "./tokens.js";

export const MAX_AUTHORS_NOTE_CHARS = 4_000;
export const AUTHORS_NOTE_WARN_TOKENS = 300;

export function normalizeAuthorsNote(note: string): string | null {
  return note.trim().length === 0 ? null : note;
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
