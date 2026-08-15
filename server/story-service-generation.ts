import { resolveRewriteDestination, type StoryPayload } from "../shared/types.js";
import type { FactBudgetDrop } from "../shared/fact-budget.js";
import { summarizeChapter } from "./chapter-summary.js";
import {
  autonameStory,
  continueStory,
  rewriteNode,
  type GenerationStreamHooks
} from "./generation-http.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";
import type { PartialRewriteStash } from "./rewrite-partial.js";
import type { DeltaConsumer } from "./generation-stream.js";
import type { PromptCacheRuntime } from "./provider-cache-policy.js";
import {
  parseRewrite,
  parseSummaryTake
} from "./service-input.js";
import type { SettingsStore } from "./settings.js";
import type { StoryMutationStore } from "./story-mutation-store.js";
import { buildStoryPayload } from "./story-payload.js";
import type { StoryStore } from "./stories.js";
import { createSummaryTake, narrowedSummaryPoint, type SummaryPoint } from "./summary-take.js";
import { requireString } from "./validation.js";
import {
  askAside,
  viewAsideDocument,
  type AsideDocumentView
} from "./aside-http.js";
import { asideEntryPointsOpen } from "../shared/aside-release.js";
import { ServiceError } from "./errors.js";
import {
  mintActivatedStoryMutationRequest,
  mintStoryMutationRequest
} from "./story-mutation-request.js";

/** The hooks a caller of `StoryServiceGeneration`'s streamed mutations may
 *  supply: `GenerationStreamHooks` (server/generation-http.ts) — the
 *  generation's own concerns, `providerStarted`/`bindIntent`/`onReasoning`
 *  — plus `mutationRequest`, this layer's own concern (durable-replay
 *  identity), which no lower layer ever reads. */
export interface GenerationMutationHooks extends GenerationStreamHooks {
  mutationRequest?: unknown;
  /** Mutable authority for an Aside answer stopped by the user. */
  canCommitStoppedAside?: () => boolean;
}

export interface StoryServiceGenerationDependencies {
  readonly stories: StoryStore;
  readonly settings: SettingsStore;
  readonly generationAdmission: GenerationAdmissionRegistry;
  readonly rewritePartials: PartialRewriteStash;
  readonly promptCache: PromptCacheRuntime;
  readonly storyMutations: StoryMutationStore;
  readonly ensureOpen: () => void;
  readonly cancellable: <T>(
    signal: AbortSignal,
    work: (active: AbortSignal) => Promise<T>
  ) => Promise<T>;
}

/** Provider-backed story commands and their durable Q fence transitions. */
export class StoryServiceGeneration {
  constructor(
    private readonly dependencies: StoryServiceGenerationDependencies
  ) {}

