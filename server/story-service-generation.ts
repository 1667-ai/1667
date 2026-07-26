import type { StoryPayload } from "../shared/types.js";
import { summarizeChapter } from "./chapter-summary.js";
import {
  autonameStory,
  continueStory,
  rewriteNode,
  type BindGenerationIntent
} from "./generation-http.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";
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
import { createSummaryTake } from "./summary-take.js";
import { requireString } from "./validation.js";

export interface GenerationMutationHooks {
  providerStarted?: () => void | Promise<void>;
  bindIntent?: BindGenerationIntent;
  mutationRequest?: unknown;
}

export interface StoryServiceGenerationDependencies {
  readonly stories: StoryStore;
  readonly settings: SettingsStore;
  readonly generationAdmission: GenerationAdmissionRegistry;
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
        const committed = await this.dependencies.storyMutations.runProvider(
          options.mutationRequest,
          "autonameStory",
          async (stories, qStarted) => {
            await autonameStory(
              id,
              stories,
              this.dependencies.settings,
              this.dependencies.promptCache,
              active,
              async () => {
                await qStarted();
                await options.providerStarted?.();
              },
              options.autonameId,
              options.expectedTitle,
              options.bindIntent
            );
          },
          () => undefined
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
  ): Promise<StoryPayload | null> {
    this.dependencies.ensureOpen();
    const genId = requireString(body.genId, "genId");
    return await this.dependencies.generationAdmission.run(id, genId, () =>
      this.dependencies.cancellable(signal, async (active) => {
        if (hooks.mutationRequest !== undefined) {
          const committed = await this.dependencies.storyMutations.runProvider(
            hooks.mutationRequest,
            "continueStory",
            async (stories, qStarted) => (await continueStory(
              id,
              body,
              stories,
              this.dependencies.settings,
              this.dependencies.promptCache,
              this.dependencies.generationAdmission,
              onDelta,
              active,
              async () => {
                await qStarted();
                await hooks.providerStarted?.();
              },
              hooks.bindIntent
            )) !== null,
            () => true
          );
          if (!committed.value) return null;
          return buildStoryPayload(
            committed.story,
            committed.aggregateVersion
          );
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
          hooks.providerStarted,
          hooks.bindIntent
        );
        return story === null ? null : buildStoryPayload(story);
      })
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
    const body = parseRewrite(value);
    if (options.mutationRequest !== undefined) {
      return await this.dependencies.cancellable(signal, async (active) => {
        const committed = await this.dependencies.storyMutations.runProvider(
          options.mutationRequest,
          "rewriteNode",
          async (stories, qStarted) => await rewriteNode(
            id,
            nodeId,
            { ...body },
            stories,
            this.dependencies.settings,
            this.dependencies.promptCache,
            onDelta,
            active,
            async () => {
              await qStarted();
              await options.providerStarted?.();
            },
            options.rewriteId,
            options.bindIntent
          ),
          () => true
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
        options.providerStarted,
        options.rewriteId,
        options.bindIntent
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
  ): Promise<string | null> {
    const body = parseSummaryTake(value);
    if (options.mutationRequest !== undefined) {
      return await this.dependencies.cancellable(signal, async (active) => {
        const committed = await this.dependencies.storyMutations.runProvider(
          options.mutationRequest,
          "createSummaryTake",
          async (stories, qStarted) => await createSummaryTake(
            id,
            body,
            stories,
            this.dependencies.settings,
            this.dependencies.promptCache,
            onDelta,
            active,
            async () => {
              await qStarted();
              await options.providerStarted?.();
            },
            {
              summaryNodeId: options.summaryNodeId,
              cutNodeId: options.cutNodeId
            },
            options.bindIntent
          ),
          () => options.summaryNodeId ?? null
        );
        return committed.value;
      });
    }
    return await this.dependencies.cancellable(
      signal,
      (active) => createSummaryTake(
        id,
        body,
        this.dependencies.stories,
        this.dependencies.settings,
        this.dependencies.promptCache,
        onDelta,
        active,
        options.providerStarted,
        {
          summaryNodeId: options.summaryNodeId,
          cutNodeId: options.cutNodeId
        },
        options.bindIntent
      )
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
        const committed = await this.dependencies.storyMutations.runProvider(
          options.mutationRequest,
          "summarizeChapter",
          async (stories, qStarted) => {
            await summarizeChapter(
              id,
              breakId,
              stories,
              this.dependencies.settings,
              this.dependencies.promptCache,
              active,
              {
                ...options,
                providerStarted: async () => {
                  await qStarted();
                  await options.providerStarted?.();
                }
              }
            );
          },
          () => undefined
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
