import { deriveChapters } from "../shared/chapters.js";
import {
  escapeStoryMarkdownProse,
  markdownChapterMarker,
  markdownDisplayTitle,
  markdownStoryTitleMarker,
  STORY_MARKDOWN_EXPORT_MARKER
} from "../shared/story-markdown-codec.js";
import { activePath } from "../shared/story-tree.js";
import type {
  SettingsMutationResult,
  SettingsView
} from "../shared/settings-v2-types.js";
import type {
  GenerationSettings,
  Story,
  StoryPayload,
  StorySummary
} from "../shared/types.js";
import type { FactBudgetDrop } from "../shared/fact-budget.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../shared/generation-record.js";
import type { ReasoningRecord } from "../shared/reasoning.js";
import type {
  SourceImageMediaType,
  StoryImageAttachment
} from "../shared/image-attachment.js";
import { stageStoryImage as stageDraftImage } from "./story-image-stage.js";
import type {
  ProviderRecoveryContext
} from "../shared/provider-recovery.js";
import type { ChatMessage, PromptRole } from "../shared/prompt-plan.js";
import type { PromptTokenCount } from "../shared/tokenize-source.js";
import {
  SEARCH_HIT_LIMIT,
  searchCorpus,
  searchQueryIsRunnable,
  type SearchCorpus,
  type SearchHit,
  type SearchResponse
} from "../shared/story-search.js";
import { StorySearchIndex } from "./story-search-index.js";
import { parseSearchRequest } from "./service-input.js";
import type { PasteStoryLineIds } from "./story-nodes.js";
import {
  isServiceOwnedSettingsMutation,
  type LocalDurabilityMutationMethod,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import { runLocalTierMutation } from "./mutation-local-tier.js";
import { providerRecoveryFromArchive } from "./mutation-outbox.js";
import type { RemovedChapterBreak } from "./chapter-breaks.js";
import { probeContextWindow } from "./context-probe.js";
import { countPromptTokens } from "./tokenize-probe.js";
import { ServiceError } from "./errors.js";
import { requireRecord, requireStringValue } from "./validation.js";
import type { DeltaConsumer } from "./generation-stream.js";
import type {
  AsideAskInput,
  AsideRetakeInput,
  AsideSessionMutationInput
} from "../shared/aside-transport.js";
import {
  MAX_IMPORT_BYTES,
  storyFromImport,
  type GenericImport
} from "./import-model.js";
import { partsFromSillyTavernJsonl } from "./import-st.js";
import { partsFromMarkdown } from "./import-md.js";
import { partsFromNovelAiStory, type NovelAiContainerImport } from "./import-nai.js";
import { partsFromNovelAiScenario } from "./import-scenario.js";
import { createFacts } from "./story-facts.js";
import { setAuthorsNote } from "./story-authors-note.js";

import { factsFromArchive } from "../shared/archive-import.js";
import { parseLorebookArchive } from "../shared/novelai-lorebook.js";
import type { LorebookImport } from "../shared/lorebook-entry.js";
import { planCardImport, type CardImportPlan } from "../shared/card-import.js";
import { MAX_FACTS, MAX_JSON_BODY_BYTES } from "../shared/types.js";

import type { CreationMethod } from "./story-creation-record.js";
import { checkModelServer } from "./server-check.js";
import { discoverProviderModels } from "./model-discovery.js";
import {
  normalizeStorySamplingBias,
  parseResolveSamplingBiasInput,
  resolveSamplingBiasForSettings
} from "./sampling-phrase-bias.js";
import type { SamplingBiasResolutionResult } from "../shared/sampling-capabilities.js";
import type { SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import { seedStarterVault } from "./starter-vault.js";
import { buildStoryPayload } from "./story-payload.js";
import type {
  ImportPlanCustody,
  MutationPlan,
  MutationPreflightPlan
} from "./mutation-plan.js";
import type { MutatingWorkerMethod } from "../shared/worker-protocol.js";
import type { StoryCatalogPage } from "../shared/story-catalog.js";
import type { GenerationMutationHooks } from "./story-service-generation.js";
import type { SummaryPoint } from "./summary-take.js";
import {
  StoryServiceRuntime,
  type StoryServiceUndiagnosedOptions
} from "./story-service-runtime.js";
import { mintStoryMutationRequest } from "./story-mutation-request.js";

export type { GenerationMutationHooks } from "./story-service-generation.js";
export type { StoryServiceOptions } from "./story-service-runtime.js";

type ImportCreationMethod = Exclude<CreationMethod, "createStory">;
type ImportStoryIds = NonNullable<Parameters<typeof storyFromImport>[1]>;

/** Canonical application boundary shared by HTTP and the embedded worker. */
export class StoryService extends StoryServiceRuntime {
  /** Explicit opt-out for isolated maintenance and test runtimes. */
  static withoutDiagnostics(
    options: StoryServiceUndiagnosedOptions = {}
  ): StoryService {
    return new StoryService({
      ...options,
      diagnostics: "disabled"
    });
  }

  /** In flight or settled once seeding has been attempted for this service. */
  private starterVaultWrite: Promise<void> | null = null;


  /**
   * Seeding runs after the lifecycle reports ready, because every authoring
   * command asserts an open service. That puts it outside the lifecycle's
   * once-only guard, so it carries its own: a repeat or concurrent init()
   * awaits the same write instead of replaying the vault onto a seam that
   * already has a chapter break.
   *
   * A first run interrupted mid-vault leaves a partial one — the directory now
   * exists, so the next launch skips seeding. That is accepted. Recording
   * durable seed state would add a file to a directory whose contents are
   * governed by the admission and migration rules, and being wrong there costs
   * far more than half a tutorial nobody has read yet.
   */
  override async init(): Promise<void> {
    await super.init();
    if (!this.shouldSeedStarterVault) return;
    this.starterVaultWrite ??= seedStarterVault(this);
    try {
      await this.starterVaultWrite;
    } catch (error) {
      // The directory was created moments ago by this process, so a failure
      // here means storage is unusable rather than merely unseeded. Release the
      // lock instead of leaving a half-open service behind.
      await this.dispose();
      throw error;
    }
  }

  async inspectMutationReceipt(
    mutationId: string,
    method?: WorkerMethod
  ) {
    this.ensureOpen();
    if (method !== undefined && isServiceOwnedSettingsMutation(method)) {
      return await this.settings.inspectMutationReceipt(mutationId);
    }
    return await this.mutationReceipts.inspect(mutationId);
  }

  async runMutation<M extends MutatingWorkerMethod, T>(
    mutationId: string,
    method: M,
    input: unknown,
    work: (plan: MutationPlan<M>) => Promise<T>,
    inputProtocolVersion: number | undefined,
    preflight: (plan: MutationPreflightPlan<M>) => void | Promise<void>
  ): Promise<T> {
    this.ensureOpen();
    return await this.mutationReceipts.run(mutationId, method, input, work, inputProtocolVersion, preflight);
  }

  /**
   * Local durability tier: no receipt wraps the work. The caller must be a
   * single-process transport with no retry source for this mutation ID; the
   * story transaction inside commits through one atomic manifest publish.
   */
  async runLocalMutation<M extends LocalDurabilityMutationMethod, T>(
    mutationId: string,
    method: M,
    work: (plan: MutationPlan<M>) => Promise<T>
  ): Promise<T> {
    this.ensureOpen();
    return await runLocalTierMutation(mutationId, method, work);
  }

  async listStories(): Promise<StorySummary[]> {
    this.ensureOpen();
    return await this.stories.list();
  }

  async listStoriesPage(input: unknown): Promise<StoryCatalogPage> {
    this.ensureOpen();
    return await this.storyCatalog.listPage(input);
  }

  /**
   * Substring search over every take in the tree, or over every story in the
   * vault. Prose, the prompt that made each part, and the facts are all in the
   * corpus; the caller tells them apart by `SearchHit.kind`.
   *
   * The open story is scanned first so its hits survive the cap when a vault
   * query matches more than the limit.
   */
  async searchStories(input: unknown, signal?: AbortSignal): Promise<SearchResponse> {
    this.ensureOpen();
    return await this.storySearch.searchStories(input, signal);
  }

  async createStory(
    title?: string,
    storyId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.ensureOpen();
    if (mutationRequest !== undefined) {
      const committed = await this.storyCreations.run(
        mutationRequest,
        "createStory",
        (deterministicId) => {
          const now = new Date().toISOString();
          return {
            id: deterministicId,
            title: title?.trim() || "Untitled",
            createdAt: now,
            updatedAt: now,
            nodes: [],
            activeRootId: null,
            tags: [],
            recentNodeIds: [],
            facts: [],
            chapterBreaks: []
          };
        }
      );
      return buildStoryPayload(committed.story, {
        kind: "v6",
        revision: committed.result.storyRevision
      });
    }
    return buildStoryPayload(await this.stories.create(
      title?.trim() || "Untitled",
      storyId
    ));
  }

  async loadStory(id: string): Promise<StoryPayload> {
    this.ensureOpen();
    await this.storyCreations.recoverResidue(id);
    await this.storyReaper.recoverResidue(id);
    const loaded = await this.stories.loadVersioned(id);
    return buildStoryPayload(
      loaded.story,
      loaded.aggregateVersion ?? undefined
    );
  }

  /** One take's stored token probabilities. Throws a 404 — distinguishably by
   *  message — when the story, the take, or the take's stored record is
   *  missing. */
  async getTokenProbabilities(id: string, nodeId: string): Promise<TokenProbabilityRecord> {
    this.ensureOpen();
    return await this.stories.loadTokenProbabilities(id, nodeId);
  }

  /** Every Generation Record event on one take, oldest first, projected to
   *  what a history list needs — see StoryStore.loadGenerationRecordSummaries. */
  async getGenerationRecords(
    id: string,
    nodeId: string,
    signal?: AbortSignal
  ): Promise<GenerationRecordSummary[]> {
    this.ensureOpen();
    return await this.stories.loadGenerationRecordSummaries(id, nodeId, signal);
  }

  /** One take's one Generation Record, fetched on demand. Throws a 404 —
   *  distinguishably by message — when the story, the take, or the take's
   *  matching record is missing. */
  async getGenerationRecord(
    id: string,
    nodeId: string,
    recordId: string,
    signal?: AbortSignal
  ): Promise<ResolvedGenerationRecord> {
    this.ensureOpen();
    return await this.stories.loadGenerationRecord(id, nodeId, recordId, signal);
  }

  /** One take's stored thought. Throws a 404 — distinguishably by message —
   *  when the story, the take, or the take's stored thought is missing. */
  async getReasoning(id: string, nodeId: string): Promise<ReasoningRecord> {
    this.ensureOpen();
    return await this.stories.loadReasoning(id, nodeId);
  }

  /** Complete bounded Aside document. Empty when none exists. */
  async getAside(id: string): Promise<import("./aside-http.js").AsideDocumentView> {
    return await this.storyGeneration.getAside(id);
  }

  async getAsideV2(
    id: string,
    anchor?: import("../shared/aside-session.js").AsideAnchor | null
  ): Promise<import("../shared/aside-transport.js").AsideReadResponse> {
    return await this.storyGeneration.getAsideV2(id, anchor);
  }

  async askAside(
    id: string,
    body: Record<string, unknown>,
    onDelta: import("./generation-stream.js").DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<import("./aside-http.js").AsideDocumentView | null> {
    return await this.storyGeneration.askAside(id, body, onDelta, signal, hooks);
  }

  async askAsideV2(
    id: string,
    body: AsideAskInput,
    onDelta: import("./generation-stream.js").DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<import("../shared/aside-transport.js").AsideAskResponse | null> {
    return await this.storyGeneration.askAsideV2(id, body, onDelta, signal, hooks);
  }

  async asideSessionMutation(
    id: string,
    body: AsideSessionMutationInput,
    mutationRequest?: unknown
  ): Promise<import("../shared/aside-transport.js").AsideSessionMutationResponse> {
    return await this.storyGeneration.asideSessionMutation(id, body, mutationRequest);
  }

  async retakeAside(
    id: string,
    body: AsideRetakeInput,
    onDelta: import("./generation-stream.js").DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<import("../shared/aside-transport.js").AsideAskResponse | null> {
    return await this.storyGeneration.retakeAside(id, body, onDelta, signal, hooks);
  }

  async clearAside(id: string, mutationRequest?: unknown): Promise<StoryPayload> {
    return await this.storyLocal.clearAside(id, mutationRequest);
  }

  /** Stage one Source Image as a Draft Image: normalize it, store the
   *  result as a content-addressed Image Object, and publish a Draft Lease.
   *  Not a story mutation. The caller must already hold the process-wide
   *  image stage permit (server/image-stage-permit.ts). */
  async stageStoryImage(
    id: string,
    mediaType: SourceImageMediaType,
    bytes: Uint8Array
  ): Promise<{ leaseId: string; attachment: StoryImageAttachment }> {
    this.ensureOpen();
    return await stageDraftImage(this.stories, id, mediaType, bytes);
  }

  /** Idempotently remove one Draft Lease. Releasing an absent or already
   *  expired lease succeeds with no error. Not a story mutation. The caller
   *  must already hold the process-wide image stage permit. */
  async releaseStoryImage(id: string, leaseId: string): Promise<void> {
    this.ensureOpen();
    await this.stories.releaseImage(id, leaseId);
  }

  async renameStory(
    id: string,
    title: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.renameStory(id, title, mutationRequest);
  }

  async setAuthorsNote(
    id: string,
    note: string,
    depth?: number,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.setAuthorsNote(id, note, depth, mutationRequest);
  }

  async setAuthorBrief(
    id: string,
    brief: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.setAuthorBrief(id, brief, mutationRequest);
  }

  async setFactsBudget(
    id: string,
    budgetTokens: number | null,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.setFactsBudget(id, budgetTokens, mutationRequest);
  }

  async setPhraseBias(
    id: string,
    phraseBias: readonly SamplingPhraseBiasEntryV2[],
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.setPhraseBias(id, phraseBias, mutationRequest);
  }

  async setBannedStrings(
    id: string,
    bannedStrings: readonly string[],
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.setBannedStrings(id, bannedStrings, mutationRequest);
  }

  async autonameStory(
    id: string,
    signal: AbortSignal,
    options: GenerationMutationHooks & { autonameId?: string; expectedTitle?: string } = {}
  ): Promise<StoryPayload> {
    return await this.storyGeneration.autonameStory(id, signal, options);
  }

  async acknowledgeUnknownOutcomes(
    storyId: string,
    warningMutationId: string,
    mutationRequest: unknown,
    providerRecovery?: ProviderRecoveryContext
  ): Promise<StoryPayload | null> {
    this.ensureOpen();
    const archived = this.archivedProviderWarning(
      warningMutationId,
      storyId
    );
    const recovery = providerRecovery
      ?? (archived === undefined
        ? undefined
        : providerRecoveryFromArchive(archived));
    const committed = await this.storyMutations.runAcknowledge(
      mutationRequest,
      warningMutationId,
      recovery
    ).catch(async (error: unknown) => {
      await this.reportProviderRecoveryFailure(
        storyId,
        warningMutationId
      ).catch(() => undefined);
      throw error;
    });
    await this.dismissArchivedMutationWarning(
      warningMutationId,
      storyId
    );
    return committed.story === null
      ? null
      : buildStoryPayload(committed.story, {
        kind: "v6",
        revision: committed.result.storyRevision
      });
  }

  async getUnknownOutcomeStatus(
    storyId: string,
    warningMutationId: string,
    providerRecovery?: ProviderRecoveryContext
  ) {
    this.ensureOpen();
    const warning = this.archivedProviderWarning(
      warningMutationId,
      storyId
    );
    const status = await this.storyMutations.getUnknownOutcomeStatus(
      storyId,
      warningMutationId,
      providerRecovery
        ?? (warning === undefined
          ? undefined
          : providerRecoveryFromArchive(warning))
    );
    if (status.state === "pending") {
      const { pendingProviderMutationId, ...publicStatus } = status;
      if (pendingProviderMutationId !== warningMutationId) {
        await this.reportProviderFenceRedirect(
          storyId,
          warningMutationId,
          pendingProviderMutationId
        ).catch(() => undefined);
      }
      return publicStatus;
    }
    await this.dismissArchivedMutationWarning(
      warningMutationId,
      storyId
    );
    return status;
  }

  async deleteStory(id: string, mutationRequest?: unknown): Promise<{ ok: true }> {
    this.ensureOpen();
    try {
      if (mutationRequest !== undefined) {
        await this.storyMutations.runDelete(mutationRequest);
      } else {
        // Bare remove only serves legacy and V5 bundles. After askAside (or any
        // other aggregate commit) the story is on a successor envelope, so the
        // durable delete path must publish the tombstone.
        const { aggregateVersion } = await this.stories.loadVersioned(id);
        if (aggregateVersion === null || aggregateVersion.kind === "v5") {
          await this.stories.withLock(id, () => this.stories.remove(id));
        } else {
          await this.storyMutations.runDelete(
            await mintStoryMutationRequest(this.stories, id, "deleteStory")
          );
        }
      }
      return { ok: true };
    } finally {
      // Both paths can make the story unreadable and then fail — a tombstone
      // published before terminal evidence, a rename before its durability
      // barrier. Forgetting on the way out either way costs one rebuild if the
      // delete did not happen, and stops deleted prose being searchable if it
      // did.
      this.storySearch.forget(id);
    }
  }

  async exportMarkdown(id: string): Promise<string> {
    return (await this.exportStory(id)).markdown;
  }

  /**
   * Write the currently selected story line as one markdown file, with
   * chapters as `##` headings. It is a hand-off artifact — no anchors, no state,
   * and nothing here is ever read back.
   */
  async exportStory(id: string): Promise<{
    filename: string;
    markdown: string;
    /** Exact omission notices for content the export does not carry. */
    fidelity: readonly string[];
  }> {
    this.ensureOpen();
    const story = await this.stories.load(id);
    const hasAsideSessions = (story.asideSessionRefs?.length ?? 0) > 0
      || (story.asideUnanchoredSessionRefs?.length ?? 0) > 0;
    const fidelity = (story.asideDocumentId !== undefined && story.asideDocumentId !== null)
      || hasAsideSessions
      ? ["Side Notes were not exported."] as const
      : [];
    const comment = (value: string) => value
      .replace(/\r\n?|\n/g, " ")
      .replace(/--!?>/g, "→");
    const header = story.origin === undefined ? "" :
      `<!-- derived from "${comment(story.origin.storyTitle)}" (story ${story.origin.storyId}, node ${story.origin.partId}${story.origin.offset === null ? "" : ` @ ${story.origin.offset}`}) -->\n\n`;
    const displayStoryTitle = markdownDisplayTitle(story.title, "Untitled story");
    const exactStoryTitle = markdownStoryTitleMarker(story.title, displayStoryTitle);
    const chapters = deriveChapters(
      activePath(story),
      story.chapterBreaks,
      story.nodes,
      story.firstChapterTitle ?? ""
    );
    const sections = chapters.map((chapter) => {
      const prose = chapter.parts
        .map((part) => escapeStoryMarkdownProse(part.text))
        .join("\n\n");
      // The document title already names the opening chapter when nothing
      // renamed it, so an untitled first chapter gets no heading of its own.
      if (chapter.number === 1 && chapter.title === "") return prose;
      const displayTitle = markdownDisplayTitle(chapter.title, `Chapter ${chapter.number}`);
      return `${markdownChapterMarker(chapter.title, displayTitle)}\n\n## ${displayTitle}\n\n${prose}`;
    });
    // Deliberately narrower than the on-disk name (`exportFileBase`): this one
    // goes into a Content-Disposition quoted-string, so it stays ASCII and
    // punctuation-free rather than needing RFC 5987 encoding.
    const filename = `${story.title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "story"}.md`;
    return {
      filename,
      markdown: [
        `# ${displayStoryTitle}`,
        STORY_MARKDOWN_EXPORT_MARKER,
        ...(exactStoryTitle === null ? [] : [exactStoryTitle]),
        ...(header.length === 0 ? [] : [header.trimEnd()]),
        sections.join("\n\n")
      ].join("\n\n") + "\n",
      fidelity
    };
  }

  async switchLine(
    id: string,
    nodeId: string,
    value: unknown = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.switchLine(id, nodeId, value, mutationRequest);
  }

  async createNode(
    id: string,
    value: unknown,
    nodeId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.createNode(
      id,
      value,
      nodeId,
      mutationRequest
    );
  }

  async editNode(
    id: string,
    nodeId: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.editNode(id, nodeId, value, mutationRequest);
  }

  async commitPartialRewrite(
    id: string,
    nodeId: string,
    value: unknown,
    mutationRequest?: unknown,
    settleTakeId?: string
  ): Promise<{ payload: StoryPayload; nodeId: string } | null> {
    return await this.storyLocal.commitPartialRewrite(
      id,
      nodeId,
      value,
      mutationRequest,
      settleTakeId
    );
  }

  async deleteNode(
    id: string,
    nodeId: string,
    expectedSubtreeCount: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.deleteNode(
      id,
      nodeId,
      expectedSubtreeCount,
      mutationRequest
    );
  }

  async pruneUnusedTakes(
    id: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.pruneUnusedTakes(id, value, mutationRequest);
  }

  async takeFromCut(
    id: string,
    nodeId: string,
    value: unknown,
    takeId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.takeFromCut(
      id,
      nodeId,
      value,
      takeId,
      mutationRequest
    );
  }

  async pasteStoryLine(
    id: string,
    targetParentId: string,
    value: unknown,
    ids?: PasteStoryLineIds,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.pasteStoryLine(
      id,
      targetParentId,
      value,
      ids,
      mutationRequest
    );
  }

  async putBookmark(
    id: string,
    nodeId: string,
    name: string,
    label: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.putBookmark(
      id,
      nodeId,
      name,
      label,
      mutationRequest
    );
  }

  async deleteBookmark(
    id: string,
    nodeId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.deleteBookmark(id, nodeId, mutationRequest);
  }

  async createFact(
    id: string,
    body: unknown,
    factId?: (index: number) => string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.createFact(
      id,
      body,
      factId,
      mutationRequest
    );
  }

  async patchFact(
    id: string,
    factId: string,
    body: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.patchFact(id, factId, body, mutationRequest);
  }

  async createFactState(
    id: string,
    factId: string,
    body: unknown,
    stateId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.createFactState(id, factId, body, stateId, mutationRequest);
  }

  async patchFactState(
    id: string,
    factId: string,
    stateId: string,
    body: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.patchFactState(id, factId, stateId, body, mutationRequest);
  }

  async deleteFactState(
    id: string,
    factId: string,
    stateId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.deleteFactState(id, factId, stateId, mutationRequest);
  }

  async deleteFact(
    id: string,
    factId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.deleteFact(id, factId, mutationRequest);
  }

  async reorderFact(
    id: string,
    factId: string,
    body: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.reorderFact(id, factId, body, mutationRequest);
  }

  async getSettings(): Promise<SettingsView> {
    this.ensureOpen();
    return await this.settings.loadView();
  }

  async saveSettings(value: unknown, signal?: AbortSignal): Promise<SettingsMutationResult> {
    this.ensureOpen();
    return await this.settings.save(value, signal);
  }

  async discardPendingSettings(value: unknown): Promise<SettingsMutationResult> {
    this.ensureOpen();
    return await this.settings.discardPending(value);
  }

  async checkModelServer(value: unknown, signal?: AbortSignal) {
    this.ensureOpen();
    const settings = await this.settings.resolveProviderProbe(value);
    return await checkModelServer(settings, undefined, { signal });
  }

  async probeContextWindow(
    value: unknown,
    signal?: AbortSignal
  ): Promise<{ contextWindow: number | null }> {
    this.ensureOpen();
    const settings = await this.settings.resolveProviderProbe(value);
    return { contextWindow: await probeContextWindow(settings, signal) };
  }

  async discoverModels(value: unknown, signal?: AbortSignal) {
    this.ensureOpen();
    const settings = await this.settings.resolveProviderProbe(value);
    return await discoverProviderModels(settings, undefined, signal);
  }

  async resolveSamplingBias(
    value: unknown,
    signal?: AbortSignal
  ): Promise<SamplingBiasResolutionResult> {
    this.ensureOpen();
    const record = requireRecord(value, "resolveSamplingBias input");
    const settings = await this.settings.resolveProviderProbe(record.settings);
    const input = parseResolveSamplingBiasInput(record);
    return await resolveSamplingBiasForSettings(input, settings, {
      signal,
      storySampling: normalizeStorySamplingBias(input.storyPhraseBias, input.storyBannedStrings)
    });
  }

  /** No settings and no story id: this always counts against the backend's
   * own effective prose route, unlike a probe against an arbitrary target. */
  async countPromptTokens(
    value: unknown,
    signal?: AbortSignal
  ): Promise<PromptTokenCount> {
    this.ensureOpen();
    const messages = requireChatMessages(value);
    const { settings } = await this.settings.loadGeneration("prose");
    return await countPromptTokens(settings, messages, signal);
  }

  private async persistImportedStory(
    imported: GenericImport,
    method: ImportCreationMethod,
    ids: ImportStoryIds,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    if (mutationRequest !== undefined) {
      const committed = await this.storyCreations.run(
        mutationRequest,
        method,
        (deterministicId) => storyFromImport(imported, {
          ...ids,
          storyId: deterministicId
        })
      );
      return buildStoryPayload(committed.story, {
        kind: "v6",
        revision: committed.result.storyRevision
      });
    }
    const story = storyFromImport(imported, ids);
    await this.stories.save(story);
    return buildStoryPayload(story);
  }

  private async persistImportedContainerStory(
    container: NovelAiContainerImport,
    method: ImportCreationMethod,
    ids: ImportStoryIds,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    if (mutationRequest !== undefined) {
      const committed = await this.storyCreations.run(
        mutationRequest,
        method,
        (deterministicId) => storyFromContainerImport(container, {
          ...ids,
          storyId: deterministicId
        })
      );
      return buildStoryPayload(committed.story, {
        kind: "v6",
        revision: committed.result.storyRevision
      });
    }
    const story = storyFromContainerImport(container, ids);
    await this.stories.save(story);
    return buildStoryPayload(story);
  }

  async importSillyTavern(
    jsonl: string,
    ids: { storyId?: string; nodeId?: (index: number) => string } = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return (await this.importSillyTavernWithReport(
      jsonl,
      ids,
      mutationRequest
    )).payload;
  }

  async importSillyTavernWithReport(
    jsonl: string,
    ids: { storyId?: string; nodeId?: (index: number) => string } = {},
    mutationRequest?: unknown
  ): Promise<{
    payload: StoryPayload;
    addedGroupChatSpeakerPrefixes: number;
    droppedTrailingUserMessages: number;
    omittedAlternateSwipes: number;
  }> {
    this.ensureOpen();
    if (Buffer.byteLength(jsonl) > MAX_IMPORT_BYTES) throw new ServiceError(413, "Request body too large");
    const imported = partsFromSillyTavernJsonl(jsonl);
    return {
      payload: await this.persistImportedStory(
        imported,
        "importSillyTavern",
        ids,
        mutationRequest
      ),
      addedGroupChatSpeakerPrefixes: imported.addedGroupChatSpeakerPrefixes,
      droppedTrailingUserMessages: imported.droppedTrailingUserMessages,
      omittedAlternateSwipes: imported.omittedAlternateSwipes
    };
  }

  async importMarkdown(
    markdown: string,
    options: {
      defaultTitle?: string;
      storyId?: string;
      nodeId?: (index: number) => string;
      chapterBreakId?: (index: number) => string;
    } = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return (await this.importMarkdownWithReport(
      markdown,
      options,
      mutationRequest
    )).payload;
  }

  async importMarkdownWithReport(
    markdown: string,
    options: {
      defaultTitle?: string;
      storyId?: string;
      nodeId?: (index: number) => string;
      chapterBreakId?: (index: number) => string;
    } = {},
    mutationRequest?: unknown
  ): Promise<{ payload: StoryPayload }> {
    this.ensureOpen();
    if (Buffer.byteLength(markdown) > MAX_IMPORT_BYTES) throw new ServiceError(413, "Request body too large");
    const imported = partsFromMarkdown(markdown, options.defaultTitle);
    return {
      payload: await this.persistImportedStory(
        imported,
        "importMarkdown",
        options,
        mutationRequest
      )
    };
  }

  async importNovelAI(
    storyContainerJson: string,
    options: {
      storyId?: string;
      nodeId?: (index: number) => string;
    } = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return (await this.importNovelAIWithReport(
      storyContainerJson,
      options,
      mutationRequest
    )).payload;
  }

  async importNovelAIWithReport(
    storyContainerJson: string,
    options: {
      storyId?: string;
      nodeId?: (index: number) => string;
    } = {},
    mutationRequest?: unknown
  ): Promise<{ payload: StoryPayload; fidelity: readonly string[] }> {
    this.ensureOpen();
    if (Buffer.byteLength(storyContainerJson) > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    const container = partsFromNovelAiStory(storyContainerJson);
    return {
      payload: await this.persistImportedContainerStory(
        container,
        "importNovelAI",
        options,
        mutationRequest
      ),
      fidelity: container.fidelity
    };
  }

  async importScenario(
    jsonText: string,
    options: {
      storyId?: string;
      nodeId?: (index: number) => string;
    } = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return (await this.importScenarioWithReport(
      jsonText,
      options,
      mutationRequest
    )).payload;
  }

  async importScenarioWithReport(
    jsonText: string,
    options: {
      storyId?: string;
      nodeId?: (index: number) => string;
    } = {},
    mutationRequest?: unknown
  ): Promise<{ payload: StoryPayload; fidelity: readonly string[] }> {
    this.ensureOpen();
    if (Buffer.byteLength(jsonText) > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    const container = partsFromNovelAiScenario(jsonText);
    return {
      payload: await this.persistImportedContainerStory(
        container,
        "importScenario",
        options,
        mutationRequest
      ),
      fidelity: container.fidelity
    };
  }

  async importLorebook(
    storyId: string,
    archiveBytes: Uint8Array,
    mutationRequest?: unknown,
    custody?: ImportPlanCustody<LorebookImport>
  ): Promise<{ payload: StoryPayload; importResult: LorebookImport }> {
    this.ensureOpen();
    if (archiveBytes.byteLength > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    // The plan is computed inside the canonical mutation callback, from the
    // story that callback mutates, because the room is what a post-commit
    // retry would otherwise get wrong: the retried load already holds the
    // imported Facts and would report a smaller import than the one that
    // happened (old-repo #321). The custody preserves the computed plan
    // before the transaction can commit, and answers it back when the ledger
    // resolves a retry without running the callback.
    //
    // `parseLorebookArchive` and `factsFromArchive` live in `shared/`, so they
    // throw an ordinary `Error` for malformed JSON, an unreadable PNG, an
    // entry-shape refusal, or an oversized archive — they have no server-side
    // status code to reach for. This is the service boundary that gives that
    // failure a public 4xx instead of the 500 an unclassified `Error` gets.
    // This path sends the Facts as one createFact body, so the body budget
    // applies here. A container import builds the story in process and does not
    // pass one.
    //
    // An archive can hold nothing this story can take: no entries, every entry
    // disabled, or every entry refused. That is a report, not a failure, and
    // `createFacts` already answers `false` (-> STORY_UNCHANGED) for a request
    // that asks for what already holds. An empty batch is the degenerate member
    // of that family, so this call needs no branch of its own.
    const { payload, report } = await this.storyLocal.createPlannedFacts(
      storyId,
      mutationRequest,
      {
        planned: preservedImportPlan(custody, (story) => importValidation(() => {
          const lorebook = parseLorebookArchive(archiveBytes);
          return factsFromArchive(
            lorebook,
            MAX_FACTS - story.facts.length,
            MAX_JSON_BODY_BYTES
          );
        })),
        body: (importResult) => ({ facts: [...importResult.facts] }),
        replay: () => custody?.stored() ?? null
      }
    );
    return { payload, importResult: report };
  }

  async importCard(
    storyId: string,
    cardBytes: Uint8Array,
    mutationRequest?: unknown,
    custody?: ImportPlanCustody<CardImportPlan>
  ): Promise<{ payload: StoryPayload; plan: CardImportPlan }> {
    this.ensureOpen();
    if (cardBytes.byteLength > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    // The same planned-inside-the-callback shape as `importLorebook` above,
    // for the same retry-fidelity reason: the plan is bounded by the room the
    // mutation itself reads — the Character Facts and the character_book
    // Facts alike — and the custody keeps that plan durable for replays.
    //
    // `planCardImport` lives in `shared/`, so it throws an ordinary `Error`
    // for malformed JSON, an unsupported spec version, an unsupported
    // container, an entry-count ceiling, or oversized text — the same
    // boundary translation `importLorebook` above applies to its own parser.
    //
    // A card can hold nothing this story can take: no room left for even one
    // Fact. That is a report, not a failure, and `createFacts` already
    // answers `false` (-> STORY_UNCHANGED) for a request that asks for what
    // already holds.
    const { payload, report } = await this.storyLocal.createPlannedFacts(
      storyId,
      mutationRequest,
      {
        planned: preservedImportPlan(custody, (story) => importValidation(
          () => planCardImport(cardBytes, MAX_FACTS - story.facts.length)
        )),
        body: (plan) => ({ facts: [...plan.facts] }),
        replay: () => custody?.stored() ?? null
      }
    );
    return { payload, plan: report };
  }

  async continueStory(
    id: string,
    body: Record<string, unknown>,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<{ payload: StoryPayload; droppedFacts: readonly FactBudgetDrop[] } | null> {
    return await this.storyGeneration.continueStory(
      id,
      body,
      onDelta,
      signal,
      hooks
    );
  }

  async rewriteNode(
    id: string,
    nodeId: string,
    value: unknown,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    options: GenerationMutationHooks & { rewriteId?: string; takeId?: string } = {}
  ): Promise<string | null> {
    return await this.storyGeneration.rewriteNode(
      id,
      nodeId,
      value,
      onDelta,
      signal,
      options
    );
  }

  async createSummaryTake(
    id: string,
    value: unknown,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    options: GenerationMutationHooks & { summaryNodeId?: string; cutNodeId?: string } = {}
  ): Promise<{ nodeId: string; narrowedTo: SummaryPoint | null } | null> {
    return await this.storyGeneration.createSummaryTake(
      id,
      value,
      onDelta,
      signal,
      options
    );
  }

  async createChapterBreak(
    id: string,
    parentPartId: string,
    title: string,
    chapterBreakId?: string,
    mutationRequest?: unknown
  ): Promise<{ payload: StoryPayload; breakId: string }> {
    return await this.storyChapters.createChapterBreak(
      id,
      parentPartId,
      title,
      chapterBreakId,
      mutationRequest
    );
  }

  async previewChapterBreakRemoval(id: string, breakId: string) {
    return await this.storyChapters.previewChapterBreakRemoval(id, breakId);
  }

  async renameChapterBreak(
    id: string,
    breakId: string | null,
    title: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyChapters.renameChapterBreak(
      id,
      breakId,
      title,
      mutationRequest
    );
  }

  async deleteChapterBreak(
    id: string,
    breakId: string,
    mutationRequest?: unknown,
    expectedRemoved?: RemovedChapterBreak
  ): Promise<{ payload: StoryPayload; removed: RemovedChapterBreak }> {
    return await this.storyChapters.deleteChapterBreak(
      id,
      breakId,
      mutationRequest,
      expectedRemoved
    );
  }

  async restoreChapterBreak(
    id: string,
    breakId: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyChapters.restoreChapterBreak(
      id,
      breakId,
      value,
      mutationRequest
    );
  }

  async summarizeChapter(
    id: string,
    breakId: string,
    signal: AbortSignal,
    options: GenerationMutationHooks & { summaryNodeId?: string; rewriteId?: string } = {}
  ): Promise<StoryPayload> {
    return await this.storyGeneration.summarizeChapter(
      id,
      breakId,
      signal,
      options
    );
  }

}

/** The planner an import hands `createPlannedFacts`: a preserved plan wins,
 * and only its absence computes one from the story in hand — then records it
 * durably before the mutation can commit. A preserved plan can exist while
 * the callback still runs when a crash landed before the commit point; the
 * story is unchanged then, so applying the preserved plan and computing a
 * fresh one are the same import, and preferring the preserved one keeps the
 * report equal to it on every path. */
function preservedImportPlan<Plan>(
  custody: ImportPlanCustody<Plan> | undefined,
  compute: (story: Story) => Plan
): (story: Story) => Promise<Plan> {
  return async (story) => {
    const stored = custody?.stored() ?? null;
    if (stored !== null) return stored;
    const plan = compute(story);
    await custody?.record(plan);
    return plan;
  };
}

/** Run a `shared/` import parser and translate its ordinary `Error` into a
 * public 4xx `ServiceError`, the same convention `server/import-nai.ts` and
 * its siblings already throw directly, since they live in `server/` and can
 * import `ServiceError` themselves. A `shared/` parser cannot: it has no
 * status code to reach for, so this service-boundary call gives its failure
 * one instead of letting it fall through unclassified to a private 500. */
function importValidation<Value>(parse: () => Value): Value {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, error instanceof Error ? error.message : String(error));
  }
}

function storyFromContainerImport(
  container: NovelAiContainerImport,
  ids: ImportStoryIds = {}
) {
  const story = storyFromImport(container.story, ids);
  if (container.facts.length > 0) {
    createFacts(story, { facts: [...container.facts] });
  }
  if (container.authorsNote !== null) {
    setAuthorsNote(story, container.authorsNote);
  }
  return story;
}

/** Stop a scan the caller no longer wants.
 *
 * Search runs one request per keystroke, so a query is routinely obsolete
 * before it finishes. The status matches the worker's own cancellation answer:
 * the client discards a superseded reply either way, and what matters here is
 * that the reading stops. */
function requireLiveSearch(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ServiceError(408, "Search was superseded or cancelled");
  }
}

const PROMPT_ROLES: ReadonlySet<string> = new Set(
  ["system", "user", "assistant"] satisfies readonly PromptRole[]
);

/** The one place either transport's `messages` input turns into a trusted
 * `ChatMessage[]`, so a malformed request never reaches the tokenize probe. */
function requireChatMessages(value: unknown): readonly ChatMessage[] {
  if (!Array.isArray(value)) throw new ServiceError(400, "messages must be an array");
  return value.map((entry, index) => {
    const message = requireRecord(entry, `messages[${index}]`);
    const role = message.role;
    if (typeof role !== "string" || !PROMPT_ROLES.has(role)) {
      throw new ServiceError(400, `messages[${index}].role is invalid`);
    }
    return {
      role: role as PromptRole,
      content: requireStringValue(message.content, `messages[${index}].content`)
    };
  });
}
