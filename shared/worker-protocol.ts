import type {
  BookmarkLabel,
  ChapterBreak,
  CreateFactsRequest,
  CreateNodeRequest,
  EditNodeRequest,
  GenerationSettings,
  ModelServerCheckResult,
  PruneUnusedTakesRequest,
  RewriteRequest,
  StoryPayload,
  StoryNode,
  StorySummary,
  SwitchRequest,
  TakeFromCutRequest
} from "./types.js";
import type {
  DiscardPendingSettingsCommand,
  ModelDiscoveryResultV2,
  ProviderProbeTarget,
  SaveSettingsCommand,
  SettingsMutationResult,
  SettingsView
} from "./settings-v2-types.js";
import type {
  ListStoriesPageInput,
  StoryCatalogPage
} from "./story-catalog.js";
import type { StoryAggregateVersion } from "./story-aggregate-version.js";
import {
  AI_1667_BUILD_IDENTITY,
  type BuildIdentity
} from "./build-identity.js";
export const LEGACY_WORKER_PROTOCOL_VERSION = 3;
export const PRE_Q_WORKER_PROTOCOL_VERSION = 4;
export const PREDECESSOR_WORKER_PROTOCOL_VERSION = 5;
export const WORKER_PROTOCOL_VERSION = 6;
export const WORKER_BUILD_IDENTITY = AI_1667_BUILD_IDENTITY;
export const WORKER_UNARY_TIMEOUT_MS = 15_000;
export const WORKER_PROVIDER_CHECK_TIMEOUT_MS = 30_000;
export const WORKER_MUTATION_DEADLINE_MS = 5 * 60_000;
export const WORKER_STREAM_DEADLINE_MS = 30 * 60_000;
export const WORKER_STARTUP_HEARTBEAT_MS = 2_000;
export const WORKER_STARTUP_LIVENESS_TIMEOUT_MS = 10_000;
export const WORKER_STARTUP_TIMEOUT_MS = 60_000;
export const WORKER_TERMINATION_CONFIRM_MS = 2_000;
export const WORKER_SHUTDOWN_GRACE_MS = 5_000;
export const WORKER_CANCEL_GRACE_MS = 2_000;
export const WORKER_OPERATION_CAPACITY = 1_024;
export const WORKER_TERMINAL_RETENTION_MS = 5 * 60_000;
export const WORKER_MAX_OPERATION_SEQUENCE = (1n << 64n) - 1n;
export const MAX_DELTA_BATCH_BYTES = 32_768;
export const MAX_UNACKNOWLEDGED_DELTA_BATCHES = 8;
export const MAX_UNACKNOWLEDGED_DELTA_BYTES = MAX_DELTA_BATCH_BYTES * MAX_UNACKNOWLEDGED_DELTA_BATCHES;
export const DELTA_BATCH_WINDOW_MS = 16;
export const MUTATION_ID_RETRY_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
export const MUTATION_ID_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface WorkerMethodContract {
  listStories: { input: Record<string, never>; output: StorySummary[] };
  listStoriesPage: { input: ListStoriesPageInput; output: StoryCatalogPage };
  createStory: { input: { title?: string }; output: StoryPayload };
  loadStory: { input: { id: string }; output: StoryPayload };
  getUnknownOutcomeStatus: {
    input: { storyId: string; originalProviderMutationId: string };
    output:
      | {
          state: "pending";
          aggregateVersion: StoryAggregateVersion;
          deleted: boolean;
        }
      | { state: "resolved"; deleted: boolean };
  };
  previewChapterBreakRemoval: {
    input: { storyId: string; breakId: string };
    output: {
      removedFingerprint: string;
      aggregateVersion: StoryAggregateVersion;
    };
  };
  renameStory: { input: { id: string; title: string }; output: StoryPayload };
  autonameStory: { input: { id: string; expectedTitle: string }; output: StoryPayload };
  acknowledgeUnknownOutcomes: {
    input: { storyId: string; originalProviderMutationId: string };
    output: StoryPayload | null;
  };
  deleteStory: { input: { id: string }; output: { ok: true } };
  exportMarkdown: { input: { id: string }; output: string };
  switchLine: { input: { storyId: string; nodeId: string; options?: Omit<SwitchRequest, "nodeId"> }; output: StoryPayload };
  createNode: { input: { storyId: string; body: CreateNodeRequest }; output: StoryPayload };
  editNode: { input: { storyId: string; nodeId: string; body: EditNodeRequest }; output: StoryPayload };
  deleteNode: { input: { storyId: string; nodeId: string; expectedSubtreeCount: number }; output: StoryPayload };
  pruneUnusedTakes: { input: { storyId: string; body: PruneUnusedTakesRequest }; output: StoryPayload };
  takeFromCut: { input: { storyId: string; nodeId: string; body: TakeFromCutRequest }; output: StoryPayload };
  putBookmark: { input: { storyId: string; nodeId: string; name: string; label: BookmarkLabel }; output: StoryPayload };
  deleteBookmark: { input: { storyId: string; nodeId: string }; output: StoryPayload };
  createFact: { input: { storyId: string; body: CreateFactsRequest }; output: StoryPayload };
  patchFact: { input: { storyId: string; factId: string; body: { tag?: string | null; text?: string } }; output: StoryPayload };
  deleteFact: { input: { storyId: string; factId: string }; output: StoryPayload };
  createChapterBreak: {
    input: { storyId: string; parentPartId: string; title: string };
    output: { payload: StoryPayload; breakId: string };
  };
  renameChapterBreak: { input: { storyId: string; breakId: string; title: string }; output: StoryPayload };
  removeChapterBreak: {
    input: {
      storyId: string;
      breakId: string;
      removedFingerprint: string;
    };
    output: { payload: StoryPayload; removed: { break: ChapterBreak; summaries: StoryNode[] } };
  };
  restoreChapterBreak: {
    input: { storyId: string; breakId: string; removed: { break: ChapterBreak; summaries: StoryNode[] } };
    output: StoryPayload;
  };
  summarizeChapter: { input: { storyId: string; breakId: string }; output: StoryPayload };
  getSettings: { input: Record<string, never>; output: SettingsView };
  saveSettings: { input: { command: SaveSettingsCommand }; output: SettingsMutationResult };
  discardPendingSettings: {
    input: { command: DiscardPendingSettingsCommand };
    output: SettingsMutationResult;
  };
  checkModelServer: { input: { settings: ProviderProbeTarget }; output: ModelServerCheckResult };
  probeContextWindow: { input: { settings: ProviderProbeTarget }; output: { contextWindow: number | null } };
  discoverModels: { input: { settings: GenerationSettings }; output: ModelDiscoveryResultV2 };
  importSillyTavern: { input: { jsonl: string }; output: StoryPayload };
  continueStory: {
    input: { storyId: string; instruction: string; genId: string; target: { parentId?: string | null; appendTo?: string; expectedTextHash?: string } };
    output: StoryPayload | null;
  };
  rewriteNode: { input: { storyId: string; nodeId: string; body: RewriteRequest }; output: boolean };
  createSummaryTake: {
    input: { storyId: string; body: { nodeId: string; offset?: number; expected?: string } };
    output: string | null;
  };
}

