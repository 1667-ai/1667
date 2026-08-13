/** Small, sanitized shapes copied from real NovelAI v0/v1 scenarios and
 * v1/v3/v4 Lorebooks in the local compatibility corpus. The fixtures keep
 * only fields that the importer reads and one representative native field
 * from each observed format. */

export type LegacyNovelAiLorebookVersion = 1 | 3 | 4;

export function legacyNovelAiLorebook(
  version: LegacyNovelAiLorebookVersion
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    text: "A legacy entry keeps its core prose.",
    contextConfig: {
      prefix: "[ ",
      suffix: "]\n",
      tokenBudget: 2048,
      reservedTokens: 0,
      budgetPriority: 400,
      trimDirection: "trimBottom",
      insertionType: "newline",
      insertionPosition: -1
    },
    displayName: "Legacy Entry",
    keys: ["legacy"],
    searchRange: 1000,
    enabled: true,
    forceActivation: false
  };

  if (version >= 3) entry.category = "category-legacy";

  return {
    lorebookVersion: version,
    entries: [entry],
    ...(version >= 3
      ? {
        settings: { orderByKeyLocations: false },
        categories: [{ name: "Legacy", id: "category-legacy", enabled: true }]
      }
      : {})
  };
}

export function legacyNovelAiScenario(
  version: 0 | 1
): Record<string, unknown> {
  return {
    scenarioVersion: version,
    title: `Legacy Scenario v${version}`,
    prompt: "Opening prompt.\n\nContinuation prompt.",
    context: [
      { text: "Persistent legacy memory." },
      { text: "Legacy author's note." }
    ],
    // Both real v0 and v1 scenarios in the corpus embed Lorebook v1.
    lorebook: legacyNovelAiLorebook(1),
    ...(version === 1
      ? {
        contextDefaults: { loreDefaults: [] },
        ephemeralContext: [],
        storyContextConfig: { insertionPosition: -1 }
      }
      : {})
  };
}
