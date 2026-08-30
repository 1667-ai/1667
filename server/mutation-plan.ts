import type {
  MutatingWorkerMethod
} from "../shared/worker-protocol.js";
import type { GenerationSettings, Story, StoryPayload } from "../shared/types.js";
import type { CardImportPlan } from "../shared/card-import.js";
import type { LorebookImport } from "../shared/lorebook-entry.js";
import type { BindGenerationIntent } from "./generation-http.js";
import type { ReasoningStreamDelta } from "./providers.js";
import type { RemovedChapterBreak } from "./chapter-breaks.js";
import { mutationOutcomeUnknown } from "./mutation-recovery.js";
import { buildStoryPayload } from "./story-payload.js";
import type { StoryStore } from "./stories.js";

interface MutationEntityNamespaces {
  createStory: "story";
  renameStory: never;
  setAuthorsNote: never;
  setAuthorBrief: never;
  setFactsBudget: never;
  setPhraseBias: never;
  setBannedStrings: never;
  autonameStory: "autoname";
  acknowledgeUnknownOutcomes: never;
  deleteStory: never;
  switchLine: never;
  createNode: "node";
  editNode: never;
  deleteNode: never;
  pruneUnusedTakes: never;
  takeFromCut: "cut-take";
  pasteStoryLine: "pasted-node";
  putBookmark: never;
  deleteBookmark: never;
  createFact: "fact";
  patchFact: never;
  deleteFact: never;
  createFactState: "fact-state";
  patchFactState: never;
  deleteFactState: never;
  reorderFact: never;
  createChapterBreak: "chapter-break";
  renameChapterBreak: never;
  removeChapterBreak: never;
  restoreChapterBreak: never;
  summarizeChapter: "chapter-summary" | "chapter-summary-rewrite";
  saveSettings: never;
  importSillyTavern: "story" | "import-node";
  importMarkdown: "story" | "import-node" | "chapter-break";
  importNovelAI: "story" | "import-node";
  importScenario: "story" | "import-node";
  importLorebook: never;
  importCard: never;
  continueStory: never;

  rewriteNode: "rewrite" | "rewrite-take";
  commitPartialRewrite: "partial-rewrite-take";
  createSummaryTake: "summary-node" | "summary-cut";
  askAside: never;
  retakeAside: never;
  asideSessionMutation: never;
  clearAside: never;
}

export type MutationEntityNamespace<M extends MutatingWorkerMethod> = MutationEntityNamespaces[M];
export type MutationRecoveryMode = "new" | "pending" | "provider-uncertain";

/** The report each import method must answer with exactly once per mutation
 * ID, however many times the request is retried. */
export type MutationImportPlan<M extends MutatingWorkerMethod> =
  M extends "importLorebook" ? LorebookImport
    : M extends "importCard" ? CardImportPlan
      : never;

/**
 * The service-facing port for one import mutation's preserved plan. `record`
 * makes the plan durable in the outer receipt before the story transaction
 * can commit, and `stored` answers it back on a retry, so the reported plan
 * is never recomputed from a story the import already changed.
 */
export interface ImportPlanCustody<Plan> {
  stored(): Plan | null;
  record(plan: Plan): Promise<void>;
}

export function importPlanCustody<
  M extends "importLorebook" | "importCard"
>(plan: MutationPlan<M>): ImportPlanCustody<MutationImportPlan<M>> {
  return {
    stored: () => plan.storedImportPlan(),
    record: (value) => plan.recordImportPlan(value)
  };
}

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
  storedImportPlan(): MutationImportPlan<M> | null;
  recordImportPlan(value: MutationImportPlan<M>): Promise<void>;
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
  /** Mutable authority for an Aside answer stopped by the user. */
  readonly canCommitStoppedAside?: () => boolean;
  /** Parsed again by the canonical coordinator at the service boundary. */
  readonly storyMutationRequest?: unknown;
  /** Reasoning ("thinking") text, kept apart from `onDelta`'s story prose.
   *  Read only by the generation mutations that can carry it
   *  (continueStory, rewriteNode, createSummaryTake). */
  readonly onReasoning?: (delta: ReasoningStreamDelta) => void | Promise<void>;
}

export interface MutationPlanStorage {
  entityId(namespace: string, index?: number): string;
  bindGenerationIntent(settings: GenerationSettings, context: unknown): Promise<void>;
  preserveChapterBreakRemoval(
    expectedFingerprint: string,
    load: () => Promise<RemovedChapterBreak>
  ): Promise<RemovedChapterBreak>;
  storedImportPlan(): unknown;
  recordImportPlan(value: unknown): Promise<void>;
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
    storedImportPlan: () =>
      storage.storedImportPlan() as MutationImportPlan<M> | null,
    recordImportPlan: (value) => storage.recordImportPlan(value),
    providerStarted: () => {
      if (recoveryMode === "provider-uncertain") {
        return storage.providerRecoveryRequired();
      }
      return storage.providerStarted();
    },
    reconcileStory: async (stories, storyId, matches) => {
      if (recoveryMode === "new") return null;
      // Recovery is a read of an already-admitted exact receipt. Successor
      // manifests (including Fact State V14) are readable here even though a
      // predecessor cannot start a new direct-write mutation against them.
      // Keep that successor fence in `loadForMutation`; only this bounded
      // reconciliation path may inspect the current aggregate.
      const story = await stories.loadHydrated(storyId);
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
