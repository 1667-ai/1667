import { encodeMarkdownHttpBody } from "../../shared/import-markdown-wire.js";
import type { LorebookImport } from "../../shared/novelai-lorebook.js";
import type { StoryPayload } from "../../shared/types.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import { decodeStoryResponse } from "./api-response-decoders.js";
import type { HttpAbsentMutation } from "./http-mutation-intents.js";
import type { HttpStoryVersions } from "./http-story-versions.js";
import type { NovelAiStoryImportResult, StoryApi } from "./api.js";

/** Every import format is one new story, or one archive read into a story that
 * already exists. Keeping them together means the next format has one home. */
export type ImportMethods = Pick<
  StoryApi,
  | "importSillyTavern"
  | "importMarkdown"
  | "importNovelAI"
  | "importScenario"
  | "importLorebook"
>;

/** What the import methods borrow from the API they belong to. */
export interface ImportMethodCore {
  runAbsentImportMutation<T>(
    workerMethod: HttpAbsentMutation,
    intentKey: string,
    path: string,
    contentType: string,
    body: string,
    decode: (value: unknown) => T
  ): Promise<T>;
  request<T>(
    method: string,
    path: string,
    decode: (payload: unknown) => T,
    body?: unknown,
    timeoutMs?: number,
    expectedAggregateVersion?: StoryAggregateVersion
  ): Promise<T>;
  versions: HttpStoryVersions;
  expectedVersion(storyId: string): Promise<StoryAggregateVersion | undefined>;
}

const HTTP_REQUEST_TIMEOUT_MS = 15_000;

export function importMethods(core: ImportMethodCore): ImportMethods {
  const storyFrom = (value: unknown): StoryPayload =>
    core.versions.rememberPayload(decodeStoryResponse(value));
  const novelAiFrom = (value: unknown): NovelAiStoryImportResult => {
    const result = decodeNovelAiStoryImportResult(value);
    core.versions.rememberPayload(result.payload);
    return result;
  };

  return {
    importSillyTavern: async (jsonl) =>
      await core.runAbsentImportMutation(
        "importSillyTavern",
        jsonl,
        "/api/import/sillytavern",
        "text/plain; charset=utf-8",
        jsonl,
        storyFrom
      ),
    importMarkdown: async (markdown, defaultTitle) => {
      const body = encodeMarkdownHttpBody(markdown, defaultTitle);
      return await core.runAbsentImportMutation(
        "importMarkdown",
        body,
        "/api/import/markdown",
        "application/vnd.1667.markdown; charset=utf-8",
        body,
        storyFrom
      );
    },
    importNovelAI: async (storyContainerJson) =>
      await core.runAbsentImportMutation(
        "importNovelAI",
        storyContainerJson,
        "/api/import/novelai",
        "application/json; charset=utf-8",
        storyContainerJson,
        novelAiFrom
      ),
    importScenario: async (jsonText) =>
      await core.runAbsentImportMutation(
        "importScenario",
        jsonText,
        "/api/import/scenario",
        "application/json; charset=utf-8",
        jsonText,
        novelAiFrom
      ),
    importLorebook: async (storyId, archiveBytes) => {
      const response = await core.request(
        "POST",
        `/api/stories/${storyId}/import-lorebook`,
        decodeLorebookImportResult,
        archiveBytes,
        HTTP_REQUEST_TIMEOUT_MS,
        await core.expectedVersion(storyId)
      );
      core.versions.rememberPayload(response.payload);
      return response;
    }
  };
}

function decodeNovelAiStoryImportResult(value: unknown): NovelAiStoryImportResult {
  const record = importRecord(value, "NovelAI import result");
  if (!Array.isArray(record.fidelity)
    || !record.fidelity.every((item) => typeof item === "string")) {
    throw new Error("The server returned an invalid NovelAI import fidelity report.");
  }
  return {
    payload: decodeStoryResponse(record.payload),
    fidelity: record.fidelity
  };
}

/** The callers read `.facts` straight off this, so a wrong shape fails here at
 * the boundary rather than at a `.filter` deep inside a panel. */
function decodeLorebookImportResult(
  value: unknown
): { payload: StoryPayload; importResult: LorebookImport } {
  const record = importRecord(value, "lorebook import result");
  const importResult = importRecord(record.importResult, "lorebook import result");
  if (!Array.isArray(importResult.facts)) {
    throw new Error("The server returned an invalid lorebook import fact list.");
  }
  if (!Array.isArray(importResult.fidelity)
    || !importResult.fidelity.every((item) => typeof item === "string")) {
    throw new Error("The server returned an invalid lorebook import fidelity report.");
  }
  return {
    payload: decodeStoryResponse(record.payload),
    importResult: importResult as unknown as LorebookImport
  };
}

function importRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The server returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}
