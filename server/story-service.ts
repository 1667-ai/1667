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
import {
  MAX_IMPORT_BYTES,
  storyFromImport,
  type GenericImport
} from "./import-model.js";
import { partsFromSillyTavernJsonl } from "./import-st.js";
import { partsFromMarkdown } from "./import-md.js";
import { partsFromNovelAiStory } from "./import-nai.js";
import type { CreationMethod } from "./story-creation-record.js";
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
      } else {
        await this.stories.withLock(id, () => this.stories.remove(id));
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
  async exportStory(id: string): Promise<{ filename: string; markdown: string }> {
    this.ensureOpen();
    const story = await this.stories.load(id);
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
      ].join("\n\n") + "\n"
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
    return {
      payload: await this.persistImportedStory(
        imported,
        "importSillyTavern",
        ids,
        mutationRequest
      ),
      droppedTrailingUserMessages: imported.droppedTrailingUserMessages
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
  ): Promise<{ payload: StoryPayload }> {
    this.ensureOpen();
    if (Buffer.byteLength(storyContainerJson) > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    const imported = partsFromNovelAiStory(storyContainerJson);
    return {
      payload: await this.persistImportedStory(
        imported,
        "importNovelAI",
        options,
        mutationRequest
      )
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
