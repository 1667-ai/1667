import {
  MAX_IMPORT_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_STORED_TITLE_CHARS
} from "../shared/types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import {
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  isCurrentWorkerInputProtocolVersion,
  messageByteLength,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";
import { requireRecord } from "./validation.js";

/** Apply the same byte ceilings as the equivalent HTTP body, excluding route fields. */
export function validateWorkerRequestSize(
  method: WorkerMethod,
  value: unknown,
  protocolVersion?: number
): void {
  const input = requireRecord(value, `${method} input`);
  if (method === "importLorebook") {
    // The only import whose body is bytes rather than text.
    const bytes = input.archiveBytes;
    const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : 0;
    if (byteLength > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    return;
  }
  if (method === "importSillyTavern" || method === "importMarkdown" || method === "importNovelAI" || method === "importScenario") {
    const text = method === "importSillyTavern"
      ? input.jsonl
      : method === "importMarkdown"
        ? input.markdown
        : method === "importNovelAI"
          ? input.storyContainerJson
          : input.jsonText;
    if (method === "importMarkdown" && typeof text === "string" && hasUnpairedSurrogate(text)) {
      throw new ServiceError(400, "Markdown contains invalid Unicode");
    }
    if (typeof text === "string" && Buffer.byteLength(text) > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    if (
      method === "importMarkdown"
      && typeof input.defaultTitle === "string"
      && hasUnpairedSurrogate(input.defaultTitle)
    ) {
      throw new ServiceError(400, "Markdown default title contains invalid Unicode");
    }
    if (
      method === "importMarkdown"
      && typeof input.defaultTitle === "string"
      && unicodeScalarLength(input.defaultTitle, MAX_STORED_TITLE_CHARS) > MAX_STORED_TITLE_CHARS
    ) {
      throw new ServiceError(413, "Request body too large");
    }
    return;
  }

  const body = logicalRequestBody(method, input, protocolVersion);
  if (body === undefined) return;
  const size = messageByteLength(body);
  if (size === null) throw new ServiceError(400, "Worker request body must be serializable");
  if (size > MAX_JSON_BODY_BYTES) throw new ServiceError(413, "Request body too large");
}

function logicalRequestBody(
  method: WorkerMethod,
  input: Record<string, unknown>,
  protocolVersion?: number
): unknown {
  switch (method) {
    // The query is the writer's own prose and travels in the body, so it takes
    // the same ceiling the HTTP route applies to it.
    case "searchStories":
      return {
        query: input.query,
        scope: input.scope,
        storyId: input.storyId,
        caseSensitive: input.caseSensitive
      };
    case "createStory": return { title: input.title };
    case "renameStory": return { title: input.title };
    case "setAuthorsNote": return { note: input.note, depth: input.depth };
    case "setAuthorBrief": return { brief: input.brief };
    case "setFactsBudget": return { budgetTokens: input.budgetTokens };
    case "setPhraseBias": return { phraseBias: input.phraseBias };
    case "setBannedStrings": return { bannedStrings: input.bannedStrings };
    case "acknowledgeUnknownOutcomes":
      return { originalProviderMutationId: input.originalProviderMutationId };
    case "createChapterBreak": return { parentPartId: input.parentPartId, title: input.title };
    case "renameChapterBreak": return { title: input.title };
    case "removeChapterBreak": {
      if (protocolVersion === PREDECESSOR_WORKER_PROTOCOL_VERSION) {
        if (input.removedFingerprint !== undefined) throw mixedRemovalSchema();
        return input.removed;
      }
      if (isCurrentWorkerInputProtocolVersion(protocolVersion)) {
        if (input.removed !== undefined) throw mixedRemovalSchema();
        return { removedFingerprint: input.removedFingerprint };
      }
      if (input.removed !== undefined && input.removedFingerprint !== undefined) {
        throw mixedRemovalSchema();
      }
      return typeof input.removedFingerprint === "string"
        ? { removedFingerprint: input.removedFingerprint }
        : input.removed;
    }
    case "restoreChapterBreak": return input.removed;
    case "switchLine": {
      const options = input.options;
      return options === undefined || options === null || typeof options !== "object" || Array.isArray(options)
        ? { nodeId: input.nodeId }
        : { nodeId: input.nodeId, ...options };
    }
    case "createNode":
    case "editNode":
    case "pruneUnusedTakes":
    case "takeFromCut":
    case "createFact":
    case "patchFact":
    case "reorderFact":
    case "rewriteNode":
    case "createSummaryTake":
      return input.body;
    case "deleteNode": return { expectedSubtreeCount: input.expectedSubtreeCount };
    case "putBookmark": return { name: input.name, label: input.label };
    case "saveSettings":
    case "discardPendingSettings":
      return input.command;
    case "checkModelServer":
    case "probeContextWindow":
    case "discoverModels":
      return input.settings;
    // Bounded upstream by MAX_COUNTED_PROMPT_CHARS (400,000 characters), well
    // under this ceiling in every realistic script, so no bespoke limit here.
    case "countPromptTokens":
      return input.messages;
    case "continueStory": {
      const target = input.target;
      return target === null || typeof target !== "object" || Array.isArray(target)
        ? undefined
        : { instruction: input.instruction, genId: input.genId, ...target };
    }
    case "listStories":
    case "listStoriesPage":
    case "loadStory":
    case "getUnknownOutcomeStatus":
    case "previewChapterBreakRemoval":
    case "autonameStory":
    case "deleteStory":
    case "exportMarkdown":
    case "deleteBookmark":
    case "deleteFact":
    case "summarizeChapter":
    case "getSettings":
    case "importSillyTavern":
    case "importMarkdown":
    case "importNovelAI":
    case "importScenario":
    case "importLorebook":
      return undefined;

  }
}

function mixedRemovalSchema(): ServiceError {
  return new ServiceError(
    400,
    "Chapter removal request mixes incompatible protocol schemas"
  );
}