  async autonameStory(
    id: string,
    signal: AbortSignal,
    options: GenerationMutationHooks & {
      autonameId?: string;
      expectedTitle?: string;
    } = {}
  ): Promise<StoryPayload> {
    return await this.dependencies.cancellable(signal, async (active) => {
      const mutationRequest = options.mutationRequest !== undefined
        ? options.mutationRequest
        : await mintActivatedStoryMutationRequest(
            this.dependencies.stories,
            id,
            "autonameStory",
            options.autonameId ?? ""
          );
      if (mutationRequest !== undefined) {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          mutationRequest,
          "autonameStory",
          {
            signal: active,
            work: async ({ stories, providerStarted, signal }) => {
              await autonameStory(
                id,
                stories,
                this.dependencies.settings,
                this.dependencies.promptCache,
                signal,
                async () => {
                  await providerStarted();
                  await options.providerStarted?.();
                },
                options.autonameId,
                options.expectedTitle,
                options.bindIntent
              );
            },
            replayValue: () => undefined
          }
        );
        return buildStoryPayload(
          committed.story,
          committed.aggregateVersion
        );
      }
      return buildStoryPayload(await autonameStory(
        id,
        this.dependencies.stories,
        this.dependencies.settings,
        this.dependencies.promptCache,
        active,
        options.providerStarted,
        options.autonameId,
        options.expectedTitle,
        options.bindIntent
      ));
    });
  }

  async continueStory(
    id: string,
    body: Record<string, unknown>,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<{ payload: StoryPayload; droppedFacts: readonly FactBudgetDrop[] } | null> {
    this.dependencies.ensureOpen();
    const genId = requireString(body.genId, "genId");
    // Admission's real, post-shedding drop set lives only inside continueStory's
    // call stack — this closure is how it survives past the provider-operation
    // boundary below, since the committed Story it produces carries no trace of
    // what admission shed to make the fixed prompt fit (see issue #281 review
    // finding C). A crash-recovery replay that skips straight to the committed
    // story never reaches this callback, so it stays empty rather than guessing.
    let droppedFacts: readonly FactBudgetDrop[] = [];
    const onFactsDropped = (dropped: readonly FactBudgetDrop[]): void => { droppedFacts = dropped; };
    return await this.dependencies.generationAdmission.run(id, genId, () =>
      this.dependencies.cancellable(signal, async (active) => {
        const mutationRequest = hooks.mutationRequest !== undefined
          ? hooks.mutationRequest
          : await mintActivatedStoryMutationRequest(
              this.dependencies.stories,
              id,
              "continueStory",
              genId
            );
        if (mutationRequest !== undefined) {
          const committed =
            await this.dependencies.storyMutations.runProviderOperation(
            mutationRequest,
            "continueStory",
            {
              signal: active,
              work: async ({ stories, providerStarted, signal }) =>
                (await continueStory(
                  id,
                  body,
                  stories,
                  this.dependencies.settings,
                  this.dependencies.promptCache,
                  this.dependencies.generationAdmission,
                  onDelta,
                  signal,
                  {
                    ...hooks,
                    onFactsDropped,
                    // The story's own Draft Lease / Image Object reader:
                    // `stories` here is the scoped provider runtime, which
                    // has no filesystem access of its own, so image
                    // resolution goes through the full `StoryStore` instead.
                    imageStore: this.dependencies.stories,
                    providerStarted: async () => {
                      await providerStarted();
                      await hooks.providerStarted?.();
                    }
                  }
                )) !== null,
              replayValue: () => true
            }
          );
          if (!committed.value) return null;
          return {
            payload: buildStoryPayload(committed.story, committed.aggregateVersion),
            droppedFacts
          };
        }
        const story = await continueStory(
          id,
          body,
          this.dependencies.stories,
          this.dependencies.settings,
          this.dependencies.promptCache,
          this.dependencies.generationAdmission,
          onDelta,
          active,
          { ...hooks, onFactsDropped, imageStore: this.dependencies.stories }
        );
        return story === null ? null : { payload: buildStoryPayload(story), droppedFacts };
      })
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
    const body = parseRewrite(value);
    // In place mode mints no new node, so a replay must answer the target's
    // own id — the take id it would otherwise return was never minted.
    const replayValue = resolveRewriteDestination(body.destination) === "take"
      ? (options.takeId ?? null)
      : nodeId;
    return await this.dependencies.cancellable(signal, async (active) => {
      const mutationRequest = options.mutationRequest !== undefined
        ? options.mutationRequest
        : await mintActivatedStoryMutationRequest(
            this.dependencies.stories,
            id,
            "rewriteNode",
            nodeId
          );
      if (mutationRequest !== undefined) {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          mutationRequest,
          "rewriteNode",
          {
            signal: active,
            work: async ({ stories, providerStarted, signal }) =>
              await rewriteNode(
                id,
                nodeId,
                { ...body },
                stories,
                this.dependencies.settings,
                this.dependencies.promptCache,
                onDelta,
                signal,
                options.rewriteId,
                options.takeId,
                this.dependencies.rewritePartials,
                {
                  ...options,
                  providerStarted: async () => {
                    await providerStarted();
                    await options.providerStarted?.();
                  }
                }
              ),
            replayValue: () => replayValue
          }
        );
        return committed.value;
      }
      return await rewriteNode(
        id,
        nodeId,
        { ...body },
        this.dependencies.stories,
        this.dependencies.settings,
        this.dependencies.promptCache,
        onDelta,
        active,
        options.rewriteId,
        options.takeId,
        this.dependencies.rewritePartials,
        options
      );
    });
  }

  async createSummaryTake(
    id: string,
    value: unknown,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    options: GenerationMutationHooks & {
      summaryNodeId?: string;
      cutNodeId?: string;
    } = {}
  ): Promise<{ nodeId: string; narrowedTo: SummaryPoint | null } | null> {
    const body = parseSummaryTake(value);
    const requestedNodeId = requireString(body.nodeId, "nodeId");
    return await this.dependencies.cancellable(signal, async (active) => {
      const mutationRequest = options.mutationRequest !== undefined
        ? options.mutationRequest
        : await mintActivatedStoryMutationRequest(
            this.dependencies.stories,
            id,
            "createSummaryTake",
            requestedNodeId
          );
      if (mutationRequest !== undefined) {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          mutationRequest,
          "createSummaryTake",
          {
            signal: active,
            work: async ({ stories, providerStarted, signal }) =>
              await createSummaryTake(
                id,
                body,
                stories,
                this.dependencies.settings,
                this.dependencies.promptCache,
                onDelta,
                signal,
                {
                  summaryNodeId: options.summaryNodeId,
                  cutNodeId: options.cutNodeId
                },
                {
                  ...options,
                  providerStarted: async () => {
                    await providerStarted();
                    await options.providerStarted?.();
                  }
                }
              ),
            replayValue: () => options.summaryNodeId ?? null
          }
        );
        if (committed.value === null) return null;
        // Reads the point actually summarized back off the committed take's
        // own parentId — `committed.story` is the current story either way,
        // whether this attempt ran createSummaryTake live or the ledger
        // answered a replay that never called it at all (issue #139 review:
        // a hook a live run fills in has nothing to fill it in with on a
        // replay, so the writer saw no narrowing warning on a recovered
        // response).
        return {
          nodeId: committed.value,
          narrowedTo: narrowedSummaryPoint(committed.story, committed.value, requestedNodeId, options.cutNodeId)
        };
      }
      const nodeId = await createSummaryTake(
          id,
          body,
          this.dependencies.stories,
          this.dependencies.settings,
          this.dependencies.promptCache,
          onDelta,
          active,
          {
            summaryNodeId: options.summaryNodeId,
            cutNodeId: options.cutNodeId
          },
          options
        );
        if (nodeId === null) return null;
        // No durable receipt wraps this branch (server/story-service.ts's
        // "local durability tier" doc comment), so createSummaryTake always
        // just ran — the reload is still the single source of truth for
        // what it actually summarized, the same way the mutationRequest
        // branch above reads it, rather than a second, parallel mechanism
        // that could drift from it.
        const story = await this.dependencies.stories.loadForMutation(id);
      return { nodeId, narrowedTo: narrowedSummaryPoint(story, nodeId, requestedNodeId, options.cutNodeId) };
    });
  }

  /** Read the complete Aside document. Empty when none exists. */
  async getAside(id: string): Promise<AsideDocumentView> {
    this.dependencies.ensureOpen();
    if (!asideEntryPointsOpen(this.dependencies.stories.asideActivation)) {
      throw new ServiceError(400, "Aside is not available in this release.", "aside_not_supported");
    }
    const document = await this.dependencies.stories.loadAsideDocument(id);
    return viewAsideDocument(document);
  }

  async askAside(
    id: string,
    body: Record<string, unknown>,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<AsideDocumentView | null> {
    this.dependencies.ensureOpen();
    if (!asideEntryPointsOpen(this.dependencies.stories.asideActivation)
      && hooks.mutationRequest === undefined) {
      throw new ServiceError(400, "Aside is not available in this release.", "aside_not_supported");
    }
    return await this.dependencies.cancellable(signal, async (active) => {
      // Aside commits write V9/V10 content through the aggregate session.
      // Always use the durable provider mutation path, minting a request when
      // the transport did not supply one (in-process callers and tests).
      const mutationRequest = hooks.mutationRequest
        ?? await mintStoryMutationRequest(
          this.dependencies.stories,
          id,
          "askAside",
          typeof body.question === "string" ? body.question : ""
        );
      const committed = await this.dependencies.storyMutations.runProviderOperation(
        mutationRequest,
        "askAside",
        {
          signal: active,
          work: async ({ stories, providerStarted, signal }) =>
            await askAside(
              id,
              body,
              stories,
              this.dependencies.settings,
              this.dependencies.promptCache,
              onDelta,
              signal,
              {
                ...hooks,
                entryPointsOpen: this.dependencies.stories.asideActivation,
                loadDocument: async (story) => {
                  if (story.asideDocumentId === undefined || story.asideDocumentId === null) {
                    return null;
                  }
                  return await this.dependencies.stories.readAsideDocument(
                    id,
                    story.asideDocumentId
                  );
                },
                providerStarted: async () => {
                  await providerStarted();
                  await hooks.providerStarted?.();
                }
              }
            ),
          replayValue: async () => viewAsideDocument(
            await this.dependencies.stories.loadAsideDocument(id)
          )
        }
      );
      return committed.value;
    });
  }

  async summarizeChapter(
    id: string,
    breakId: string,
    signal: AbortSignal,
    options: GenerationMutationHooks & {
      summaryNodeId?: string;
      rewriteId?: string;
    } = {}
  ): Promise<StoryPayload> {
    return await this.dependencies.cancellable(signal, async (active) => {
      const mutationRequest = options.mutationRequest !== undefined
        ? options.mutationRequest
        : await mintActivatedStoryMutationRequest(
            this.dependencies.stories,
            id,
            "summarizeChapter",
            breakId
          );
      if (mutationRequest !== undefined) {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          mutationRequest,
          "summarizeChapter",
          {
            signal: active,
            work: async ({ stories, providerStarted, signal }) => {
              await summarizeChapter(
                id,
                breakId,
                stories,
                this.dependencies.settings,
                this.dependencies.promptCache,
                signal,
                {
                  ...options,
                  providerStarted: async () => {
                    await providerStarted();
                    await options.providerStarted?.();
                  }
                }
              );
            },
            replayValue: () => undefined
          }
        );
        return buildStoryPayload(
          committed.story,
          committed.aggregateVersion
        );
      }
      return buildStoryPayload(await summarizeChapter(
        id,
        breakId,
        this.dependencies.stories,
        this.dependencies.settings,
        this.dependencies.promptCache,
        active,
        options
      ));
    });
  }
}
