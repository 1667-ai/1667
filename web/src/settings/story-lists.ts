/** Text the writer changed in the story lists of the settings page ("This
 * story") and has not saved. It lives in the store, keyed by story, so leaving
 * the page or switching the view keeps it, and the unsaved-work guard sees it. */
export type StoryListField = "phrase-bias" | "banned-strings";
export type StoryListDrafts = Readonly<Record<string, Readonly<Partial<Record<StoryListField, string>>>>>;

export const STORY_LIST_LABELS: Record<StoryListField, string> = {
  "phrase-bias": "Phrase bias",
  "banned-strings": "Banned strings"
};

export function withStoryListDraft(
  drafts: StoryListDrafts,
  storyId: string,
  field: StoryListField,
  text: string | null
): StoryListDrafts {
  const mine = { ...drafts[storyId] };
  if (text === null) delete mine[field];
  else mine[field] = text;
  const next = { ...drafts };
  if (Object.keys(mine).length === 0) delete next[storyId];
  else next[storyId] = mine;
  return next;
}