export type WorkerMethod = keyof WorkerMethodContract;
export type WorkerInput<M extends WorkerMethod> = WorkerMethodContract[M]["input"];
export type WorkerOutput<M extends WorkerMethod> = WorkerMethodContract[M]["output"];

export type MutatingWorkerMethod =
  | "createStory" | "renameStory" | "autonameStory" | "acknowledgeUnknownOutcomes"
  | "deleteStory" | "switchLine"
  | "createNode" | "editNode" | "deleteNode" | "pruneUnusedTakes" | "takeFromCut"
  | "putBookmark" | "deleteBookmark" | "createFact" | "patchFact" | "deleteFact"
  | "createChapterBreak" | "renameChapterBreak" | "removeChapterBreak" | "restoreChapterBreak" | "summarizeChapter"
  | "importSillyTavern" | "continueStory" | "rewriteNode" | "createSummaryTake";

export const STREAM_METHODS: ReadonlySet<WorkerMethod> = new Set([
  "continueStory", "rewriteNode", "createSummaryTake"
]);

/** Provider-backed calls share the long generation deadline even when their
 * response is unary rather than delta-streamed. */
export const GENERATION_METHODS: ReadonlySet<WorkerMethod> = new Set([
  ...STREAM_METHODS,
  "summarizeChapter"
]);

export const PROVIDER_CHECK_METHODS: ReadonlySet<WorkerMethod> = new Set([
  "checkModelServer",
  "probeContextWindow",
  "discoverModels"
]);

export const MUTATING_METHODS: ReadonlySet<MutatingWorkerMethod> = new Set([
  "createStory", "renameStory", "autonameStory", "acknowledgeUnknownOutcomes",
  "deleteStory", "switchLine",
  "createNode", "editNode", "deleteNode", "pruneUnusedTakes", "takeFromCut",
  "putBookmark", "deleteBookmark", "createFact", "patchFact", "deleteFact",
  "createChapterBreak", "renameChapterBreak", "removeChapterBreak", "restoreChapterBreak", "summarizeChapter",
  "importSillyTavern", "continueStory", "rewriteNode", "createSummaryTake"
]);

export function isMutatingWorkerMethod(method: WorkerMethod): method is MutatingWorkerMethod {
  return MUTATING_METHODS.has(method as MutatingWorkerMethod);
}

export type ServiceOwnedSettingsMutationMethod = "saveSettings" | "discardPendingSettings";
const SERVICE_OWNED_SETTINGS_MUTATIONS: ReadonlySet<ServiceOwnedSettingsMutationMethod> = new Set([
  "saveSettings",
  "discardPendingSettings"
]);

