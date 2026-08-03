import type { StoryPayload } from "../../shared/types.js";

/** The story-payload mutation primitive `createApi` owns. */
export type MutateStoryPayload = (
  storyId: string,
  method: string,
  path: string,
  body?: unknown
) => Promise<StoryPayload>;

/** The story's own document fields: the ones a writer sets on one story and
 *  that come back as a whole payload. They live together so the next such
 *  field has a home that is not the API surface itself. */
export function storyFieldApi(mutate: MutateStoryPayload): {
  renameStory: (id: string, title: string) => Promise<StoryPayload>;
  setAuthorsNote: (storyId: string, note: string, depth?: number) => Promise<StoryPayload>;
  setAuthorBrief: (storyId: string, brief: string) => Promise<StoryPayload>;
  setFactsBudget: (storyId: string, budgetTokens: number | null) => Promise<StoryPayload>;
} {
  return {
    renameStory: (id, title) => mutate(id, "PATCH", `/api/stories/${id}`, { title }),
    setAuthorsNote: (storyId, note, depth) => mutate(
      storyId,
      "PUT",
      `/api/stories/${storyId}/authors-note`,
      { note, ...(depth === undefined ? {} : { depth }) }
    ),
    setAuthorBrief: (storyId, brief) => mutate(
      storyId,
      "PUT",
      `/api/stories/${storyId}/author-brief`,
      { brief }
    ),
    // null clears the story's Facts budget.
    setFactsBudget: (storyId, budgetTokens) => mutate(
      storyId,
      "PUT",
      `/api/stories/${storyId}/facts-budget`,
      { budgetTokens }
    )
  };
}
