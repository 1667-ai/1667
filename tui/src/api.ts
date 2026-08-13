import { httpCapabilityScopeForApiPath } from "../../shared/http-capability-scope.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import type { HttpFetch } from "./direct-loopback-http.js";
import type { ReasoningDelta } from "./worker-pending.js";
import {
  readSseEvents,
  readSseText,
  SseIdleTimeoutError,
  withSseIdleTimeout
} from "./sse-stream-reader.js";
import {
  decodeChapterBreakCreatedResponse,
  decodeChapterBreakRemovalPreview,
  decodeChapterBreakRemovedResponse,
  decodeContinueStoryResponse,
  decodeDeleteStoryResponse,
  decodeSearchResponse,
  decodeStoryCatalogPageResponse,
  decodeUnknownOutcomeStatusResponse,
  decodeSettingsMutationResult,
  decodeSettingsViewResponse,
  decodeCommitPartialRewriteResponse,
  decodeStoryResponse,
  decodeSummaryTakeResponse,
  decodeTokenProbabilitiesResponse,
  decodeReasoningResponse,
} from "./api-response-decoders.js";
import {
  decodeGenerationRecordSummariesResponse,
  decodeGenerationRecordResponse,
} from "./generation-record-response-decoders.js";
import type {
  SamplingBiasResolutionResult
} from "../../shared/sampling-capabilities.js";
import type { SamplingPhraseBiasEntryV2 } from "../../shared/settings-v2-types.js";
import type { RemovedChapterBreak } from "./api-response-decoders.js";
import { storyFieldApi } from "./api-story-fields.js";
import type { LorebookImport } from "../../shared/lorebook-entry.js";
import type { CardImportPlan } from "../../shared/card-import.js";
import type { FactBudgetDrop } from "../../shared/fact-budget.js";
import type { TokenProbabilityRecord } from "../../shared/token-probabilities.js";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../../shared/generation-record.js";
import type { ReasoningRecord } from "../../shared/reasoning.js";

