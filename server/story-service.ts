import { deriveChapters } from "../shared/chapters.js";
import { activePath } from "../shared/story-tree.js";
import type {
  SettingsMutationResult,
  SettingsView
} from "../shared/settings-v2-types.js";
import type {
  GenerationSettings,
  StoryPayload,
  StorySummary
} from "../shared/types.js";
import type {
  ProviderRecoveryContext
} from "../shared/provider-recovery.js";
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
import {
  isServiceOwnedSettingsMutation,
  type LocalDurabilityMutationMethod,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import { runLocalTierMutation } from "./mutation-local-tier.js";
import { providerRecoveryFromArchive } from "./mutation-outbox.js";
import type { RemovedChapterBreak } from "./chapter-breaks.js";
import { probeContextWindow } from "./context-probe.js";
import { ServiceError } from "./errors.js";
import type { DeltaConsumer } from "./generation-stream.js";
import { MAX_IMPORT_BYTES, partsFromSillyTavernJsonl, storyFromImport } from "./import-st.js";
import { checkModelServer } from "./server-check.js";
import { discoverProviderModels } from "./model-discovery.js";
import { seedStarterVault } from "./starter-vault.js";
import { buildStoryPayload } from "./story-payload.js";
import type { MutationPlan, MutationPreflightPlan } from "./mutation-plan.js";
import type { MutatingWorkerMethod } from "../shared/worker-protocol.js";
import type { StoryCatalogPage } from "../shared/story-catalog.js";
import type { GenerationMutationHooks } from "./story-service-generation.js";
import {
  StoryServiceRuntime,
  type StoryServiceUndiagnosedOptions
} from "./story-service-runtime.js";

export type { GenerationMutationHooks } from "./story-service-generation.js";
export type { StoryServiceOptions } from "./story-service-runtime.js";

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

  /** Prepared search text, so a query per keystroke does not reread the vault. */
  private readonly searchIndex = new StorySearchIndex();

  /** Corpus builds in flight, so concurrent keystrokes share one hydration. */
  private readonly searchBuilds = new Map<
    string,
    { updatedAt: string; corpus: Promise<SearchCorpus | null> }
  >();

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
    const request = parseSearchRequest(input);
    const query = request.query.trim();
    const base: SearchResponse = {
      query,
      scope: request.scope,
      caseSensitive: request.caseSensitive,
      hits: [],
      capped: false,
      storiesSearched: 0
    };
    if (!searchQueryIsRunnable(query)) return base;
    requireLiveSearch(signal);
    const summaries = request.scope === "tree" ? [] : await this.stories.list();
    const revisions = new Map(summaries.map((summary) =>
      [summary.id, { title: summary.title, updatedAt: summary.updatedAt }] as const));
    const targets = [
      request.storyId,
      ...summaries.map((summary) => summary.id).filter((id) => id !== request.storyId)
    ];
    const hits: SearchHit[] = [];
    let storiesSearched = 0;
    let capped = false;
    for (const id of targets) {
      // A keystroke supersedes the query before it: check between stories, the
      // seam where the next story would otherwise be hydrated off disk.
      requireLiveSearch(signal);
      if (hits.length >= SEARCH_HIT_LIMIT) {
        // Stories after this one go unread, so the count really is a floor
        // even when those stories would have matched nothing.
        capped = true;
        break;
      }
      const corpus = await this.searchCorpusFor(id, revisions.get(id));
      // A story deleted between the listing and the scan is simply not there.
      if (corpus === null) continue;
      storiesSearched += 1;
      const room = SEARCH_HIT_LIMIT - hits.length;
      // Ask for one more than there is room for: that extra hit is how a
      // capped result set announces itself without a second scan.
      const found = searchCorpus(corpus, query, request.caseSensitive, room + 1);
      if (found.length > room) capped = true;
      hits.push(...found.slice(0, room));
    }
    return { ...base, hits, capped, storiesSearched };
  }

  /** The cached corpus while its revision still stands, otherwise one built
   *  from a fully hydrated story.
   *
   *  At vault scope `known` is the revision the catalog listing reported, and
   *  that listing is taken fresh at the start of this same request. A story
   *  edited or deleted inside that window is answered from the corpus the
   *  listing described, which is one keystroke stale; the next keystroke lists
   *  again and corrects it. Re-reading every manifest a second time to close a
   *  window that small would double the per-keystroke cost of the feature. What
   *  is not tolerated is a story vanishing mid-scan, which is handled below, or
   *  a deleted story keeping a warm corpus, which `deleteStory` drops. */
  private async searchCorpusFor(
    id: string,
    known: { title: string; updatedAt: string } | undefined
  ): Promise<SearchCorpus | null> {
    const revision = known ?? await this.stories.loadRevision(id);
    if (revision === null) {
      this.searchIndex.forget(id);
      return null;
    }
    const held = this.searchIndex.cached(id, revision.title, revision.updatedAt);
    if (held !== null) return held;
    // A keystroke per request means several cold requests can reach this line
    // for the same revision at once. Each would queue its own full-tree read
    // behind the story's I/O slot, and the last of them can outlive the unary
    // deadline. Share one build instead.
    const pending = this.searchBuilds.get(id);
    if (pending !== undefined && pending.updatedAt === revision.updatedAt) {
      return await pending.corpus;
    }
    const build = this.buildSearchCorpus(id);
    this.searchBuilds.set(id, { updatedAt: revision.updatedAt, corpus: build });
    try {
      return await build;
    } finally {
      if (this.searchBuilds.get(id)?.corpus === build) this.searchBuilds.delete(id);
    }
  }

  private async buildSearchCorpus(id: string): Promise<SearchCorpus | null> {
    try {
      return this.searchIndex.adopt(await this.stories.loadHydrated(id));
    } catch (error) {
      // A vault scan walks a listing that is already a moment old. A story
      // deleted between the listing and its turn is simply not there, and must
      // not fail the query for every story after it.
      if (error instanceof ServiceError && error.status === 404) {
        this.searchIndex.forget(id);
        return null;
      }
      throw error;
    }
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

  async renameStory(
    id: string,
    title: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.renameStory(id, title, mutationRequest);
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
        return { ok: true };
      }
      await this.stories.withLock(id, () => this.stories.remove(id));
      return { ok: true };
    } finally {
      // A deleted story keeps no prepared text. Dropping it here is what stops
      // a warm corpus from answering for a story that is gone.
      this.searchIndex.forget(id);
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
  async exportStory(id: string): Promise<{ filename: string; markdown: string }> {
    this.ensureOpen();
    const story = await this.stories.load(id);
    const comment = (value: string) => value.replace(/--!?>/g, "→");
    const header = story.origin === undefined ? "" :
      `<!-- derived from "${comment(story.origin.storyTitle)}" (story ${story.origin.storyId}, node ${story.origin.partId}${story.origin.offset === null ? "" : ` @ ${story.origin.offset}`}) -->\n\n`;
    const chapters = deriveChapters(
      activePath(story),
      story.chapterBreaks,
      story.nodes
    );
    const sections = chapters.map((chapter) => {
      const prose = chapter.parts.map((part) => part.text).join("\n\n");
      // The document title already names the opening chapter when nothing
      // renamed it, so an untitled first chapter gets no heading of its own.
      if (chapter.number === 1 && chapter.title === "") return prose;
      return `## ${chapter.title === "" ? `Chapter ${chapter.number}` : chapter.title}\n\n${prose}`;
    });
    // Deliberately narrower than the on-disk name (`exportFileBase`): this one
    // goes into a Content-Disposition quoted-string, so it stays ASCII and
    // punctuation-free rather than needing RFC 5987 encoding.
    const filename = `${story.title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "story"}.md`;
    return {
      filename,
      markdown: `# ${story.title}\n\n${header}${sections.join("\n\n")}\n`
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

  async deleteFact(
    id: string,
    factId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    return await this.storyLocal.deleteFact(id, factId, mutationRequest);
  }

  async getSettings(): Promise<SettingsView> {
    this.ensureOpen();
    return await this.settings.loadView();
  }

  async saveSettings(value: unknown): Promise<SettingsMutationResult> {
    this.ensureOpen();
    return await this.settings.save(value);
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
  ): Promise<{ payload: StoryPayload; droppedTrailingUserMessages: number }> {
    this.ensureOpen();
    if (Buffer.byteLength(jsonl) > MAX_IMPORT_BYTES) throw new ServiceError(413, "Request body too large");
    const imported = partsFromSillyTavernJsonl(jsonl);
    if (mutationRequest !== undefined) {
      const committed = await this.storyCreations.run(
        mutationRequest,
        "importSillyTavern",
        (deterministicId) => storyFromImport(imported, {
          storyId: deterministicId,
          nodeId: ids.nodeId
        })
      );
      return {
        payload: buildStoryPayload(committed.story, {
          kind: "v6",
          revision: committed.result.storyRevision
        }),
        droppedTrailingUserMessages: imported.droppedTrailingUserMessages
      };
    }
    const story = storyFromImport(imported, {
      storyId: ids.storyId,
      nodeId: ids.nodeId
    });
    await this.stories.save(story);
    return {
      payload: buildStoryPayload(story),
      droppedTrailingUserMessages: imported.droppedTrailingUserMessages
    };
  }

  async continueStory(
    id: string,
    body: Record<string, unknown>,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<StoryPayload | null> {
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
    options: GenerationMutationHooks & { rewriteId?: string } = {}
  ): Promise<boolean> {
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
  ): Promise<string | null> {
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
    breakId: string,
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
