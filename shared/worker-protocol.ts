import type {
  TagStatus,
  ChapterBreak,
  CreateFactsRequest,
  CreateNodeRequest,
  EditNodeRequest,
  FactPatch,
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
import type { LorebookImport } from "./novelai-lorebook.js";

import type {
  ListStoriesPageInput,
  StoryCatalogPage
} from "./story-catalog.js";
import type { SearchRequest, SearchResponse } from "./story-search.js";
import type { StoryAggregateVersion } from "./story-aggregate-version.js";
import type { ProviderRecoveryContext } from "./provider-recovery.js";
import {
  AI_1667_BUILD_IDENTITY,
  type BuildIdentity
} from "./build-identity.js";
import type { FailureEnvelope } from "./failure-envelope.js";
export {
  isDiagnosticReference,
  type DiagnosticReference
} from "./diagnostic-reference.js";
export const LEGACY_WORKER_PROTOCOL_VERSION = 3;
export const PRE_Q_WORKER_PROTOCOL_VERSION = 4;
export const PREDECESSOR_WORKER_PROTOCOL_VERSION = 5;
export const PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION = 6;
export const PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION = 7;
export const PRE_FACT_ACTIVATION_WORKER_PROTOCOL_VERSION = 8;
export const WORKER_PROTOCOL_VERSION = 9;
/** Exact provider recovery changes the status and acknowledgement inputs. */
export const MUTATION_INPUT_PROTOCOL_VERSION = WORKER_PROTOCOL_VERSION;
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

export function isCurrentWorkerInputProtocolVersion(
  value: unknown
): value is number {
  return value === PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
    || value === PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION
    || value === PRE_FACT_ACTIVATION_WORKER_PROTOCOL_VERSION
    || value === WORKER_PROTOCOL_VERSION;
}

export function canonicalWorkerInputProtocolVersion(
  value: number
): number {
  return value === PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
    || value === PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION
    ? PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
    : value;
}

export interface WorkerMethodContract {
  listStories: { input: Record<string, never>; output: StorySummary[] };
  listStoriesPage: { input: ListStoriesPageInput; output: StoryCatalogPage };
  searchStories: { input: SearchRequest; output: SearchResponse };
  createStory: { input: { title?: string }; output: StoryPayload };
  loadStory: { input: { id: string }; output: StoryPayload };
  getUnknownOutcomeStatus: {
    input: {
      storyId: string;
      originalProviderMutationId: string;
      providerRecovery?: ProviderRecoveryContext;
    };
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
  setAuthorsNote: { input: { storyId: string; note: string }; output: StoryPayload };
  autonameStory: { input: { id: string; expectedTitle: string }; output: StoryPayload };
  acknowledgeUnknownOutcomes: {
    input: {
      storyId: string;
      originalProviderMutationId: string;
      providerRecovery?: ProviderRecoveryContext;
    };
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
  putBookmark: { input: { storyId: string; nodeId: string; name: string; label: TagStatus }; output: StoryPayload };
  deleteBookmark: { input: { storyId: string; nodeId: string }; output: StoryPayload };
  createFact: { input: { storyId: string; body: CreateFactsRequest }; output: StoryPayload };
  patchFact: { input: { storyId: string; factId: string; body: FactPatch }; output: StoryPayload };
  deleteFact: { input: { storyId: string; factId: string }; output: StoryPayload };
  createChapterBreak: {
    input: { storyId: string; parentPartId: string; title: string };
    output: { payload: StoryPayload; breakId: string };
  };
  renameChapterBreak: { input: { storyId: string; breakId: string | null; title: string }; output: StoryPayload };
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
  discoverModels: { input: { settings: ProviderProbeTarget }; output: ModelDiscoveryResultV2 };
  importSillyTavern: { input: { jsonl: string }; output: StoryPayload };
  importMarkdown: { input: { markdown: string; defaultTitle?: string }; output: StoryPayload };
  importNovelAI: { input: { storyContainerJson: string }; output: { payload: StoryPayload; fidelity: readonly string[] } };
  importScenario: { input: { jsonText: string }; output: { payload: StoryPayload; fidelity: readonly string[] } };
  importLorebook: { input: { storyId: string; archiveBytes: Uint8Array }; output: { payload: StoryPayload; importResult: LorebookImport } };
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
  | "createStory" | "renameStory" | "setAuthorsNote" | "autonameStory" | "acknowledgeUnknownOutcomes"
  | "deleteStory" | "switchLine"
  | "createNode" | "editNode" | "deleteNode" | "pruneUnusedTakes" | "takeFromCut"
  | "putBookmark" | "deleteBookmark" | "createFact" | "patchFact" | "deleteFact"
  | "createChapterBreak" | "renameChapterBreak" | "removeChapterBreak" | "restoreChapterBreak" | "summarizeChapter"
  | "importSillyTavern" | "importMarkdown" | "importNovelAI" | "importScenario" | "importLorebook" | "continueStory" | "rewriteNode" | "createSummaryTake";

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
  "createStory", "renameStory", "setAuthorsNote", "autonameStory", "acknowledgeUnknownOutcomes",
  "deleteStory", "switchLine",
  "createNode", "editNode", "deleteNode", "pruneUnusedTakes", "takeFromCut",
  "putBookmark", "deleteBookmark", "createFact", "patchFact", "deleteFact",
  "createChapterBreak", "renameChapterBreak", "removeChapterBreak", "restoreChapterBreak", "summarizeChapter",
  "importSillyTavern", "importMarkdown", "importNovelAI", "importScenario", "importLorebook", "continueStory", "rewriteNode", "createSummaryTake"
]);

export function isMutatingWorkerMethod(method: WorkerMethod): method is MutatingWorkerMethod {
  return MUTATING_METHODS.has(method as MutatingWorkerMethod);
}

/**
 * Mutations that never contact a provider and mutate exactly one existing
 * story aggregate. Losing one to a crash costs the user one keypress, so they
 * use the local durability tier: one atomic manifest publish, with no caller
 * outbox intent, no legacy receipt, and no ledger prepared/completed pair.
 *
 * Everything else keeps the full exactly-once pipeline: provider-backed
 * mutations must never re-bill or lose streamed prose, and the lifecycle
 * mutations (create/import/delete/acknowledge) anchor creation records,
 * reaper tombstones, and the provider-fence protocol in the ledger.
 */
export const LOCAL_DURABILITY_MUTATION_METHODS = [
  "renameStory", "setAuthorsNote", "switchLine",
  "createNode", "editNode", "deleteNode", "pruneUnusedTakes", "takeFromCut",
  "putBookmark", "deleteBookmark", "createFact", "patchFact", "deleteFact",
  "createChapterBreak", "renameChapterBreak", "removeChapterBreak", "restoreChapterBreak", "importLorebook"
] as const satisfies readonly MutatingWorkerMethod[];


export type LocalDurabilityMutationMethod =
  typeof LOCAL_DURABILITY_MUTATION_METHODS[number];

const LOCAL_DURABILITY_METHOD_SET: ReadonlySet<string> =
  new Set(LOCAL_DURABILITY_MUTATION_METHODS);

/** Membership in the local method set. Necessary for the manifest-only
 * marker but not sufficient: `isManifestOnlyDurabilityEligible` also
 * inspects the input, because some local methods can carry content that
 * exists nowhere else durable. */
export function isLocalDurabilityMutation(
  method: WorkerMethod
): method is LocalDurabilityMutationMethod {
  return LOCAL_DURABILITY_METHOD_SET.has(method);
}

/**
 * The single marker predicate, shared by the transport (where the marker is
 * set instead of a durable intent) and the worker's request parser (where a
 * marked request outside this contract is rejected). A request is eligible
 * for the manifest-only tier only when losing it to a crash re-costs at most
 * one human action. Two local methods can embed content whose only durable
 * copy would be the outbox intent, so they keep the full tier:
 *
 * - `createNode` with a `genId` settles a stopped generation; its text is
 *   paid streamed prose held only in caller memory.
 * - `restoreChapterBreak` re-installs removed summary nodes whose text may
 *   be paid provider output already deleted from the store.
 *
 * Malformed inputs are not eligible: they fail toward the full tier, whose
 * validation rejects them with the mutation identity durably fenced.
 */
export function isManifestOnlyDurabilityEligible(
  method: WorkerMethod,
  input: unknown
): method is LocalDurabilityMutationMethod {
  if (!isLocalDurabilityMutation(method)) return false;
  if (method === "restoreChapterBreak") return false;
  if (method === "createNode") return !createNodeCarriesGeneration(input);
  return true;
}

function createNodeCarriesGeneration(input: unknown): boolean {
  if (input === null || typeof input !== "object") return true;
  const body = (input as Record<string, unknown>).body;
  if (body === null || typeof body !== "object") return true;
  const genId = (body as Record<string, unknown>).genId;
  return genId !== undefined && genId !== null;
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
       * The machine tier, resolved by the parent so a platform that cannot
       * provide one reports it through the CLI rather than through a dead
       * worker. Absent only for a directly-posted bootstrap in tests.
       */
      machineDir?: string;
      /** Echo unexpected embedded errors to stderr as well as the private log. */
      printLogs?: true;
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
      /**
       * Explicit local-durability-tier marker. The transport sets it only on
       * a fresh call it did not record in the durable outbox, so a request
       * that arrives without it — an outbox replay, an older build, or the
       * HTTP path — always takes the full receipt/ledger pipeline. The tier
       * is selected by this marker, never inferred from the method.
       */
      durability?: "manifest-only";
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
      failure: FailureEnvelope;
      mutationOutcome?: "terminal" | "uncertain";
      providerMutationId?: string;
    }
  | { type: "delta"; id: WorkerOperationId; sequence: number; text: string }
  | {
      type: "complete";
      id: WorkerOperationId;
      value: unknown;
      stoppedText?: string;
    }
  | {
      type: "operation";
      id: WorkerOperationId;
      state: WorkerOperationState;
      terminal: boolean;
    }
  | { type: "protocolError"; failure: FailureEnvelope }
  | { type: "stopped" };

const METHODS: ReadonlySet<string> = new Set<WorkerMethod>([
  "listStories", "listStoriesPage", "searchStories", "createStory", "loadStory",
  "getUnknownOutcomeStatus", "previewChapterBreakRemoval",
  "renameStory", "setAuthorsNote", "autonameStory",
  "acknowledgeUnknownOutcomes", "deleteStory",
  "exportMarkdown", "switchLine", "createNode", "editNode", "deleteNode", "pruneUnusedTakes", "takeFromCut",
  "putBookmark", "deleteBookmark", "createFact", "patchFact", "deleteFact", "getSettings",
  "createChapterBreak", "renameChapterBreak", "removeChapterBreak", "restoreChapterBreak", "summarizeChapter",
  "saveSettings", "discardPendingSettings", "checkModelServer", "probeContextWindow",
  "discoverModels",
  "importSillyTavern", "importMarkdown", "importNovelAI", "importScenario", "importLorebook", "continueStory",

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
