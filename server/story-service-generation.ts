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
import { createSummaryTake, type SummaryPoint } from "./summary-take.js";
import { requireString } from "./validation.js";

/** The hooks a caller of `StoryServiceGeneration`'s streamed mutations may
 *  supply: `GenerationStreamHooks` (server/generation-http.ts) — the
 *  generation's own concerns, `providerStarted`/`bindIntent`/`onReasoning`
 *  — plus `mutationRequest`, this layer's own concern (durable-replay
 *  identity), which no lower layer ever reads. */
export interface GenerationMutationHooks extends GenerationStreamHooks {
  mutationRequest?: unknown;
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
    if (options.mutationRequest !== undefined) {
      return await this.dependencies.cancellable(signal, async (active) => {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          options.mutationRequest,
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
      });
    }
    return await this.dependencies.cancellable(
      signal,
      async (active) => buildStoryPayload(await autonameStory(
        id,
        this.dependencies.stories,
        this.dependencies.settings,
        this.dependencies.promptCache,
        active,
        options.providerStarted,
        options.autonameId,
        options.expectedTitle,
        options.bindIntent
      ))
    );
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
        if (hooks.mutationRequest !== undefined) {
          const committed =
            await this.dependencies.storyMutations.runProviderOperation(
            hooks.mutationRequest,
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
    if (options.mutationRequest !== undefined) {
      return await this.dependencies.cancellable(signal, async (active) => {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          options.mutationRequest,
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
      });
    }
    return await this.dependencies.cancellable(
      signal,
      (active) => rewriteNode(
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
      )
    );
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
    // The point actually summarized lives only inside createSummaryTake's own
    // call stack — this closure is how it survives past the provider-operation
    // boundary below, the same way continueStory's `droppedFacts` does above.
    // A crash-recovery replay that skips straight to the committed node never
    // reaches this callback, so it stays null rather than guessing.
    let narrowedTo: SummaryPoint | null = null;
    const onSummaryPointNarrowed = (point: SummaryPoint): void => { narrowedTo = point; };
    if (options.mutationRequest !== undefined) {
      return await this.dependencies.cancellable(signal, async (active) => {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          options.mutationRequest,
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
                  onSummaryPointNarrowed,
                  providerStarted: async () => {
                    await providerStarted();
                    await options.providerStarted?.();
                  }
                }
              ),
            replayValue: () => options.summaryNodeId ?? null
          }
        );
        return committed.value === null ? null : { nodeId: committed.value, narrowedTo };
      });
    }
    return await this.dependencies.cancellable(
      signal,
      async (active) => {
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
          { ...options, onSummaryPointNarrowed }
        );
        return nodeId === null ? null : { nodeId, narrowedTo };
      }
    );
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
    if (options.mutationRequest !== undefined) {
      return await this.dependencies.cancellable(signal, async (active) => {
        const committed =
          await this.dependencies.storyMutations.runProviderOperation(
          options.mutationRequest,
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
      });
    }
    return await this.dependencies.cancellable(
      signal,
      async (active) => buildStoryPayload(await summarizeChapter(
        id,
        breakId,
        this.dependencies.stories,
        this.dependencies.settings,
        this.dependencies.promptCache,
        active,
        options
      ))
    );
  }
}
