/** Bound shared with the machine-wide `writing.defaultAuthorBrief` scalar
 * (`server/settings-v2-scalars.ts` re-exports this exact constant as
 * `MAX_SETTINGS_AUTHOR_BRIEF_SCALARS`), so one value governs both. */
export const MAX_AUTHOR_BRIEF_CHARS = 65_536;

export function normalizeAuthorBrief(brief: string): string | null {
  return brief.trim().length === 0 ? null : brief;
}

/** The single lookup-order helper for the per-story Author Brief: a set story
 * brief overrides the machine-wide default; an absent or blank one falls back
 * to it. Shared by the server and the TUI request projection so the request
 * viewer can never drift from the request the server actually sends. */
export function resolveAuthorBrief(
  storyBrief: string | undefined | null,
  defaultBrief: string
): string {
  const normalized = storyBrief === undefined || storyBrief === null
    ? null
    : normalizeAuthorBrief(storyBrief);
  return normalized ?? defaultBrief;
}
