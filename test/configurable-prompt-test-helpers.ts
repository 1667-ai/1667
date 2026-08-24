import { DEFAULT_WRITING_PROMPT_SETTINGS } from "../shared/settings-v5-writing.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import { LEGACY_PROMPT_CACHE_CONTEXT } from "../server/provider-cache-policy.js";
import type { SettingsStore } from "../server/settings.js";

export const CUSTOM_CONTINUE_DIRECTION = "Keep walking west.";
export const OPERATION_GUIDANCE = "Prefer short verbs.";
export const OVERSIZE_GUIDANCE = "Keep the diction tight. ".repeat(400);

export function stopAfterFirstDelta(controller: AbortController): {
  onDelta: (text: string) => void;
  text: () => string;
} {
  let text = "";
  let stopped = false;
  return {
    onDelta: (delta: string) => {
      text += delta;
      if (!stopped) {
        stopped = true;
        controller.abort();
      }
    },
    text: () => text
  };
}

export function dryRunSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  };
}

export function stubSettingsStore(
  settings: GenerationSettings,
  writing = DEFAULT_WRITING_PROMPT_SETTINGS
): SettingsStore {
  return {
    load: async () => settings,
    loadGeneration: async () => ({
      settings,
      promptCache: LEGACY_PROMPT_CACHE_CONTEXT,
      imageInputCapability: null,
      writing
    })
  } as unknown as SettingsStore;
}

export function emptyStory(): Story {
  return {
    id: "story",
    title: "Story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

export function rewriteStory(): Story {
  return {
    id: "story",
    title: "Story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [{
      id: "root",
      parentId: null,
      instruction: "Begin",
      text: "Root prose continues onward.",
      model: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      activeChildId: null
    }],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}
