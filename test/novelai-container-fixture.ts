export interface NovelAiContextFixture {
  readonly memory?: unknown;
  readonly authorsNote?: unknown;
}

export function novelAiLorebook(entryCount = 1): Record<string, unknown> {
  return {
    lorebookVersion: 6,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      id: `entry-${index}`,
      displayName: `Lore ${index + 1}`,
      text: `Lorebook fact ${index + 1}.`,
      enabled: true,
      forceActivation: index % 2 === 0,
      keys: index % 2 === 0 ? [] : [`key-${index + 1}`]
    }))
  };
}

export function novelAiStoryContainer(options: {
  readonly title?: string;
  readonly prose?: readonly string[];
  readonly context?: NovelAiContextFixture;
  readonly lorebook?: unknown;
} = {}): string {
  const content: Record<string, unknown> = {
    story: {
      fragments: (options.prose ?? ["Story prose."]).map((data) => ({ data: `${data}\n` }))
    }
  };
  const context = novelAiContext(options.context);
  if (context !== undefined) content.context = context;
  if (options.lorebook !== undefined) content.lorebook = options.lorebook;
  return JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: options.title ?? "NovelAI Container" },
    content
  });
}

export function novelAiScenario(options: {
  readonly version?: number;
  readonly title?: string;
  readonly prompt?: unknown;
  readonly context?: NovelAiContextFixture;
  readonly lorebook?: unknown;
} = {}): string {
  const value: Record<string, unknown> = {
    scenarioVersion: options.version ?? 3,
    title: options.title ?? "NovelAI Scenario",
    prompt: options.prompt ?? "Scenario prose."
  };
  const context = novelAiContext(options.context);
  if (context !== undefined) value.context = context;
  if (options.lorebook !== undefined) value.lorebook = options.lorebook;
  return JSON.stringify(value);
}

function novelAiContext(
  context: NovelAiContextFixture | undefined
): unknown[] | undefined {
  if (context === undefined) return undefined;
  const values: unknown[] = [];
  if (context.memory !== undefined) values[0] = { text: context.memory };
  if (context.authorsNote !== undefined) values[1] = { text: context.authorsNote };
  return values;
}
