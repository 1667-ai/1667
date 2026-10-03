import type { StoryApi } from "../../../client/api.js";
import { type StoryChapter } from "../../../shared/manuscript-model.js";
import { manuscriptModelOf } from "../story/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";

/** The open story and the connection, or `null`. */
export interface OpenStory {
  readonly storyId: string;
  readonly payload: StoryPayload;
  readonly api: StoryApi;
}

export function openStory(state: AppState): OpenStory | null {
  if (state.route.kind !== "story" || state.story.kind !== "loaded") return null;
  if (state.story.payload.id !== state.route.id || state.connection.kind !== "connected") return null;
  return { storyId: state.route.id, payload: state.story.payload, api: state.connection.api };
}

/** The stored title of the chapter a break opens (`null` break id: chapter
 * one). `null` when the break is gone. */
export function storedChapterTitle(payload: StoryPayload, breakId: string | null): string | null {
  if (breakId === null) return payload.firstChapterTitle ?? "";
  return payload.chapterBreaks.find((candidate) => candidate.id === breakId)?.title ?? null;
}

/** The chapter a break closes, with its summary (if any). */
export function chapterClosedBy(payload: StoryPayload, breakId: string): StoryChapter | null {
  return manuscriptModelOf(payload).chapters.find((chapter) => chapter.closedBy?.id === breakId) ?? null;
}
