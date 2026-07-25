import { MAX_IMPORT_BYTES, MAX_JSON_BODY_BYTES } from "../shared/types.js";
import {
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
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
  if (method === "importSillyTavern") {
    if (typeof input.jsonl === "string" && new TextEncoder().encode(input.jsonl).byteLength > MAX_IMPORT_BYTES) {
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
    case "createStory": return { title: input.title };
    case "renameStory": return { title: input.title };
    case "acknowledgeUnknownOutcomes":
      return { originalProviderMutationId: input.originalProviderMutationId };
    case "createChapterBreak": return { parentPartId: input.parentPartId, title: input.title };
    case "renameChapterBreak": return { title: input.title };
    case "removeChapterBreak": {
      if (protocolVersion === PREDECESSOR_WORKER_PROTOCOL_VERSION) {
        if (input.removedFingerprint !== undefined) throw mixedRemovalSchema();
        return input.removed;
      }
      if (protocolVersion === WORKER_PROTOCOL_VERSION) {
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
      return undefined;
  }
}

function mixedRemovalSchema(): ServiceError {
  return new ServiceError(
    400,
    "Chapter removal request mixes incompatible protocol schemas"
  );
}
