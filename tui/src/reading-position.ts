import { STARTER_OPENING_STORY_ID } from "../../shared/starter-vault.js";
import type { StoryPayload } from "../../shared/types.js";
import {
  createStoryViewModel,
  lastPartRowIndex,
  rowIndexForNode,
  rowPart,
  type StoryViewModel
} from "./model.js";
import type { StreamView } from "./state.js";

/** Bounded map of story id → last focused part id. Local UI state only: not
 * manuscript content, not synced across machines. See issue #38. */
export type ReadingPositions = Readonly<Record<string, string>>;

/** Minimal config shape so this module does not import `config.ts` (cycle). */
export interface ReadingPositionCarrier {
  readingPositions: ReadingPositions;
}

const MAX_READING_POSITIONS = 256;

export function normalizeReadingPositions(value: unknown): ReadingPositions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const next: Record<string, string> = {};
  for (const [storyId, partId] of Object.entries(value)) {
    if (typeof storyId !== "string" || storyId.length === 0) continue;
    if (typeof partId !== "string" || partId.length === 0) continue;
    next[storyId] = partId;
    if (Object.keys(next).length >= MAX_READING_POSITIONS) break;
  }
  return next;
}

/** Resolve where a story should open. A stored part wins when it still has a
 * row. Otherwise: the tour begins at its first part; every other story opens
 * at the end of its line (writer default). */
export function openingFocusIndex(
  payload: StoryPayload,
  readingPartId: string | null | undefined
): number {
  const view = createStoryViewModel(payload);
  if (payload.path.length === 0) return 0;
  if (readingPartId !== null && readingPartId !== undefined && readingPartId.length > 0) {
    const index = rowIndexForNode(view, readingPartId);
    if (index >= 0) return index;
  }
  if (payload.id === STARTER_OPENING_STORY_ID) return firstPartRowIndex(view);
  return lastPartRowIndex(view);
}

export function readingPartIdFor(
  config: ReadingPositionCarrier,
  storyId: string
): string | null {
  return config.readingPositions?.[storyId] ?? null;
}

/** Remember the focused part for this story. Pure: caller persists config. */
export function rememberReadingPosition<T extends ReadingPositionCarrier>(
  config: T,
  storyId: string,
  view: StoryViewModel,
  focusIndex: number
): T {
  const part = rowPart(view, focusIndex);
  if (part === null) return config;
  const previous = config.readingPositions?.[storyId];
  if (previous === part.id) return config;
  const readingPositions = trimReadingPositions({
    ...(config.readingPositions ?? {}),
    [storyId]: part.id
  }, storyId);
  return { ...config, readingPositions };
}

/** Drop a story's position when the story is deleted. Pure: caller persists. */
export function forgetReadingPosition<T extends ReadingPositionCarrier>(
  config: T,
  storyId: string
): T {
  if (config.readingPositions?.[storyId] === undefined) return config;
  const readingPositions = { ...(config.readingPositions ?? {}) };
  delete readingPositions[storyId];
  return { ...config, readingPositions };
}

/** Apply open focus from the carrier's map (or tour / leaf defaults). */
export function applyOpeningFocus(
  payload: StoryPayload,
  config: ReadingPositionCarrier
): number {
  return openingFocusIndex(payload, readingPartIdFor(config, payload.id));
}

/** After NAV focus moves onto a part, update the carrier map if it changed. */
export function withRememberedFocus<T extends ReadingPositionCarrier>(
  config: T,
  payload: StoryPayload,
  focusIndex: number,
  stream: StreamView | null = null
): T {
  const view = createStoryViewModel(payload, stream);
  return rememberReadingPosition(config, payload.id, view, focusIndex);
}

function firstPartRowIndex(view: StoryViewModel): number {
  for (let index = 0; index < view.rows.length; index += 1) {
    if (view.rows[index]?.kind === "part") return index;
  }
  return 0;
}

/** Keep the just-written entry and drop oldest map keys when over the cap. */
function trimReadingPositions(
  positions: Record<string, string>,
  keepStoryId: string
): ReadingPositions {
  const kept = new Map(Object.entries(positions));
  if (kept.size <= MAX_READING_POSITIONS) return positions;
  // String-key insertion order: drop from the front; never drop the update.
  for (const key of [...kept.keys()]) {
    if (kept.size <= MAX_READING_POSITIONS) break;
    if (key === keepStoryId) continue;
    kept.delete(key);
  }
  return Object.fromEntries(kept);
}
