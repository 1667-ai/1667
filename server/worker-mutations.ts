import { activePath, unusedTakePruneSelection } from "../shared/story-tree.js";
import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  isCurrentWorkerInputProtocolVersion,
  type MutatingWorkerMethod,
  type WorkerInput,
  type WorkerOutput
} from "../shared/worker-protocol.js";
import {
  isProviderRecoveryContext
} from "../shared/provider-recovery.js";
import { ServiceError } from "./errors.js";
import {
  chapterBreakRemovalFingerprint,
  parseRemovedChapterBreak,
  type RemovedChapterBreak
} from "./chapter-breaks.js";
import type { MutationHandlerContext, MutationPlan, MutationPreflightPlan } from "./mutation-plan.js";
import { mutationOutcomeUnknown } from "./mutation-recovery.js";
import {
  parseEditNode,
  parsePruneUnusedTakes,
  parseSwitchOptions
} from "./service-input.js";
import { HASH_PATTERN } from "./story-format.js";
import { patchFact } from "./story-facts.js";
import { nodeRewriteId } from "./story-node-text.js";
import { storyAutonameId } from "./story-metadata.js";
import { hasCommittedGeneration } from "./story-nodes.js";
import { buildStoryPayload } from "./story-payload.js";
import type { StoryService } from "./story-service.js";
import { requireRecord, requireString } from "./validation.js";
import { parseWorkerContinueTarget } from "./worker-continue-target.js";

interface ParsedPreQChapterRemoval {
  readonly lane: "pre-q";
  readonly storyId: string;
  readonly breakId: string;
}

interface ParsedQChapterRemoval {
  readonly lane: "q";
  readonly storyId: string;
  readonly breakId: string;
  readonly removedFingerprint: string;
  readonly predecessorRemoved?: RemovedChapterBreak;
}

type ParsedChapterRemoval = ParsedPreQChapterRemoval | ParsedQChapterRemoval;

export type ParsedWorkerMutation<M extends MutatingWorkerMethod> =
  M extends "removeChapterBreak" ? ParsedChapterRemoval : WorkerInput<M>;

interface MutationDefinition<M extends MutatingWorkerMethod> {
  parse(value: unknown, protocolVersion?: number): ParsedWorkerMutation<M>;
  storyId(input: ParsedWorkerMutation<M>, plan: MutationPreflightPlan<M>): string | null;
  execute(
    service: StoryService,
    input: ParsedWorkerMutation<M>,
    plan: MutationPlan<M>,
    context: MutationHandlerContext
  ): Promise<WorkerOutput<M>>;
}

type MutationRegistry = { [M in MutatingWorkerMethod]: MutationDefinition<M> };

function define<M extends MutatingWorkerMethod>(definition: MutationDefinition<M>): MutationDefinition<M> {
  return definition;
}

