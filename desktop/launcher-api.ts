import type { ProfileLauncherApi } from "../host/launcher-profile.js";
import type {
  StoryExportApi
} from "../host/launcher-export.js";
import type {
  StoryImportApi
} from "../host/launcher-import.js";
import type { WorkerHost } from "../host/worker-host.js";
import type {
  WorkerInput,
  WorkerMethod,
  WorkerOutput
} from "../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { normalizeMarkdownDefaultTitle } from "../shared/import-markdown-wire.js";

/** The small Host surface needed by graphical launcher operations. */
export type DesktopLauncherApi = StoryImportApi
  & StoryExportApi
  & ProfileLauncherApi;

/**
 * Adapt one Host transport for launcher helpers without creating a StoryApi.
 *
 * StoryApi belongs in each Renderer. This adapter only exposes the raw worker
 * calls that import, export, and profile transfer need in Main.
 */
export function launcherApiFromHost(host: WorkerHost): DesktopLauncherApi {
  const call = <M extends WorkerMethod>(
    method: M,
    input: WorkerInput<M>,
    expectedAggregateVersion?: StoryAggregateVersion
  ): Promise<WorkerOutput<M>> => host.transport.call(
    method,
    input,
    expectedAggregateVersion === undefined ? {} : { expectedAggregateVersion }
  );

  return {
    listStories: async () => await call("listStories", {}),
    exportMarkdown: async (id) => await call("exportMarkdown", { id }),
    loadStory: async (id) => await call("loadStory", { id }),
    importSillyTavern: async (jsonl) => await call(
      "importSillyTavern",
      { jsonl },
      { kind: "absent" }
    ),
    importMarkdown: async (markdown, defaultTitle) => await call(
      "importMarkdown",
      {
        markdown,
        ...(defaultTitle === undefined
          ? {}
          : { defaultTitle: normalizeMarkdownDefaultTitle(defaultTitle) })
      },
      { kind: "absent" }
    ),
    importNovelAI: async (storyContainerJson) => await call(
      "importNovelAI",
      { storyContainerJson },
      { kind: "absent" }
    ),
    importScenario: async (jsonText) => await call(
      "importScenario",
      { jsonText },
      { kind: "absent" }
    ),
    getSettings: async () => await call("getSettings", {}),
    saveSettings: async (command) => await call("saveSettings", { command })
  };
}
