import type { ReasoningDelta } from "./reasoning.js";
import type { RemovedChapterBreak } from "./api-response-decoders.js";
import type { SamplingBiasResolutionResult } from "../shared/sampling-capabilities.js";
import type { SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import type { LorebookImport } from "../shared/lorebook-entry.js";
import type { CardImportPlan } from "../shared/card-import.js";
import type { FactBudgetDrop } from "../shared/fact-budget.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../shared/generation-record.js";
import type { ReasoningRecord } from "../shared/reasoning.js";
import type {
  FactConsistencyInput,
  FactConsistencyCheckInput,
  FactConsistencyPlan,
  FactConsistencyCheckResult
} from "./fact-consistency-api.js";
import type {
  TagStatus,
  CreateFactsRequest,
  CreateNodeRequest,
  FactPatch,
  FactStateInput,
  FactStatePatch,
  ModelServerCheckResult,
  PasteStoryLineRequest,
  PruneUnusedTakesRequest,
  RewriteRequest,
  StoryNode,
  StoryMarkdownExport,
  StoryPayload,
  StorySummary,
  SwitchRequest,
  TakeFromCutRequest
} from "../shared/types.js";
import type {
  DiscardPendingSettingsCommand,
  ModelDiscoveryResultV2,
  SaveSettingsCommand,
  SettingsMutationResult,
  SettingsView
} from "../shared/settings-v2-types.js";
import type { ProviderProbeTarget } from "../shared/provider-probe-route-v1.js";
import type { ChatMessage } from "../shared/prompt-plan.js";
import type { PromptTokenCount } from "../shared/tokenize-source.js";
import type { ProviderRecoveryContext } from "../shared/provider-recovery.js";
import type { SearchRequest, SearchResponse } from "../shared/story-search.js";
import type {
  AsideAskRequest,
  AsideAskResponse,
  AsideRetakeRequest,
  AsideLegacyReadResponse,
  AsideReadRequest,
  AsideReadResponse,
  AsideSessionMutationResponse,
  AsideSessionTargetRequest,
  AsideTurnMutationRequest
} from "../shared/aside-transport.js";
import type {
  DraftImageReference,
  SourceImageMediaType,
  StoryImageAttachment
} from "../shared/image-attachment.js";

export type { RemovedChapterBreak } from "./api-response-decoders.js";
export {
  ApiError,
  ApiFailureError,
  ApiHttpError,
  ApiRecoveryRequiredError,
  apiErrorCode,
  explicitMutationUnsentFromCause,
  isExplicitMutationUnsent,
  markExplicitMutationUnsent
} from "./api-error.js";

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
  /**
   * Receives the refreshed story payload that follows a streamed mutation
   * whose terminal result does not carry one. Return false when the caller
   * could not adopt it; the facade then keeps its held version unchanged.
   */
  onPayload?: (payload: StoryPayload) => boolean | void;
}

/** Aside streams add a phase hint for the chat surface. Their signal stays
 * the final positional parameter. */
export interface AsideStreamCallbacks extends StreamCallbacks {
  onPhase?: (phase: "thinking" | "writing") => void;
}

/** `createSummaryTake`'s own callback bag. See `StreamCallbacks`'s doc for
 *  why `onStopped`/`onReasoningStopped` are missing here, not merely
 *  unused. */
export interface SummaryStreamCallbacks {
  /** Same shape as `onDelta`, on the reasoning channel. */
  onReasoning?: (delta: ReasoningDelta) => void;
  /** See `StreamCallbacks.onPayload`. */
  onPayload?: (payload: StoryPayload) => boolean | void;
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
  /** Read v2 sessions for an anchor. Optional so v1 embedders remain valid. */
  getAsideV2?(request: AsideReadRequest): Promise<AsideReadResponse | null>;
  /** Stream one Aside question. Null means cancelled before save. */
  askAside(
    storyId: string,
    question: string,
    onDelta: (text: string) => void,
    signal: AbortSignal
  ): Promise<AsideAskResult | null>;
  /** Stream one v2 session question. `signal` must remain last. */
  askAsideV2?(
    request: AsideAskRequest,
    onDelta: (text: string) => void,
    callbacks: AsideStreamCallbacks | undefined,
    signal: AbortSignal
  ): Promise<AsideAskResponse | null>;
  /** Delete one turn from a v2 session. */
  deleteAsideTurn?(request: AsideTurnMutationRequest): Promise<AsideSessionMutationResponse>;
  /** Keep the focused turn and all earlier turns. */
  resetAside?(request: AsideTurnMutationRequest): Promise<AsideSessionMutationResponse>;
  /** Clear the current v2 session only. */
  clearAsideSession?(request: AsideSessionTargetRequest): Promise<AsideSessionMutationResponse>;
  /** Stream a replacement for the selected session's last answer. */
  retakeAside?(
    request: AsideRetakeRequest,
    onDelta: (text: string) => void,
    callbacks: AsideStreamCallbacks | undefined,
    signal: AbortSignal
  ): Promise<AsideAskResponse | null>;
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
  /** Branch-scoped Fact State mutations. Optional for v1 embedders. */
  createFactState?(storyId: string, factId: string, body: FactStateInput): Promise<StoryPayload>;
  patchFactState?(storyId: string, factId: string, stateId: string, body: FactStatePatch): Promise<StoryPayload>;
  deleteFactState?(storyId: string, factId: string, stateId: string): Promise<StoryPayload>;
  /** Move a Fact to a new position among the story's Facts — array order is
   *  emit order, so this is the Facts surface's "arrange" control. */
  reorderFact(storyId: string, factId: string, toIndex: number): Promise<StoryPayload>;
  createChapterBreak(storyId: string, parentPartId: string, title?: string): Promise<{ payload: StoryPayload; breakId: string }>;
  /** A null break id names chapter one, which no break opens. */
  renameChapterBreak(storyId: string, breakId: string | null, title: string): Promise<StoryPayload>;
  /** Moves a break to a different seam. The break's summary, if it has one,
   *  follows it and reads stale until the chapter is summarized again. */
  moveChapterBreak(storyId: string, breakId: string, parentPartId: string): Promise<StoryPayload>;
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
  /** Fact consistency is optional for predecessor embedders. The live
   * adapters expose all three methods once the matching worker is present. */
  planFactConsistency?(input: FactConsistencyInput): Promise<FactConsistencyPlan>;
  checkFactConsistency?(input: FactConsistencyCheckInput): Promise<FactConsistencyCheckResult>;
  getFactConsistencyRun?(storyId: string): Promise<import("../shared/fact-consistency-contract.js").FactConsistencyRun | null>;

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

export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