const MUTATIONS: MutationRegistry = {
  createStory: define<"createStory">({
    parse: (value) => {
      const input = requireRecord(value, "createStory input");
      if (input.title !== undefined && typeof input.title !== "string") throw badInput("title must be a string");
      return input.title === undefined ? {} : { title: input.title };
    },
    storyId: (_input, plan) => plan.entityId("story"),
    execute: (service, input, plan, context) => service.createStory(
      input.title,
      plan.entityId("story"),
      context.storyMutationRequest
    )
  }),
  renameStory: define<"renameStory">({
    parse: (value) => requiredStrings<"renameStory">(value, "renameStory", "id", "title"),
    storyId: (input) => input.id,
    execute: async (service, input, plan, context) => {
      const recovered = await plan.reconcileStory(service.stories, input.id, (story) => story.title === input.title.trim());
      return recovered ?? await service.renameStory(
        input.id,
        input.title,
        context.storyMutationRequest
      );
    }
  }),
  autonameStory: define<"autonameStory">({
    parse: (value) => requiredStrings<"autonameStory">(value, "autonameStory", "id", "expectedTitle"),
    storyId: (input) => input.id,
    execute: async (service, input, plan, context) => {
      const id = plan.entityId("autoname");
      if (needsCompatibilityGenerationRecovery(plan, context)) {
        const story = await service.stories.loadForMutation(input.id);
        if (plan.generationAction(storyAutonameId(story) === id) === "return-committed") {
          return await loadMutationPayload(service, input.id);
        }
        if (story.title !== input.expectedTitle) throw mutationOutcomeUnknown();
      }
      return await service.autonameStory(input.id, context.signal, generationHooks(plan, {
        autonameId: id,
        expectedTitle: input.expectedTitle
      }, context.storyMutationRequest));
    }
  }),
  acknowledgeUnknownOutcomes: define<"acknowledgeUnknownOutcomes">({
    parse: (value) => {
      const input = requireRecord(
        value,
        "acknowledgeUnknownOutcomes input"
      );
      return {
        storyId: requireString(input.storyId, "storyId"),
        originalProviderMutationId: requireString(
          input.originalProviderMutationId,
          "originalProviderMutationId"
        ),
        ...(input.providerRecovery === undefined
          ? {}
          : {
              providerRecovery: requireProviderRecoveryContext(
                input.providerRecovery
              )
            })
      };
    },
    storyId: (input) => input.storyId,
    execute: (service, input, _plan, context) =>
      service.acknowledgeUnknownOutcomes(
        input.storyId,
        input.originalProviderMutationId,
        context.storyMutationRequest,
        input.providerRecovery
      )
  }),
  deleteStory: define<"deleteStory">({
    parse: (value) => requiredStrings<"deleteStory">(value, "deleteStory", "id"),
    storyId: (input) => input.id,
    execute: async (service, input, plan, context) => {
      if (plan.recoveryMode !== "new") {
        try {
          await service.stories.loadForMutation(input.id);
        } catch (error) {
          if (error instanceof ServiceError && error.status === 404) return { ok: true };
          throw error;
        }
      }
      return await service.deleteStory(input.id, context.storyMutationRequest);
    }
  }),
  switchLine: define<"switchLine">({
    parse: (value) => {
      const input = requireRecord(value, "switchLine input");
      return {
        storyId: requireString(input.storyId, "storyId"),
        nodeId: requireString(input.nodeId, "nodeId"),
        ...(input.options === undefined ? {} : { options: requireRecord(input.options, "options") })
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const options = parseSwitchOptions(input.options ?? {});
      if (options.expectedLineFingerprint !== undefined && !HASH_PATTERN.test(options.expectedLineFingerprint)) {
        throw badInput("Invalid expected line fingerprint");
      }
      const recovered = await plan.reconcileStory(service.stories, input.storyId, (story) => {
        const line = activePath(story);
        return options.stopAtNode === true
          ? line.at(-1)?.id === input.nodeId
          : line.some((node) => node.id === input.nodeId);
      });
      return recovered ?? await service.switchLine(
        input.storyId,
        input.nodeId,
        input.options,
        context.storyMutationRequest
      );
    }
  }),
  createNode: define<"createNode">({
    parse: (value) => bodyInput<"createNode">(value, "createNode"),
    storyId: (input) => input.storyId,
    execute: (service, input, plan, context) => service.createNode(
      input.storyId,
      input.body,
      plan.entityId("node"),
      context.storyMutationRequest
    )
  }),
  editNode: define<"editNode">({
    parse: (value) => bodyInputWithId<"editNode">(value, "editNode", "nodeId"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const edit = parseEditNode(input.body);
      const recovered = await plan.reconcileStory(service.stories, input.storyId, async (story) => {
        await service.stories.hydratePath(story, input.nodeId);
        const node = story.nodes.find((candidate) => candidate.id === input.nodeId);
        return node !== undefined
          && (edit.text === undefined || node.text === edit.text)
          && (edit.instruction === undefined || node.instruction === edit.instruction);
      });
      return recovered ?? await service.editNode(
        input.storyId,
        input.nodeId,
        input.body,
        context.storyMutationRequest
      );
    }
  }),
  deleteNode: define<"deleteNode">({
    parse: (value) => {
      const input = requireRecord(value, "deleteNode input");
      const count = input.expectedSubtreeCount;
      if (typeof count !== "number" || !Number.isSafeInteger(count)) throw badInput("expectedSubtreeCount must be an integer");
      return {
        storyId: requireString(input.storyId, "storyId"),
        nodeId: requireString(input.nodeId, "nodeId"),
        expectedSubtreeCount: count
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      if (plan.recoveryMode !== "new") {
        const story = await loadMutationPayload(service, input.storyId);
        if (!story.nodes.some((node) => node.id === input.nodeId)) return story;
      }
      return service.deleteNode(
        input.storyId,
        input.nodeId,
        input.expectedSubtreeCount,
        context.storyMutationRequest
      );
    }
  }),
  pruneUnusedTakes: define<"pruneUnusedTakes">({
    parse: (value) => bodyInput<"pruneUnusedTakes">(value, "pruneUnusedTakes"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const expected = parsePruneUnusedTakes(input.body);
      if (plan.recoveryMode !== "new") {
        const story = await loadMutationPayload(service, input.storyId);
        if (story.updatedAt !== expected.expectedStoryRevision) {
          if (unusedTakePruneSelection(story).takeIds.length === 0) return story;
          throw mutationOutcomeUnknown();
        }
      }
      return service.pruneUnusedTakes(
        input.storyId,
        input.body,
        context.storyMutationRequest
      );
    }
  }),
  takeFromCut: define<"takeFromCut">({
    parse: (value) => bodyInputWithId<"takeFromCut">(value, "takeFromCut", "nodeId"),
    storyId: (input) => input.storyId,
    execute: (service, input, plan, context) => service.takeFromCut(
      input.storyId,
      input.nodeId,
      input.body,
      plan.entityId("cut-take"),
      context.storyMutationRequest
    )
  }),
  putBookmark: define<"putBookmark">({
    parse: (value) => {
      const input = requireRecord(value, "putBookmark input");
      return {
        storyId: requireString(input.storyId, "storyId"),
        nodeId: requireString(input.nodeId, "nodeId"),
        name: requireString(input.name, "name"),
        label: requireStringValue(input.label, "label") as WorkerInput<"putBookmark">["label"]
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const recovered = await plan.reconcileStory(service.stories, input.storyId, (story) => {
        const tag = story.tags.find((candidate) => candidate.nodeId === input.nodeId);
        return tag?.name === input.name && tag.status === input.label
          && (input.label !== "Canon" || story.tags.every((candidate) =>
            candidate.nodeId === input.nodeId || candidate.status !== "Canon"));
      });
      return recovered ?? await service.putBookmark(
        input.storyId,
        input.nodeId,
        input.name,
        input.label,
        context.storyMutationRequest
      );
    }
  }),
  deleteBookmark: define<"deleteBookmark">({
    parse: (value) => requiredStrings<"deleteBookmark">(value, "deleteBookmark", "storyId", "nodeId"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      if (plan.recoveryMode !== "new") {
        const story = await loadMutationPayload(service, input.storyId);
        if (!story.tags.some((tag) => tag.nodeId === input.nodeId)) return story;
      }
      return service.deleteBookmark(
        input.storyId,
        input.nodeId,
        context.storyMutationRequest
      );
    }
  }),
  createFact: define<"createFact">({
    parse: (value) => bodyInput<"createFact">(value, "createFact"),
    storyId: (input) => input.storyId,
    execute: (service, input, plan, context) => service.createFact(
      input.storyId,
      input.body,
      (index) => plan.entityId("fact", index),
      context.storyMutationRequest
    )
  }),
  patchFact: define<"patchFact">({
    parse: (value) => bodyInputWithId<"patchFact">(value, "patchFact", "factId"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const recovered = await plan.reconcileStory(service.stories, input.storyId, (story) => {
        const current = story.facts.find((fact) => fact.id === input.factId);
        if (current === undefined) return false;
        const candidate = structuredClone(story);
        patchFact(candidate, input.factId, input.body);
        const desired = candidate.facts.find((fact) => fact.id === input.factId)!;
        return current.tag === desired.tag && current.text === desired.text;
      });
      return recovered ?? await service.patchFact(
        input.storyId,
        input.factId,
        input.body,
        context.storyMutationRequest
      );
    }
  }),
  deleteFact: define<"deleteFact">({
    parse: (value) => requiredStrings<"deleteFact">(value, "deleteFact", "storyId", "factId"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      if (plan.recoveryMode !== "new") {
        const story = await loadMutationPayload(service, input.storyId);
        if (!story.facts.some((fact) => fact.id === input.factId)) return story;
      }
      return await service.deleteFact(
        input.storyId,
        input.factId,
        context.storyMutationRequest
      );
    }
  }),
  createChapterBreak: define<"createChapterBreak">({
    parse: (value) => {
      const input = requireRecord(value, "createChapterBreak input");
      return {
        storyId: requireString(input.storyId, "storyId"),
        parentPartId: requireString(input.parentPartId, "parentPartId"),
        title: requireStringValue(input.title, "title")
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const breakId = plan.entityId("chapter-break");
      const recovered = await plan.reconcileStory(service.stories, input.storyId, (story) =>
        story.chapterBreaks.some((chapterBreak) => chapterBreak.id === breakId
          && chapterBreak.parentPartId === input.parentPartId
          && chapterBreak.title === input.title));
      if (recovered !== null) return { payload: recovered, breakId };
      return await service.createChapterBreak(
        input.storyId,
        input.parentPartId,
        input.title,
        breakId,
        context.storyMutationRequest
      );
    }
  }),
  renameChapterBreak: define<"renameChapterBreak">({
    parse: (value) => requiredStrings<"renameChapterBreak">(
      value, "renameChapterBreak", "storyId", "breakId", "title"
    ),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const recovered = await plan.reconcileStory(service.stories, input.storyId, (story) =>
        story.chapterBreaks.some((chapterBreak) => chapterBreak.id === input.breakId
          && chapterBreak.title === input.title));
      return recovered ?? await service.renameChapterBreak(
        input.storyId,
        input.breakId,
        input.title,
        context.storyMutationRequest
      );
    }
  }),
  removeChapterBreak: define<"removeChapterBreak">({
    parse: (value, protocolVersion) => {
      const input = requireRecord(value, "removeChapterBreak input");
      const storyId = requireString(input.storyId, "storyId");
      const breakId = requireString(input.breakId, "breakId");
      if (protocolVersion === PREDECESSOR_WORKER_PROTOCOL_VERSION) {
        const predecessorRemoved = parseRemovedChapterBreak(input.removed);
        return {
          lane: "q",
          storyId,
          breakId,
          removedFingerprint: chapterBreakRemovalFingerprint(predecessorRemoved),
          predecessorRemoved
        };
      }
      if (protocolVersion !== undefined
        && !isCurrentWorkerInputProtocolVersion(protocolVersion)) {
        return { lane: "pre-q", storyId, breakId };
      }
      const removedFingerprint = requireString(
        input.removedFingerprint,
        "removedFingerprint"
      );
      if (!HASH_PATTERN.test(removedFingerprint)) {
        throw badInput("Invalid removedFingerprint");
      }
      return {
        lane: "q",
        storyId,
        breakId,
        removedFingerprint
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      if (input.lane === "pre-q") {
        if (plan.recoveryMode !== "new") {
          const story = await service.stories.loadForMutation(input.storyId);
          if (!story.chapterBreaks.some(
            (chapterBreak) => chapterBreak.id === input.breakId
          )) {
            throw mutationOutcomeUnknown();
          }
        }
        return await service.deleteChapterBreak(
          input.storyId,
          input.breakId
        );
      }
      const removed = await plan.preserveChapterBreakRemoval(
        input.removedFingerprint,
        async () => input.predecessorRemoved
          ?? (await service.previewChapterBreakRemoval(
            input.storyId,
            input.breakId
          )).removed
      );
      return await service.deleteChapterBreak(
        input.storyId,
        input.breakId,
        context.storyMutationRequest,
        removed
      );
    }
  }),
  restoreChapterBreak: define<"restoreChapterBreak">({
    parse: (value) => {
      const input = requireRecord(value, "restoreChapterBreak input");
      return {
        storyId: requireString(input.storyId, "storyId"),
        breakId: requireString(input.breakId, "breakId"),
        removed: parseRemovedChapterBreak(input.removed)
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const recovered = await plan.reconcileStory(service.stories, input.storyId, (story) => {
        const restored = story.chapterBreaks.find((chapterBreak) => chapterBreak.id === input.breakId);
        return restored?.parentPartId === input.removed.break.parentPartId
          && restored.title === input.removed.break.title
          && restored.createdAt === input.removed.break.createdAt
          && input.removed.summaries.every((summary) =>
            story.nodes.some((node) => node.id === summary.id && node.chapterBreakId === input.breakId));
      });
      return recovered ?? await service.restoreChapterBreak(
        input.storyId,
        input.breakId,
        input.removed,
        context.storyMutationRequest
      );
    }
  }),
  summarizeChapter: define<"summarizeChapter">({
    parse: (value) => requiredStrings<"summarizeChapter">(
      value, "summarizeChapter", "storyId", "breakId"
    ),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const summaryNodeId = plan.entityId("chapter-summary");
      const rewriteId = plan.entityId("chapter-summary-rewrite");
      if (needsCompatibilityGenerationRecovery(plan, context)) {
        const story = await service.stories.loadForMutation(input.storyId);
        const committed = story.nodes.some((node) => node.id === summaryNodeId
          || (node.chapterBreakId === input.breakId && nodeRewriteId(node) === rewriteId));
        if (plan.generationAction(committed) === "return-committed") {
          return await loadMutationPayload(service, input.storyId);
        }
      }
      return await service.summarizeChapter(input.storyId, input.breakId, context.signal,
        generationHooks(
          plan,
          { summaryNodeId, rewriteId },
          context.storyMutationRequest
        ));
    }
  }),
  importSillyTavern: define<"importSillyTavern">({
    parse: (value) => requiredStrings<"importSillyTavern">(value, "importSillyTavern", "jsonl"),
    storyId: (_input, plan) => plan.entityId("story"),
    execute: async (service, input, plan, context) => {
      const storyId = plan.entityId("story");
      if (plan.recoveryMode !== "new") {
        try {
          return await loadMutationPayload(service, storyId);
        } catch (error) {
          if (!(error instanceof ServiceError) || error.status !== 404) throw error;
        }
      }
      return await service.importSillyTavern(input.jsonl, {
        storyId,
        nodeId: (index) => plan.entityId("import-node", index)
      }, context.storyMutationRequest);
    }
  }),
  continueStory: define<"continueStory">({
    parse: (value) => {
      const input = requireRecord(value, "continueStory input");
      return {
        storyId: requireString(input.storyId, "storyId"),
        instruction: requireStringValue(input.instruction, "instruction"),
        genId: requireString(input.genId, "genId"),
        target: parseWorkerContinueTarget(input.target)
      };
    },
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      if (needsCompatibilityGenerationRecovery(plan, context)) {
        const story = await service.stories.loadForMutation(input.storyId);
        if (plan.generationAction(hasCommittedGeneration(story, input.genId)) === "return-committed") {
          return await loadMutationPayload(service, input.storyId);
        }
      }
      return await service.continueStory(input.storyId, {
        ...input.target,
        instruction: input.instruction,
        genId: input.genId
      }, context.onDelta, context.signal, generationHooks(
        plan,
        {},
        context.storyMutationRequest
      ));
    }
  }),
  rewriteNode: define<"rewriteNode">({
    parse: (value) => bodyInputWithId<"rewriteNode">(value, "rewriteNode", "nodeId"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const rewriteId = plan.entityId("rewrite");
      if (needsCompatibilityGenerationRecovery(plan, context)) {
        const story = await service.stories.loadForMutation(input.storyId);
        const node = story.nodes.find((candidate) => candidate.id === input.nodeId);
        if (plan.generationAction(node !== undefined && nodeRewriteId(node) === rewriteId) === "return-committed") {
          return true;
        }
      }
      return await service.rewriteNode(
        input.storyId, input.nodeId, input.body, context.onDelta, context.signal,
        generationHooks(
          plan,
          { rewriteId },
          context.storyMutationRequest
        )
      );
    }
  }),
  createSummaryTake: define<"createSummaryTake">({
    parse: (value) => bodyInput<"createSummaryTake">(value, "createSummaryTake"),
    storyId: (input) => input.storyId,
    execute: async (service, input, plan, context) => {
      const summaryNodeId = plan.entityId("summary-node");
      if (needsCompatibilityGenerationRecovery(plan, context)) {
        const story = await service.stories.loadForMutation(input.storyId);
        if (plan.generationAction(story.nodes.some((node) => node.id === summaryNodeId)) === "return-committed") {
          return summaryNodeId;
        }
      }
      return await service.createSummaryTake(
        input.storyId, input.body, context.onDelta, context.signal,
        generationHooks(
          plan,
          { summaryNodeId, cutNodeId: plan.entityId("summary-cut") },
          context.storyMutationRequest
        )
      );
    }
  })
};

export function parseWorkerMutation<M extends MutatingWorkerMethod>(
  method: M,
  value: unknown,
  protocolVersion?: number
): ParsedWorkerMutation<M> {
  if (protocolVersion === LEGACY_WORKER_PROTOCOL_VERSION && method === "autonameStory") {
    const input = requireRecord(value, "autonameStory input");
    requireString(input.id, "id");
    if (input.expectedTitle === undefined) {
      throw new ServiceError(
        409,
        "A retained protocol-v3 autoname request cannot be replayed safely; reload authoritative state before retrying.",
        "mutation_outcome_unknown"
      );
    }
  }
  return (MUTATIONS[method] as MutationDefinition<M>).parse(
    value,
    protocolVersion
  );
}

export async function preflightWorkerMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  input: ParsedWorkerMutation<M>,
  plan: MutationPreflightPlan<M>
): Promise<void> {
  const storyId = (MUTATIONS[plan.method] as MutationDefinition<M>).storyId(input, plan);
  if (storyId !== null) await service.stories.assertMutationSupported(storyId);
}

export async function executeWorkerMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  input: ParsedWorkerMutation<M>,
  plan: MutationPlan<M>,
  context: MutationHandlerContext
): Promise<WorkerOutput<M>> {
  return await (MUTATIONS[plan.method] as MutationDefinition<M>).execute(service, input, plan, context);
}

export function storyIdForWorkerMutation<M extends MutatingWorkerMethod>(
  input: ParsedWorkerMutation<M>,
  plan: MutationPreflightPlan<M>
): string | null {
  return (MUTATIONS[plan.method] as MutationDefinition<M>).storyId(input, plan);
}

async function loadMutationPayload(service: StoryService, storyId: string) {
  return buildStoryPayload(await service.stories.loadForMutation(storyId));
}

function generationHooks<M extends
  "autonameStory" | "continueStory" | "rewriteNode" | "createSummaryTake" | "summarizeChapter">(
  plan: MutationPlan<M>,
  options: Record<string, string> = {},
  mutationRequest?: unknown
) {
  return {
    providerStarted: () => plan.providerStarted(),
    bindIntent: plan.bindGenerationIntent,
    ...(mutationRequest === undefined ? {} : { mutationRequest }),
    ...options
  };
}

type ProviderWorkerMethod =
  | "autonameStory"
  | "summarizeChapter"
  | "continueStory"
  | "rewriteNode"
  | "createSummaryTake";

function needsCompatibilityGenerationRecovery<M extends ProviderWorkerMethod>(
  plan: MutationPlan<M>,
  context: MutationHandlerContext
): boolean {
  return plan.recoveryMode !== "new"
    && context.storyMutationRequest === undefined;
}

function requiredStrings<M extends MutatingWorkerMethod>(
  value: unknown,
  method: string,
  ...keys: string[]
): WorkerInput<M> {
  const input = requireRecord(value, `${method} input`);
  return Object.fromEntries(keys.map((key) => [key, requireString(input[key], key)])) as unknown as WorkerInput<M>;
}

function bodyInput<M extends MutatingWorkerMethod>(value: unknown, method: string): WorkerInput<M> {
  const input = requireRecord(value, `${method} input`);
  return { storyId: requireString(input.storyId, "storyId"), body: input.body } as WorkerInput<M>;
}

function bodyInputWithId<M extends MutatingWorkerMethod>(
  value: unknown,
  method: string,
  key: "nodeId" | "factId"
): WorkerInput<M> {
  const input = requireRecord(value, `${method} input`);
  return {
    storyId: requireString(input.storyId, "storyId"),
    [key]: requireString(input[key], key),
    body: input.body
  } as unknown as WorkerInput<M>;
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw badInput(`${label} must be a string`);
  return value;
}

function badInput(message: string): ServiceError {
  return new ServiceError(400, message);
}

function requireProviderRecoveryContext(value: unknown) {
  if (!isProviderRecoveryContext(value)) {
    throw badInput("providerRecovery is invalid");
  }
  return value;
}
