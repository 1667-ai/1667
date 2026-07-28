import type {
  MutatingWorkerMethod
} from "../shared/worker-protocol.js";
import type { GenerationSettings, Story, StoryPayload } from "../shared/types.js";
import type { BindGenerationIntent } from "./generation-http.js";
import type { RemovedChapterBreak } from "./chapter-breaks.js";
import { mutationOutcomeUnknown } from "./mutation-recovery.js";
import { buildStoryPayload } from "./story-payload.js";
import type { StoryStore } from "./stories.js";

interface MutationEntityNamespaces {
  createStory: "story";
  renameStory: never;
  autonameStory: "autoname";
  acknowledgeUnknownOutcomes: never;
  deleteStory: never;
  switchLine: never;
  createNode: "node";
  editNode: never;
  deleteNode: never;
  pruneUnusedTakes: never;
  takeFromCut: "cut-take";
  putBookmark: never;
  deleteBookmark: never;
  createFact: "fact";
  patchFact: never;
  deleteFact: never;
  createChapterBreak: "chapter-break";
  renameChapterBreak: never;
  removeChapterBreak: never;
  restoreChapterBreak: never;
  summarizeChapter: "chapter-summary" | "chapter-summary-rewrite";
  saveSettings: never;
  importSillyTavern: "story" | "import-node";
  continueStory: never;
  rewriteNode: "rewrite";
  createSummaryTake: "summary-node" | "summary-cut";
}

export type MutationEntityNamespace<M extends MutatingWorkerMethod> = MutationEntityNamespaces[M];
export type MutationRecoveryMode = "new" | "pending" | "provider-uncertain";

/** Receipt-free capability exposed during aggregate admission. */
export interface MutationPreflightPlan<M extends MutatingWorkerMethod> {
  readonly method: M;
  entityId(namespace: MutationEntityNamespace<M>, index?: number): string;
}

export interface MutationPlan<M extends MutatingWorkerMethod> extends MutationPreflightPlan<M> {
  readonly recoveryMode: MutationRecoveryMode;
  bindGenerationIntent: BindGenerationIntent;
  preserveChapterBreakRemoval(
    expectedFingerprint: string,
    load: () => Promise<RemovedChapterBreak>
  ): Promise<RemovedChapterBreak>;
  providerStarted(): Promise<void>;
  reconcileStory(
    stories: StoryStore,
    storyId: string,
    matches: (story: Story) => boolean | Promise<boolean>
  ): Promise<StoryPayload | null>;
  generationAction(committed: boolean): "return-committed" | "execute";
}

export function mutationPreflightPlan<M extends MutatingWorkerMethod>(
  plan: MutationPlan<M>
): MutationPreflightPlan<M> {
  return Object.freeze({
    method: plan.method,
    entityId: (namespace: MutationEntityNamespace<M>, index?: number) => plan.entityId(namespace, index)
  });
}

export interface MutationHandlerContext {
  readonly onDelta: (text: string) => void | Promise<void>;
  readonly signal: AbortSignal;
  /** Parsed again by the canonical coordinator at the service boundary. */
  readonly storyMutationRequest?: unknown;
}

export interface MutationPlanStorage {
  entityId(namespace: string, index?: number): string;
  bindGenerationIntent(settings: GenerationSettings, context: unknown): Promise<void>;
  preserveChapterBreakRemoval(
    expectedFingerprint: string,
    load: () => Promise<RemovedChapterBreak>
  ): Promise<RemovedChapterBreak>;
  providerStarted(): Promise<void>;
  providerRecoveryRequired(): never;
}

export function createMutationPlan<M extends MutatingWorkerMethod>(
  method: M,
  recoveryMode: MutationRecoveryMode,
  storage: MutationPlanStorage
): MutationPlan<M> {
  return {
    method,
    recoveryMode,
    entityId: (namespace, index) => storage.entityId(namespace, index),
    bindGenerationIntent: (settings, context) => storage.bindGenerationIntent(settings, context),
    preserveChapterBreakRemoval: (expectedFingerprint, load) =>
      storage.preserveChapterBreakRemoval(expectedFingerprint, load),
    providerStarted: () => {
      if (recoveryMode === "provider-uncertain") {
        return storage.providerRecoveryRequired();
      }
      return storage.providerStarted();
    },
    reconcileStory: async (stories, storyId, matches) => {
      if (recoveryMode === "new") return null;
      const story = await stories.loadForMutation(storyId);
      if (await matches(story)) return buildStoryPayload(story);
      throw mutationOutcomeUnknown();
    },
    generationAction: (committed) => {
      if (recoveryMode === "new") return "execute";
      if (committed) return "return-committed";
      if (recoveryMode === "provider-uncertain") {
        return storage.providerRecoveryRequired();
      }
      return "execute";
    }
  };
}