import type {
  TagStatus,
  TagRequest,
  CreateFactsRequest,
  CreateNodeRequest,
  DeleteNodeRequest,
  FactPatch,
  GenerationSettings,
  ModelServerCheckResult,
  PasteStoryLineRequest,
  PruneUnusedTakesRequest,
  ReorderFactRequest,
  RewriteRequest,
  StoryNode,
  StoryMarkdownExport,
  StoryPayload,
  StorySummary,
  SwitchRequest,
  TakeFromCutRequest
} from "../../shared/types.js";
import type {
  DiscardPendingSettingsCommand,
  ModelDiscoveryResultV2,
  ProviderProbeTarget,
  SaveSettingsCommand,
  SettingsMutationResult,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { ChatMessage } from "../../shared/prompt-plan.js";
import type { PromptTokenCount } from "../../shared/tokenize-source.js";
import {
  HTTP_FIDELITY_HEADER,
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER,
  type HttpApiMetadata
} from "../../shared/http-protocol.js";
import {
  HttpOperationClient,
  HttpOperationError,
  type HttpListenerBinding,
  type HttpOperationRunOptions
} from "../../shared/http-operation-client.js";
import type {
  HttpListenerAuthority
} from "../../shared/http-listener-authority.js";
import {
  HTTP_OPERATION_LIFETIME_MS
} from "../../shared/http-operation-protocol.js";
import { isWorkerMutationMethod } from "../../shared/worker-protocol.js";
import { resolveHttpApiRoute } from "../../shared/http-operation-policy.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import type { ProviderRecoveryContext } from "../../shared/provider-recovery.js";
import type { StoryCatalogPage } from "../../shared/story-catalog.js";
import type { SearchRequest, SearchResponse } from "../../shared/story-search.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { HttpStoryVersions } from "./http-story-versions.js";
import {
  MemoryHttpMutationIntentStore,
  type HttpAbsentMutation,
  type HttpMutationIntentClaim,
  type HttpMutationIntentStore
} from "./http-mutation-intents.js";
import {
  ApiError,
  ApiHttpError,
  ApiRecoveryRequiredError,
  apiHttpErrorFromPayload
} from "./api-error.js";
import { HttpApiConnection } from "./http-api-connection.js";
import { importMethods } from "./api-import-methods.js";
import { providerMethods } from "./api-provider-methods.js";
import { imageMethods } from "./api-image-methods.js";
import type {
  DraftImageReference,
  SourceImageMediaType,
  StoryImageAttachment
} from "../../shared/image-attachment.js";

export type { RemovedChapterBreak } from "./api-response-decoders.js";
export {
  ApiError,
  ApiHttpError,
  ApiRecoveryRequiredError,
  apiErrorCode
} from "./api-error.js";

const HTTP_REQUEST_TIMEOUT_MS = 15_000;
export const HTTP_GENERATION_REQUEST_TIMEOUT_MS =
  HTTP_OPERATION_LIFETIME_MS.generation;
export const HTTP_GENERATION_RECORD_READ_TIMEOUT_MS =
  HTTP_OPERATION_LIFETIME_MS.transfer;
export interface ContinueTarget {
  parentId?: string | null;
  appendTo?: string;
  expectedTextHash?: string;
}

/** The shape every import that carries a Fidelity Report returns: NovelAI,
 *  Scenario, and SillyTavern alike. */
export interface NovelAiStoryImportResult {
  readonly payload: StoryPayload;
  readonly fidelity: readonly string[];
}

/** Invariant relied on by the connection monitor's failure detection: any
 *  method that streams takes its AbortSignal as the LAST parameter. Keep new
 *  methods on that shape or teach connection.ts about the exception. */
/** The optional side channels a streamed generation call reports, bundled
 *  into one trailing parameter instead of a run of positional callbacks.
 *  The positional list had grown enough that a caller once passed
 *  `onReasoning` into the slot meant for a different callback and it still
 *  type-checked, because every one of these is function-shaped —
 *  `onStopped`/`onReasoning`/`onReasoningStopped` exist only for a
 *  generation that keeps a stopped attempt's partial output —
 *  `continueStory`'s saved fragment, `rewriteNode`'s stashed partial
 *  replacement. `createSummaryTake`, which always discards a stopped
 *  attempt whole (summary-action.ts's `reloadAfterStop`), takes the
 *  narrower `SummaryStreamCallbacks` below instead of this bag: there is no
 *  withheld tail on either channel for it to deliver. */
export interface StreamCallbacks {
  /** Receives, exactly once at terminal settlement, stream text that
   * arrived after `signal` aborted. `onDelta` never fires after the
   * abort, so a caller that saves stopped text must take this tail too.
   * Both transports produce it when they drain text after a Stop. */
  onStopped?: (text: string) => void;
  /** Same shape as `onDelta`, on the reasoning ("thinking") channel —
   * never the same callback, so reasoning can never reach a caller that
   * only asked for prose. */
  onReasoning?: (delta: ReasoningDelta) => void;
  /** Same contract as `onStopped`, on the reasoning channel. */
  onReasoningStopped?: (text: string) => void;
}

/** `createSummaryTake`'s own callback bag. See `StreamCallbacks`'s doc for
 *  why `onStopped`/`onReasoningStopped` are missing here, not merely
 *  unused. */
export interface SummaryStreamCallbacks {
  /** Same shape as `onDelta`, on the reasoning channel. */
  onReasoning?: (delta: ReasoningDelta) => void;
}

/** The point `createSummaryTake` actually summarized, when it was earlier
 *  than the one requested — see server/summary-take.ts's
 *  `fittingSummaryPoint` and shared/worker-protocol.ts's `createSummaryTake`. */
export interface NarrowedSummaryPoint {
  nodeId: string;
  offset: number | null;
}

export interface StoryApi {
  listStories(): Promise<StorySummary[]>;
  searchStories(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  createStory(title?: string): Promise<StoryPayload>;
  loadStory(id: string): Promise<StoryPayload>;
  renameStory(id: string, title: string): Promise<StoryPayload>;
  setAuthorsNote(storyId: string, note: string, depth?: number): Promise<StoryPayload>;
  setAuthorBrief(storyId: string, brief: string): Promise<StoryPayload>;
  /** null clears the story's Facts budget. */
  setFactsBudget(storyId: string, budgetTokens: number | null): Promise<StoryPayload>;
  /** Adds to the routed profile's own phraseBias rather than replacing it —
   *  see the field comment on `Story.phraseBias` (shared/types.ts). An empty
   *  array clears it. */
  setPhraseBias(storyId: string, phraseBias: readonly SamplingPhraseBiasEntryV2[]): Promise<StoryPayload>;
  /** Same story-adds-to-profile relationship as `setPhraseBias`, for the
   *  banned-strings list. */
  setBannedStrings(storyId: string, bannedStrings: readonly string[]): Promise<StoryPayload>;
  autonameStory(id: string): Promise<StoryPayload>;
  acknowledgeUnknownOutcomes(
    storyId: string,
    originalProviderMutationId: string,
    providerRecovery?: ProviderRecoveryContext
  ): Promise<StoryPayload | null>;
  deleteStory(id: string): Promise<{ ok: true }>;
  exportMarkdown(id: string): Promise<StoryMarkdownExport>;
  /** One take's stored token probabilities. Rejects (404, distinguishably by
   *  message) when the take has none. */
  getTokenProbabilities(storyId: string, nodeId: string): Promise<TokenProbabilityRecord>;
  /** Every Generation Record event on one take, oldest first. The transport
   *  uses the transfer deadline because a full valid history can be large. */
  getGenerationRecords(storyId: string, nodeId: string): Promise<GenerationRecordSummary[]>;
  /** One Generation Record, resolved: every source part's prose read back
   *  from its exact historical revision. Rejects (404) for an id the take's
   *  own history no longer lists. */
  getGenerationRecord(storyId: string, nodeId: string, recordId: string): Promise<ResolvedGenerationRecord>;
  /** One take's stored thought. Rejects (404, distinguishably by message)
   *  when the take has none. */
  getReasoning(storyId: string, nodeId: string): Promise<ReasoningRecord>;
  /** Complete bounded Aside document. Empty when none exists. */
  getAside(storyId: string): Promise<{ notes: readonly { question: string; answer: string }[] }>;
  /** Stream one Aside question. Null means cancelled before save. */
  askAside(
    storyId: string,
    question: string,
    onDelta: (text: string) => void,
    signal: AbortSignal
  ): Promise<AsideAskResult | null>;
  /** Clear every Side Note for one story. */
  clearAside(storyId: string): Promise<StoryPayload>;
  switchLine(storyId: string, nodeId: string, options?: Omit<SwitchRequest, "nodeId">): Promise<StoryPayload>;
  createNode(storyId: string, body: CreateNodeRequest): Promise<StoryPayload>;
  editNode(storyId: string, node: StoryNode, patch: { instruction?: string; text?: string }): Promise<StoryPayload>;
  deleteNode(storyId: string, nodeId: string, expectedSubtreeCount: number): Promise<StoryPayload>;
  pruneUnusedTakes(storyId: string, body: PruneUnusedTakesRequest): Promise<StoryPayload>;
  takeFromCut(storyId: string, nodeId: string, body: TakeFromCutRequest): Promise<StoryPayload>;
  /** `targetParentId` is the story part the copied line attaches below. */
  pasteStoryLine(storyId: string, targetParentId: string, body: PasteStoryLineRequest): Promise<StoryPayload>;
  putBookmark(storyId: string, nodeId: string, name: string, status: TagStatus): Promise<StoryPayload>;
  deleteBookmark(storyId: string, nodeId: string): Promise<StoryPayload>;
  createFact(storyId: string, body: CreateFactsRequest): Promise<StoryPayload>;
  patchFact(storyId: string, factId: string, body: FactPatch): Promise<StoryPayload>;
  deleteFact(storyId: string, factId: string): Promise<StoryPayload>;
  /** Move a Fact to a new position among the story's Facts — array order is
   *  emit order, so this is the Facts surface's "arrange" control. */
  reorderFact(storyId: string, factId: string, toIndex: number): Promise<StoryPayload>;
  createChapterBreak(storyId: string, parentPartId: string, title?: string): Promise<{ payload: StoryPayload; breakId: string }>;
  /** A null break id names chapter one, which no break opens. */
  renameChapterBreak(storyId: string, breakId: string | null, title: string): Promise<StoryPayload>;
  removeChapterBreak(storyId: string, breakId: string): Promise<{ payload: StoryPayload; removed: RemovedChapterBreak }>;
  restoreChapterBreak(storyId: string, breakId: string, removed: RemovedChapterBreak): Promise<StoryPayload>;
  summarizeChapter(storyId: string, breakId: string, signal?: AbortSignal): Promise<StoryPayload>;
  editChapterSummary(storyId: string, summaryId: string, text: string, expected: string): Promise<StoryPayload>;
  getSettings(): Promise<SettingsView>;
  saveSettings(command: SaveSettingsCommand): Promise<SettingsMutationResult>;
  discardPendingSettings(command: DiscardPendingSettingsCommand): Promise<SettingsMutationResult>;
  checkModelServer(settings: ProviderProbeTarget): Promise<ModelServerCheckResult>;
  probeContextWindow(settings: ProviderProbeTarget): Promise<{ contextWindow: number | null }>;
  resolveSamplingBias(
    request: {
      settings: ProviderProbeTarget;
      logitBias: Readonly<Record<string, number>>;
      phraseBias: readonly SamplingPhraseBiasEntryV2[];
      bannedStrings: readonly string[];
      /** The one story's own overlay, when previewing a story's phraseBias/
       *  bannedStrings editor rather than the profile's — combined with the
       *  above the same way a request combines them (issue #341). */
      storyPhraseBias?: readonly SamplingPhraseBiasEntryV2[];
      storyBannedStrings?: readonly string[];
    }
  ): Promise<SamplingBiasResolutionResult>;
  discoverModels(
    settings: ProviderProbeTarget,
    signal?: AbortSignal
  ): Promise<ModelDiscoveryResultV2>;
  countPromptTokens(
    messages: readonly ChatMessage[],
    signal?: AbortSignal
  ): Promise<PromptTokenCount>;
  importSillyTavern(jsonl: string): Promise<NovelAiStoryImportResult>;
  importMarkdown(markdown: string, defaultTitle?: string): Promise<StoryPayload>;
  importNovelAI(storyContainerJson: string): Promise<NovelAiStoryImportResult>;
  importScenario(jsonText: string): Promise<NovelAiStoryImportResult>;
  importLorebook(storyId: string, archiveBytes: Uint8Array): Promise<{ payload: StoryPayload; importResult: LorebookImport }>;
  importCard(storyId: string, cardBytes: Uint8Array): Promise<{ payload: StoryPayload; plan: CardImportPlan }>;
  /** Stage one Source Image as a Draft Image. Not a story mutation. */
  stageStoryImage(
    storyId: string,
    mediaType: SourceImageMediaType,
    bytes: Uint8Array
  ): Promise<{ leaseId: string; attachment: StoryImageAttachment }>;
  /** Idempotently remove one Draft Lease. Releasing an absent or already
   *  expired lease succeeds with no error. Not a story mutation. */
  releaseStoryImage(storyId: string, leaseId: string): Promise<void>;

  continueStory(
    storyId: string,
    instruction: string,
    genId: string,
    target: ContinueTarget,
    onDelta: (text: string) => void,
    signal: AbortSignal,
    callbacks?: StreamCallbacks,
    /** Ordered Draft Image references for the take being generated. They ride
     *  beside `instruction` and `genId` rather than inside `target`, because
     *  `target` is a closed union about append versus parent. A Retake's
     *  inherited attachments are never sent: the server derives those from the
     *  current manifest. */
    images?: readonly DraftImageReference[]
  ): Promise<{ payload: StoryPayload; droppedFacts: readonly FactBudgetDrop[] } | null>;
  rewriteNode(
    storyId: string,
    nodeId: string,
    body: RewriteRequest,
    onDelta: (text: string) => void,
    signal: AbortSignal,
    /** Fires the instant the take id is known — durable server-side from
     * that point on — and strictly before any refresh this call makes on
     * its way back to the caller. The caller (rewrite-action.ts) uses this
     * to record commitment one layer below where its own await resolves, so
     * a refresh that then rejects cannot hide a take that already landed. */
    onCommitted?: (takeId: string) => void,
    callbacks?: StreamCallbacks
  ): Promise<string | null>;
  /** Settle a stopped or timed-out rewrite (issue #339): ask the backend to
   * commit the verified partial it stashed for this part. `streamedDigest`
   * identifies the exact prose this client watched stream, tail included;
   * the backend refuses on any byte difference. null = nothing was committed
   * and the story is unchanged. */
  commitPartialRewrite(
    storyId: string,
    nodeId: string,
    streamedDigest: string,
    attemptId: string
  ): Promise<{ payload: StoryPayload; nodeId: string } | null>;
  createSummaryTake(
    storyId: string,
    body: { nodeId: string; offset?: number; expected?: string },
    onDelta: (text: string) => void,
    signal: AbortSignal,
    callbacks?: SummaryStreamCallbacks
  ): Promise<{ nodeId: string; narrowedTo: NarrowedSummaryPoint | null } | null>;
}

/** Terminal Aside view plus the refreshed story, when its version refresh
 * succeeded after the provider committed the Side Note. */
export interface AsideAskResult {
  readonly notes: readonly { question: string; answer: string }[];
  readonly payload?: StoryPayload;
}

export interface HttpApiAccess {
  readonly authority: HttpListenerAuthority;
  readonly mutationIntents?: HttpMutationIntentStore;
}

export function createApi(
  baseUrl: string,
  onMetadata: ((metadata: HttpApiMetadata) => boolean | void) | undefined,
  access: HttpApiAccess
): StoryApi {
  const root = parseCanonicalLoopbackOrigin(baseUrl).origin;
  const mutationIntents = access.mutationIntents
    ?? new MemoryHttpMutationIntentStore();
  const url = (path: string) => `${root}${path}`;
  const versions = new HttpStoryVersions();
  const connection = new HttpApiConnection({
    root,
    authority: access.authority,
    ...(onMetadata === undefined ? {} : { onMetadata })
  });
  const operations = new HttpOperationClient({
    authority: access.authority,
    onSession: (_scope, payload) =>
      connection.publishRecoveryWarnings(payload.recoveryWarnings)
  });
  const runOperation = async <T>(
    options: HttpOperationRunOptions<T>
  ): Promise<T> => {
    try {
      return await operations.run(options);
    } catch (error) {
      if (error instanceof HttpOperationError) {
        throw new ApiHttpError(error.failure, false);
      }
      throw error;
    }
  };
  const compatible = async <T>(
    work: (binding: HttpListenerBinding) => Promise<T>,
    refresh = false,
    signal?: AbortSignal,
    mutation = false
  ): Promise<T> =>
    await connection.run(work, refresh, signal, mutation);
  const request = async <T>(
    method: string,
    path: string,
    decode: (payload: unknown) => T,
    body?: unknown,
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
    expectedAggregateVersion?: StoryAggregateVersion,
    callerSignal?: AbortSignal,
    mutationId?: string,
    /** Overrides the default `application/octet-stream` a `Uint8Array` body
     *  otherwise sends — a Draft Image upload needs its real media type so
     *  the server's Content-Type check can tell PNG from JPEG from WebP.
     *  Ignored for a string or absent body. */
    binaryContentType?: string
  ): Promise<T> => {
    // A unary request retains the one backend-action owner until settlement,
    // so plain requests get a hard timeout. Local/control input remains live;
    // streaming calls keep their user-driven abort signal instead.
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal === undefined
      ? deadlineSignal
      : AbortSignal.any([callerSignal, deadlineSignal]);
    const mutation = isWorkerMutationMethod(
      resolveHttpApiRoute(method, path).method
    );
    return await compatible(async (binding) => {
      const entryRecoveryEpoch = connection.recoveryEpoch;
      return await runOperation({
        method,
        path,
        binding,
        ...(mutationId === undefined ? {} : { mutationId }),
        requestedLifetimeMs: timeoutMs,
        ...(expectedAggregateVersion === undefined
          ? {}
          : { expectedAggregateVersion }),
        callerSignal: signal,
        beforeSend: () => {
          if (mutation
            && connection.recoveryEpoch !== entryRecoveryEpoch) {
            throw new ApiRecoveryRequiredError();
          }
        },
        execute: async (lease) => {
          const response = await lease.fetch(url(path), {
            method,
            headers: {
              ...lease.headers,
              ...(body === undefined
                ? {}
                : {
                  "content-type": body instanceof Uint8Array
                    ? binaryContentType ?? "application/octet-stream"
                    : "application/json"
                })
            },
            // A byte body is already bytes. JSON.stringify would send it as
            // an index object, which the byte-reading route then reads as
            // text. Send the Uint8Array itself: global fetch accepts it
            // directly, and `createDirectLoopbackFetch` (--url mode) accepts
            // only a string or a Uint8Array — never an ArrayBuffer.
            body: body === undefined
              ? undefined
              : body instanceof Uint8Array
                ? body.slice()
                : JSON.stringify(body),
            redirect: "error",
            signal: lease.signal
          });
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            throw apiHttpErrorFromPayload(
              payload,
              `${method} ${path} failed (${response.status})`,
              response.status
            );
          }
          return decode(payload);
        },
        shouldRetry: (error) => !(error instanceof ApiError)
      });
    }, true, signal, mutation);
  };
  const loadVersionedStory = async (
    storyId: string,
    callerSignal?: AbortSignal
  ): Promise<StoryPayload> =>
    versions.rememberPayload(await request(
      "GET",
      `/api/stories/${storyId}`,
      decodeStoryResponse,
      undefined,
      HTTP_REQUEST_TIMEOUT_MS,
      undefined,
      callerSignal
    ));
  const expectedVersion = async (
    storyId: string,
    callerSignal?: AbortSignal
  ): Promise<StoryAggregateVersion> => await versions.expected(
    storyId,
    () => loadVersionedStory(storyId, callerSignal)
  );
  const runProviderMutation = async <T>(
    storyId: string,
    work: () => Promise<T>
  ): Promise<T> => {
    try {
      const result = await work();
      if (result === null) versions.forget(storyId);
      return result;
    } catch (error) {
      // A terminal provider failure can advance the receipt-only story
      // revision without returning a payload that carries the new token.
      versions.forget(storyId);
      throw error;
    }
  };
  const stream = async (
    storyId: string,
    path: string,
    payload: unknown,
    onDelta: (text: string) => void,
    signal: AbortSignal,
    callbacks: StreamCallbacks = {}
  ) => {
    if (signal.aborted) return null;
    try {
      return await runProviderMutation(storyId, async () => {
        const expectedAggregateVersion = await expectedVersion(
          storyId,
          signal
        );
        return await compatible(
          async (binding) => {
            const entryRecoveryEpoch = connection.recoveryEpoch;
            return await runOperation({
              method: "POST",
              path,
              binding,
              requestedLifetimeMs: HTTP_GENERATION_REQUEST_TIMEOUT_MS,
              expectedAggregateVersion,
              callerSignal: signal,
              beforeSend: () => {
                if (connection.recoveryEpoch !== entryRecoveryEpoch) {
                  throw new ApiRecoveryRequiredError();
                }
              },
              execute: async (lease) =>
                await streamSse(
                  lease.fetch,
                  url(path),
                  payload,
                  onDelta,
                  lease.signal,
                  signal,
                  lease.headers,
                  callbacks
                ),
              shouldRetry: (error) => !(error instanceof ApiError
                || error instanceof SseIdleTimeoutError)
            });
          },
          true,
          signal,
          true
        );
      });
    } catch (error) {
      // A parsed SSE terminal or a failed operation-status settlement is
      // canonical server evidence. It stays authoritative over a Stop that
      // arrived from an earlier delta in the same read.
      if (error instanceof ApiHttpError) throw error;
      if (signal.aborted) return null;
      throw error;
    }
  };
  const mutateStoryPayload = async (
    storyId: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
    callerSignal?: AbortSignal
  ): Promise<StoryPayload> => versions.rememberPayload(await request(
    method,
    path,
    decodeStoryResponse,
    body,
    timeoutMs,
    await expectedVersion(storyId, callerSignal),
    callerSignal
  ));

  const runAbsentImportMutation = async <T>(
    workerMethod: HttpAbsentMutation,
    intentKey: string,
    path: string,
    contentType: string,
    body: string,
    decode: (value: unknown) => T
  ): Promise<T> => {
    const intent = await mutationIntents.claim(workerMethod, intentKey);
    try {
      const payload = await compatible(
        async (binding) => {
          const signal = AbortSignal.timeout(
            HTTP_OPERATION_LIFETIME_MS.transfer
          );
          const entryRecoveryEpoch = connection.recoveryEpoch;
          return await runOperation({
            method: "POST",
            path,
            binding,
            mutationId: intent.mutationId,
            requestedLifetimeMs: HTTP_OPERATION_LIFETIME_MS.transfer,
            expectedAggregateVersion: { kind: "absent" },
            callerSignal: signal,
            beforeSend: () => {
              if (connection.recoveryEpoch !== entryRecoveryEpoch) {
                throw new ApiRecoveryRequiredError();
              }
            },
            execute: async (lease) => {
              const response = await lease.fetch(url(path), {
                method: "POST",
                headers: {
                  ...lease.headers,
                  "content-type": contentType
                },
                body,
                redirect: "error",
                signal: lease.signal
              });
              const payload: unknown = await response.json().catch(() => null);
              if (!response.ok) {
                throw apiHttpErrorFromPayload(
                  payload,
                  `Import failed (${response.status})`,
                  response.status
                );
              }
              return decode(payload);
            },
            shouldRetry: (error) => !(error instanceof ApiError)
          });
        },
        true,
        undefined,
        true
      );
      await intent.complete();
      return payload;
    } catch (error) {
      return await settleAbsentMutationFailure(intent, error);
    }
  };

  return {
    listStories: async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const held = new Map<string, StorySummary>();
        let scanId: string | null = null;
        let cursor: string | null = null;
        try {
          do {
            const page: StoryCatalogPage = await request(
              "POST",
              "/api/stories/catalog-page",
              decodeStoryCatalogPageResponse,
              { cursor, maxEntries: 64 }
            );
            if (scanId !== null && page.scanId !== scanId) {
              throw new Error(
                "The story catalog scan changed between pages."
              );
            }
            scanId = page.scanId;
            for (const summary of page.items) {
              const current = held.get(summary.id);
              if (current === undefined
                || summaryIsNewer(summary, current)) {
                held.set(summary.id, summary);
              }
            }
            cursor = page.cursor;
          } while (cursor !== null);
        } catch (error) {
          if (attempt === 0
            && error instanceof ApiHttpError
            && error.code === "catalog_cursor_expired") {
            continue;
          }
          throw error;
        }
        return versions.rememberSummaries(
          [...held.values()].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt))
        );
      }
      throw new Error("The story catalog retry was exhausted.");
    },
    searchStories: async (search, signal) => await request(
      "POST",
      "/api/stories/search",
      decodeSearchResponse,
      search,
      HTTP_REQUEST_TIMEOUT_MS,
      undefined,
      signal
    ),
    createStory: async (title) => {
      const normalizedTitle = title?.trim() || "Untitled";
      const intent = await mutationIntents.claim(
        "createStory",
        normalizedTitle
      );
      try {
        const payload = await request(
          "POST",
          "/api/stories",
          decodeStoryResponse,
          { title: normalizedTitle },
          HTTP_REQUEST_TIMEOUT_MS,
          { kind: "absent" },
          undefined,
          intent.mutationId
        );
        await intent.complete();
        return versions.rememberPayload(payload);
      } catch (error) {
        return await settleAbsentMutationFailure(intent, error);
      }
    },
    loadStory: loadVersionedStory,
    ...storyFieldApi(mutateStoryPayload),
    autonameStory: async (id) => {
      return await runProviderMutation(id, async () => {
        const current = await loadVersionedStory(id);
        return await mutateStoryPayload(
          id,
          "POST",
          `/api/stories/${id}/autoname`,
          { expectedTitle: current.title },
          HTTP_GENERATION_REQUEST_TIMEOUT_MS
        );
      });
    },
    acknowledgeUnknownOutcomes: async (
      storyId,
      originalProviderMutationId
    ) => {
      const status = await request(
        "GET",
        `/api/stories/${storyId}/unknown-outcomes/${originalProviderMutationId}`,
        decodeUnknownOutcomeStatusResponse
      );
      if (status.state === "resolved") {
        if (status.deleted) {
          versions.forget(storyId);
          return null;
        }
        return await loadVersionedStory(storyId);
      }
      versions.set(storyId, status.aggregateVersion);
      const payload = await request(
        "POST",
        `/api/stories/${storyId}/unknown-outcomes/`
          + `${originalProviderMutationId}/ack`,
        (payload) => payload === null ? null : decodeStoryResponse(payload),
        {},
        HTTP_REQUEST_TIMEOUT_MS,
        status.aggregateVersion
      );
      if (payload === null) versions.forget(storyId);
      else versions.rememberPayload(payload);
      return payload;
    },
    deleteStory: async (id) => {
      const result = await request(
        "DELETE",
        `/api/stories/${id}`,
        decodeDeleteStoryResponse,
        undefined,
        HTTP_REQUEST_TIMEOUT_MS,
        await expectedVersion(id)
      );
      versions.forget(id);
      return result;
    },
    exportMarkdown: async (id) => compatible(
      async (binding) => {
        const path = `/api/stories/${id}/export`;
        const signal = AbortSignal.timeout(
          HTTP_OPERATION_LIFETIME_MS.transfer
        );
        return await runOperation({
          method: "GET",
          path,
          binding,
          requestedLifetimeMs: HTTP_OPERATION_LIFETIME_MS.transfer,
          callerSignal: signal,
          execute: async (lease) => {
            const response = await lease.fetch(url(path), {
              headers: lease.headers,
              redirect: "error",
              signal: lease.signal
            });
            const text = await response.text();
            if (!response.ok) {
              const payload = parseJson(text);
              throw apiHttpErrorFromPayload(
                payload,
                `GET /api/stories/${id}/export failed (${response.status})`,
                response.status
              );
            }
            const fidelityHeader = response.headers.get(HTTP_FIDELITY_HEADER);
            let fidelity: readonly string[] = [];
            if (fidelityHeader !== null && fidelityHeader.length > 0) {
              try {
                const parsed: unknown = JSON.parse(decodeURIComponent(fidelityHeader));
                if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
                  throw new Error("invalid fidelity report");
                }
                fidelity = parsed;
              } catch {
                throw new Error("The server returned an invalid Markdown export fidelity report.");
              }
            }
            return { markdown: text, fidelity };
          }
        });
      },
      true
    ),
    getTokenProbabilities: (storyId, nodeId) => request(
      "GET",
      `/api/stories/${storyId}/nodes/${nodeId}/token-probabilities`,
      decodeTokenProbabilitiesResponse
    ),
    getGenerationRecords: (storyId, nodeId) => request(
      "GET",
      `/api/stories/${storyId}/nodes/${nodeId}/generation-records`,
      decodeGenerationRecordSummariesResponse,
      undefined,
      HTTP_GENERATION_RECORD_READ_TIMEOUT_MS
    ),
    getGenerationRecord: (storyId, nodeId, recordId) => request(
      "GET",
      `/api/stories/${storyId}/nodes/${nodeId}/generation-records/${recordId}`,
      decodeGenerationRecordResponse,
      undefined,
      HTTP_GENERATION_RECORD_READ_TIMEOUT_MS
    ),
    getReasoning: (storyId, nodeId) => request(
      "GET",
      `/api/stories/${storyId}/nodes/${nodeId}/reasoning`,
      decodeReasoningResponse
    ),
    getAside: (storyId) => request(
      "GET",
      `/api/stories/${storyId}/aside`,
      (value) => {
        if (value === null || typeof value !== "object" || !Array.isArray((value as { notes?: unknown }).notes)) {
          throw new Error("The server did not return an Aside document.");
        }
        return value as { notes: readonly { question: string; answer: string }[] };
      }
    ),
    askAside: async (storyId, question, onDelta, signal) => {
      const done = await stream(
        storyId,
        `/api/stories/${storyId}/aside/ask`,
        { question },
        onDelta,
        signal
      );
      if (done === null) return null;
      if (done.aside === null) return null;
      if (done.aside === undefined || typeof done.aside !== "object") {
        throw new Error("The server did not return an Aside result.");
      }
      // The Aside terminal event carries the document view, not a StoryPayload
      // and its aggregate version. Refresh the version before the next local
      // mutation, or a clear/delete can use the pre-Aside revision. The Aside
      // is already committed when this event arrives. A refresh failure must
      // not hide that document and invite a duplicate question; forget the
      // stale token so the next mutation loads it lazily.
      const aside = done.aside as { notes: readonly { question: string; answer: string }[] };
      let payload: StoryPayload | undefined;
      try {
        payload = await loadVersionedStory(storyId);
      } catch {
        versions.forget(storyId);
      }
      return payload === undefined ? aside : { ...aside, payload };
    },
    clearAside: (storyId) => mutateStoryPayload(
      storyId,
      "DELETE",
      `/api/stories/${storyId}/aside`
    ),
    switchLine: (storyId, nodeId, options = {}) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/switch`,
      { nodeId, ...options } satisfies SwitchRequest
    ),
    createNode: (storyId, body) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/nodes`,
      body
    ),
    editNode: async (storyId, node, patch) => mutateStoryPayload(
      storyId,
      "PATCH",
      `/api/stories/${storyId}/nodes/${node.id}`,
      {
        ...patch,
        expectedTextHash: await textHash(node.text)
      }
    ),
    deleteNode: (storyId, nodeId, expectedSubtreeCount) =>
      mutateStoryPayload(
        storyId,
        "DELETE",
        `/api/stories/${storyId}/nodes/${nodeId}`,
        { expectedSubtreeCount } satisfies DeleteNodeRequest
      ),
    pruneUnusedTakes: (storyId, body) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/prune-unused-takes`,
        body
      ),
    takeFromCut: (storyId, nodeId, body) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/nodes/${nodeId}/take-from-cut`,
        body
      ),
    pasteStoryLine: (storyId, targetParentId, body) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/nodes/${targetParentId}/paste-line`,
        body
      ),
    putBookmark: (storyId, nodeId, name, status) =>
      mutateStoryPayload(
        storyId,
        "PUT",
        `/api/stories/${storyId}/tags/${nodeId}`,
        { name, status } satisfies TagRequest
      ),
    deleteBookmark: (storyId, nodeId) => mutateStoryPayload(
      storyId,
      "DELETE",
      `/api/stories/${storyId}/tags/${nodeId}`
    ),
    createFact: (storyId, body) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/facts`,
      body
    ),
    patchFact: (storyId, factId, body) => mutateStoryPayload(
      storyId,
      "PATCH",
      `/api/stories/${storyId}/facts/${factId}`,
      body
    ),
    deleteFact: (storyId, factId) => mutateStoryPayload(
      storyId,
      "DELETE",
      `/api/stories/${storyId}/facts/${factId}`
    ),
    reorderFact: (storyId, factId, toIndex) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/facts/${factId}/reorder`,
      { toIndex } satisfies ReorderFactRequest
    ),
    createChapterBreak: async (storyId, parentPartId, title = "") => {
      const result = await request(
        "POST",
        `/api/stories/${storyId}/chapter-breaks`,
        decodeChapterBreakCreatedResponse,
        { parentPartId, title },
        HTTP_REQUEST_TIMEOUT_MS,
        await expectedVersion(storyId)
      );
      versions.rememberPayload(result.payload);
      return result;
    },
    renameChapterBreak: (storyId, breakId, title) =>
      mutateStoryPayload(
        storyId,
        "PATCH",
        breakId === null
          ? `/api/stories/${storyId}/chapter-breaks`
          : `/api/stories/${storyId}/chapter-breaks/${breakId}`,
        { title }
      ),
    removeChapterBreak: async (storyId, breakId) => {
      const preview = await request(
        "GET",
        `/api/stories/${storyId}/chapter-breaks/${breakId}/preview`,
        decodeChapterBreakRemovalPreview
      );
      const result = await request(
        "DELETE",
        breakId === null
          ? `/api/stories/${storyId}/chapter-breaks`
          : `/api/stories/${storyId}/chapter-breaks/${breakId}`,
        decodeChapterBreakRemovedResponse,
        { removedFingerprint: preview.removedFingerprint },
        HTTP_REQUEST_TIMEOUT_MS,
        preview.aggregateVersion
      );
      versions.rememberPayload(result.payload);
      return result;
    },
    restoreChapterBreak: (storyId, breakId, removed) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/chapter-breaks/${breakId}/restore`,
        removed
      ),
    summarizeChapter: (storyId, breakId, signal) =>
      runProviderMutation(storyId, () => mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/chapter-breaks/${breakId}/summarize`,
        {},
        HTTP_GENERATION_REQUEST_TIMEOUT_MS,
        signal
      )),
    editChapterSummary: async (storyId, summaryId, text, expected) =>
      mutateStoryPayload(
        storyId,
        "PATCH",
        `/api/stories/${storyId}/nodes/${summaryId}`,
        {
          text,
          expectedTextHash: await textHash(expected)
        }
      ),
    getSettings: () => request("GET", "/api/settings", decodeSettingsViewResponse),
    saveSettings: (command) => request(
      "PUT",
      "/api/settings",
      decodeSettingsMutationResult,
      command,
      HTTP_REQUEST_TIMEOUT_MS,
      undefined,
      undefined,
      command.mutationId
    ),
    discardPendingSettings: (command) =>
      request(
        "DELETE",
        "/api/settings/pending",
        decodeSettingsMutationResult,
        command,
        HTTP_REQUEST_TIMEOUT_MS,
        undefined,
        undefined,
        command.mutationId
      ),
    ...providerMethods({ request }),
    ...importMethods({ runAbsentImportMutation, request, versions, expectedVersion }),
    ...imageMethods({ request }),
    continueStory: async (storyId, instruction, genId, target, onDelta, signal, callbacks, images) => {
      const done = await stream(
        storyId,
        `/api/stories/${storyId}/continue`,
        {
          instruction,
          genId,
          ...target,
          // Absent rather than empty when there are no images, so a text-only
          // request body stays exactly what it was before image input existed.
          ...(images === undefined || images.length === 0 ? {} : { images })
        },
        onDelta,
        signal,
        callbacks
      );
      if (done === null) return null;
      const result = decodeContinueStoryResponse(done);
      versions.rememberPayload(result.payload);
      return result;
    },
    rewriteNode: async (storyId, nodeId, body, onDelta, signal, onCommitted, callbacks) => {
      const done = await stream(
        storyId,
        `/api/stories/${storyId}/nodes/${nodeId}/rewrite`,
        body,
        onDelta,
        signal,
        callbacks
      );
      if (done === null) return null;
      if (typeof done.nodeId !== "string") throw new Error("The server did not return the rewritten take.");
      // The take is durable this instant — tell the caller before the
      // confirming reload below, which can itself reject and otherwise
      // swallow the fact that the take already landed.
      onCommitted?.(done.nodeId);
      await loadVersionedStory(storyId);
      return done.nodeId;
    },
    commitPartialRewrite: async (storyId, nodeId, streamedDigest, attemptId) => {
      const intent = await mutationIntents.claim(
        "commitPartialRewrite",
        JSON.stringify({ storyId, nodeId, streamedDigest, attemptId })
      );
      try {
        const committed = await request(
          "POST",
          `/api/stories/${storyId}/nodes/${nodeId}/rewrite-partial`,
          decodeCommitPartialRewriteResponse,
          { streamedDigest, attemptId },
          HTTP_REQUEST_TIMEOUT_MS,
          await expectedVersion(storyId),
          undefined,
          intent.mutationId
        );
        await intent.complete();
        if (committed === null) return null;
        versions.rememberPayload(committed.payload);
        return committed;
      } catch (error) {
        return await settlePartialRewriteFailure(intent, error);
      }
    },
    createSummaryTake: async (storyId, body, onDelta, signal, callbacks) => {
      const done = await stream(
        storyId,
        `/api/stories/${storyId}/summary-take`,
        body,
        onDelta,
        signal,
        callbacks
      );
      if (done === null) return null;
      const result = decodeSummaryTakeResponse(done);
      await loadVersionedStory(storyId);
      return result;
    }
  };
}

/** The callers read `.facts` straight off this, so a bad shape fails here at
 * the boundary rather than at a `.filter` deep inside a panel. */

async function settleAbsentMutationFailure(
  intent: HttpMutationIntentClaim,
  error: unknown
): Promise<never> {
  try {
    if (intent.reused
      && (error instanceof ApiRecoveryRequiredError
        || (error instanceof ApiHttpError && !error.requestSent))) {
      await intent.retain();
    } else if (error instanceof ApiError) {
      await intent.complete();
    } else {
      await intent.retain();
    }
  } catch (settlementError) {
    throw new AggregateError(
      [error, settlementError],
      "HTTP mutation failure and intent settlement both failed",
      { cause: error }
    );
  }
  throw error;
}

async function settlePartialRewriteFailure(
  intent: HttpMutationIntentClaim,
  error: unknown
): Promise<never> {
  try {
    if (isRetryablePartialSettlementFailure(error)) await intent.retain();
    else await intent.complete();
  } catch (settlementError) {
    throw new AggregateError(
      [error, settlementError],
      "Partial-rewrite settlement failure and intent settlement both failed",
      { cause: error }
    );
  }
  throw error;
}

function isRetryablePartialSettlementFailure(error: unknown): boolean {
  if (error instanceof ApiRecoveryRequiredError) return true;
  if (error instanceof ApiHttpError) {
    // A terminal operation failure reaches us with requestSent=false because
    // the operation client owns the failed response. Its 4xx status still
    // proves this exact mutation reached a terminal domain outcome.
    return error.status >= 500;
  }
  // Transport and local durability failures have no terminal server outcome.
  // Keep the stable settlement identity so the next exact request can replay it.
  return !(error instanceof ApiError);
}

function summaryIsNewer(
  candidate: StorySummary,
  current: StorySummary
): boolean {
  const candidateVersion = candidate.aggregateVersion;
  const currentVersion = current.aggregateVersion;
  if (candidateVersion?.kind === "v6"
    && currentVersion?.kind === "v6") {
    return candidateVersion.revision > currentVersion.revision;
  }
  return candidateVersion?.kind === "v6"
    && currentVersion?.kind !== "v6";
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function streamSse(
  transport: HttpFetch,
  endpoint: string,
  payload: unknown,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  protocolHeaders: Readonly<Record<string, string>>,
  callbacks: StreamCallbacks = {}
): Promise<Record<string, unknown> | null> {
  const { onStopped, onReasoning, onReasoningStopped } = callbacks;
  let response: Response;
  const streamAbort = new AbortController();
  const transportSignal = AbortSignal.any([signal, streamAbort.signal]);
  try {
    response = await withSseIdleTimeout(transport(endpoint, {
      method: "POST",
      headers: { ...protocolHeaders, "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: transportSignal
    }), {
      onTimeout: (error) => streamAbort.abort(error)
    });
  } catch (error) {
    if (callerSignal.aborted) return null;
    if (signal.aborted) throw operationDeadlineError(signal.reason);
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!response.ok || response.body === null) {
    let errorPayload: unknown = null;
    if (response.body !== null) {
      try {
        errorPayload = parseJson(await readSseText(response.body));
      } catch (error) {
        streamAbort.abort(error);
        if (callerSignal.aborted) return null;
        if (signal.aborted) throw operationDeadlineError(signal.reason);
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    throw apiHttpErrorFromPayload(
      errorPayload,
      `Request failed (${response.status})`,
      response.status
    );
  }
  let completed: Record<string, unknown> | null = null;
  let terminalEvidence: "done" | "error" | null = null;
  let stoppedTail = "";
  let stoppedDelivered = false;
  const deliverStopped = () => {
    if (stoppedDelivered || stoppedTail.length === 0) return;
    stoppedDelivered = true;
    onStopped?.(stoppedTail);
  };
  // Reasoning gets its own withheld-tail accumulator and its own delivery,
  // so it can never be concatenated onto `stoppedTail` and read back as
  // story prose.
  let stoppedReasoningTail = "";
  let stoppedReasoningDelivered = false;
  const deliverReasoningStopped = () => {
    if (stoppedReasoningDelivered || stoppedReasoningTail.length === 0) return;
    stoppedReasoningDelivered = true;
    onReasoningStopped?.(stoppedReasoningTail);
  };
  try {
    await readSseEvents(response.body, (data) => {
      const event = JSON.parse(data) as {
        type: string;
        text?: string;
        tokenCount?: unknown;
        message?: string;
        code?: unknown;
        status?: unknown;
        diagnosticRef?: unknown;
      };
      if (event.type === "delta" && typeof event.text === "string") {
        if (callerSignal.aborted) stoppedTail += event.text;
        else onDelta(event.text);
      }
      if (
        event.type === "reasoning"
        && typeof event.text === "string"
        && typeof event.tokenCount === "number"
      ) {
        if (callerSignal.aborted) stoppedReasoningTail += event.text;
        else onReasoning?.({ text: event.text, tokenCount: event.tokenCount });
      }
      if (event.type === "error") {
        terminalEvidence = "error";
        throw apiHttpErrorFromPayload(
          event,
          "Generation failed.",
          event.status
        );
      }
      if (event.type === "done") {
        terminalEvidence = "done";
        completed = event as Record<string, unknown>;
      }
      return completed === null;
    });
  } catch (error) {
    streamAbort.abort(error);
    if (terminalEvidence === "error") throw error;
    if (callerSignal.aborted) {
      deliverStopped();
      deliverReasoningStopped();
      return null;
    }
    if (signal.aborted) throw operationDeadlineError(signal.reason);
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (completed === null && callerSignal.aborted) {
    deliverStopped();
    deliverReasoningStopped();
    return null;
  }
  if (completed === null && signal.aborted) throw operationDeadlineError(signal.reason);
  if (completed === null) {
    throw new Error("The stream ended before the part was saved.");
  }
  return completed;
}

function operationDeadlineError(reason: unknown): ApiHttpError {
  // The lease aborts with a typed TimeoutError only when its own deadline
  // fires (shared/http-operation-lease.ts). Every other abort reaching this
  // path — a shutdown, an unexpected transport teardown — keeps the same
  // public shape without the clean-timeout stamp.
  const cleanLeaseDeadline = reason instanceof DOMException
    && reason.name === "TimeoutError";
  return new ApiHttpError(createFailureEnvelope({
    code: "operation_expired",
    message:
      "Generation exceeded its operation deadline. Reload the story before retrying.",
    status: 408,
    ...(cleanLeaseDeadline ? { timeout: "operation-lease" } : {})
  }));
}