/** These commands carry their own durable identity and must bypass the legacy
 * worker mutation receipt/outbox envelope. */
export function isServiceOwnedSettingsMutation(
  method: WorkerMethod
): method is ServiceOwnedSettingsMutationMethod {
  return SERVICE_OWNED_SETTINGS_MUTATIONS.has(method as ServiceOwnedSettingsMutationMethod);
}

export function isWorkerMutationMethod(
  method: WorkerMethod
): method is MutatingWorkerMethod | ServiceOwnedSettingsMutationMethod {
  return isMutatingWorkerMethod(method) || isServiceOwnedSettingsMutation(method);
}

export interface WorkerOperationId {
  readonly workerInstanceId: string;
  readonly sequence: bigint;
}

export type WorkerOperationState =
  | "running"
  | "completed"
  | "canceled"
  | "failed"
  | "unknown";

export type WorkerCancelReason = "user" | "deadline" | "shutdown";

const WORKER_INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isWorkerInstanceId(value: unknown): value is string {
  return typeof value === "string" && WORKER_INSTANCE_ID_PATTERN.test(value);
}

export function isWorkerOperationId(value: unknown): value is WorkerOperationId {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const id = value as Record<string, unknown>;
  return Object.keys(id).length === 2
    && isWorkerInstanceId(id.workerInstanceId)
    && typeof id.sequence === "bigint"
    && id.sequence >= 1n
    && id.sequence <= WORKER_MAX_OPERATION_SEQUENCE;
}

export function workerOperationKey(id: WorkerOperationId): string {
  return `${id.workerInstanceId}:${id.sequence}`;
}

export function sameWorkerOperationId(
  left: WorkerOperationId,
  right: WorkerOperationId
): boolean {
  return left.workerInstanceId === right.workerInstanceId
    && left.sequence === right.sequence;
}

export type MainToWorkerMessage =
  | {
      type: "bootstrap";
      dataDir: string;
      externalDataLock: true;
      /**
       * ADR007 machine tier, resolved by the parent so a platform that cannot
       * provide one reports it through the CLI rather than through a dead
       * worker. Absent only for a directly-posted bootstrap in tests.
       */
      machineDir?: string;
      /** Main created this directory during startup, so the worker fills it
       * with the starter stories. Absent on every later run. */
      freshDataDirectory?: true;
    }
  | {
      type: "request";
      id: WorkerOperationId;
      method: WorkerMethod;
      input: unknown;
      /** Schema that encoded `input`; retained outbox records may use v3. */
      protocolVersion: number;
      deadlineMs: number;
      mutationId?: string;
      expectedAggregateVersion?: unknown;
    }
  | { type: "ack"; id: WorkerOperationId; sequence: number }
  | { type: "cancel"; id: WorkerOperationId; reason: WorkerCancelReason }
  | { type: "status"; id: WorkerOperationId }
  | { type: "terminalAck"; id: WorkerOperationId }
  | { type: "shutdown" };

export type WorkerToMainMessage =
  | {
      type: "starting";
      protocolVersion: number;
      buildIdentity: BuildIdentity;
      workerInstanceId: string;
    }
  | {
      type: "ready";
      protocolVersion: number;
      buildIdentity: BuildIdentity;
      workerInstanceId: string;
    }
  | { type: "result"; id: WorkerOperationId; value: unknown }
  | {
      type: "error";
      id: WorkerOperationId;
      code: string;
      message: string;
      details?: { status?: number };
      mutationOutcome?: "terminal" | "uncertain";
    }
  | { type: "delta"; id: WorkerOperationId; sequence: number; text: string }
  | { type: "complete"; id: WorkerOperationId; value: unknown }
  | {
      type: "operation";
      id: WorkerOperationId;
      state: WorkerOperationState;
      terminal: boolean;
    }
  | { type: "protocolError"; message: string }
  | { type: "stopped" };

const METHODS: ReadonlySet<string> = new Set<WorkerMethod>([
  "listStories", "listStoriesPage", "createStory", "loadStory",
  "getUnknownOutcomeStatus", "previewChapterBreakRemoval",
  "renameStory", "autonameStory",
  "acknowledgeUnknownOutcomes", "deleteStory",
  "exportMarkdown", "switchLine", "createNode", "editNode", "deleteNode", "pruneUnusedTakes", "takeFromCut",
  "putBookmark", "deleteBookmark", "createFact", "patchFact", "deleteFact", "getSettings",
  "createChapterBreak", "renameChapterBreak", "removeChapterBreak", "restoreChapterBreak", "summarizeChapter",
  "saveSettings", "discardPendingSettings", "checkModelServer", "probeContextWindow",
  "discoverModels",
  "importSillyTavern", "continueStory",
  "rewriteNode", "createSummaryTake"
]);

export function isWorkerMethod(value: unknown): value is WorkerMethod {
  return typeof value === "string" && METHODS.has(value);
}

export function messageByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return null;
  }
}
