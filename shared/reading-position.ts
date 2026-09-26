import { rowIndexForNode, lastPartRowIndex, type ManuscriptModel } from "./manuscript-model.js";
import { STARTER_OPENING_STORY_ID } from "./starter-vault.js";
import type { StoryPayload } from "./types.js";

/**
 * Pure reading-position model shared by the TUI (`tui/src/reading-position.ts`,
 * a thin wrapper that adds the streamed `StoryViewModel`) and the web
 * manuscript view (`web/src/story/state.ts`), which calls this directly over
 * `shared/manuscript-model.ts`'s stream-free model. Story id → last focused
 * part id. Local changing store, not settings.
 */
export type ReadingPositions = Readonly<Record<string, string>>;

export const MAX_READING_POSITIONS = 256;

export function normalizeReadingPositions(value: unknown): ReadingPositions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const next: Record<string, string> = {};
  for (const [storyId, partId] of Object.entries(value)) {
    if (typeof storyId !== "string" || storyId.length === 0) continue;
    if (typeof partId !== "string" || partId.length === 0) continue;
    next[storyId] = partId;
  }
  return capReadingPositions(next);
}

/** Apply dirty sets/deletes onto a disk snapshot, keeping dirty keys under the cap. */
export function mergeReadingPositionDirty(
  disk: ReadingPositions,
  dirtyEntries: ReadonlyMap<string, string | null>
): ReadingPositions {
  const next: Record<string, string> = { ...disk };
  const keep = new Set<string>();
  for (const [storyId, partId] of dirtyEntries) {
    if (partId === null) {
      delete next[storyId];
      keep.delete(storyId);
      continue;
    }
    next[storyId] = partId;
    keep.add(storyId);
  }
  return capReadingPositions(next, keep);
}

export function readingPartIdFor(
  positions: ReadingPositions,
  storyId: string
): string | null {
  return positions[storyId] ?? null;
}

/** Resolve where a story should open, over an already-built manuscript model.
 * A stored part wins when it still has a row. Otherwise: the tour begins at
 * its first part; every other story opens at the end of its line (writer
 * default). */
export function openingFocusIndexOverManuscript(
  model: Pick<ManuscriptModel, "rows">,
  payload: StoryPayload,
  readingPartId: string | null | undefined
): number {
  if (payload.path.length === 0) return 0;
  if (readingPartId !== null && readingPartId !== undefined && readingPartId.length > 0) {
    const index = rowIndexForNode(model, readingPartId);
    if (index >= 0) return index;
  }
  if (payload.id === STARTER_OPENING_STORY_ID) return firstPartRowIndex(model);
  return lastPartRowIndex(model);
}

/** Resolve a storeable part id for the focused row. Chapter dividers map to
 * the first part of the chapter they open; stream virtual rows return null. */
export function persistablePartIdOverManuscript(
  model: Pick<ManuscriptModel, "rows">,
  focusIndex: number,
  payload: StoryPayload
): string | null {
  const row = model.rows[focusIndex];
  if (row === undefined) return null;
  if (row.kind === "part") {
    return payloadHasPart(payload, row.id) ? row.id : null;
  }
  if (row.kind === "chapter-divider") {
    const first = row.openingChapter.parts[0];
    return first !== undefined && payloadHasPart(payload, first.id) ? first.id : null;
  }
  if (row.kind === "chapter-summary") {
    // Summary rows sit after the chapter's prose; remember the last part.
    const last = row.chapter.parts.at(-1);
    return last !== undefined && payloadHasPart(payload, last.id) ? last.id : null;
  }
  return null;
}

/** Pure: set the focused part for a story. No-op when focus is not storeable. */
export function putReadingPositionOverManuscript(
  positions: ReadingPositions,
  storyId: string,
  model: Pick<ManuscriptModel, "rows">,
  focusIndex: number,
  payload: StoryPayload
): ReadingPositions {
  const partId = persistablePartIdOverManuscript(model, focusIndex, payload);
  if (partId === null) return positions;
  if (positions[storyId] === partId) return positions;
  return capReadingPositions({ ...positions, [storyId]: partId }, new Set([storyId]));
}

export function forgetReadingPosition(
  positions: ReadingPositions,
  storyId: string
): ReadingPositions {
  if (positions[storyId] === undefined) return positions;
  const next = { ...positions };
  delete next[storyId];
  return next;
}

function payloadHasPart(payload: StoryPayload, partId: string): boolean {
  return payload.path.some(({ id }) => id === partId)
    || payload.nodes.some(({ id }) => id === partId);
}

function firstPartRowIndex(model: Pick<ManuscriptModel, "rows">): number {
  for (let index = 0; index < model.rows.length; index += 1) {
    if (model.rows[index]?.kind === "part") return index;
  }
  return 0;
}

/** Cap the map. Prefer retaining `keep` keys; otherwise drop insertion-oldest. */
export function capReadingPositions(
  positions: Record<string, string>,
  keep: ReadonlySet<string> = new Set()
): ReadingPositions {
  const entries = Object.entries(positions);
  if (entries.length <= MAX_READING_POSITIONS) return positions;
  const kept = new Map(entries);
  for (const key of [...kept.keys()]) {
    if (kept.size <= MAX_READING_POSITIONS) break;
    if (keep.has(key)) continue;
    kept.delete(key);
  }
  // If still over (every key is protected), drop unprotected-none by force from front.
  for (const key of [...kept.keys()]) {
    if (kept.size <= MAX_READING_POSITIONS) break;
    if (keep.has(key) && kept.size <= keep.size) continue;
    if (!keep.has(key)) kept.delete(key);
  }
  while (kept.size > MAX_READING_POSITIONS) {
    const first = kept.keys().next().value;
    if (first === undefined) break;
    kept.delete(first);
  }
  return Object.fromEntries(kept);
}
