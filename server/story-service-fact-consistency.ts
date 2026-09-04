import { randomUUID } from "node:crypto";
import type { GenerationSettings, Story, StoryPayload } from "../shared/types.js";
import { activePath } from "../shared/story-tree.js";
import {
  factConsistencyLine,
  parseFactConsistencyFindings,
  selectFactConsistencyParts,
  type FactConsistencySelectionInput
} from "../shared/fact-consistency.js";
import {
  MAX_FACT_CONSISTENCY_FINDINGS_PER_PART,
  MAX_FACT_CONSISTENCY_LINE_TAKES,
  MAX_FACT_CONSISTENCY_PART_CHARS,
  hashFactConsistencyRun,
  type FactConsistencyPartSelection,
  type FactConsistencyRun,
  type FactConsistencyRunPart,
  type FactConsistencyScope
} from "../shared/fact-consistency-types.js";
import { factConsistencyPrompt } from "../shared/fact-consistency-prompt.js";
import type { PromptCacheContext } from "../shared/prompt-cache-capabilities.js";
import type { SettingsStore } from "./settings.js";
import { streamCompletion, type StreamOutcome } from "./providers.js";
import { ServiceError } from "./errors.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import type { PromptCacheRuntime } from "./provider-cache-policy.js";
import { createPromptCacheRequest } from "./provider-cache-policy.js";
import type { StoryStore } from "./stories.js";
import type { StoryMutationStore } from "./story-mutation-store.js";
import { buildStoryPayload } from "./story-payload.js";
import { mapWithConcurrency } from "./concurrency.js";
import { mintStoryMutationRequest } from "./story-mutation-request.js";
import {
  assertFactConsistencyRunCapacity,
  assertFactConsistencyWorkload,
  boundFactConsistencyRun,
  factConsistencyFindingBudgets,
  factFindingBytes,
  utf8Prefix,
  type FactConsistencyBatch,
  type FactConsistencyPartBudget
} from "./fact-consistency-bounds.js";
import {
  completionFailureReason,
  factConsistencyBatches,
  factConsistencyBatchHash,
  factConsistencyMarker,
  factConsistencySettings,
  factConsistencyPlanToken,
  providerFailureReason,
  publicProviderFailure
} from "./fact-consistency-prompts.js";

export { boundFactConsistencyRun } from "./fact-consistency-bounds.js";

const FACT_CONSISTENCY_REQUEST_CONCURRENCY = 4;
const PLAN_RUN_ID = "00000000-0000-4000-8000-000000000000";

export interface FactConsistencyRequest {
  readonly storyId: string;
  readonly focusedPartId: string;
  readonly scope: FactConsistencyScope;
  readonly planToken?: string;
}

export interface FactConsistencyCheckOptions {
  readonly mutationRequest?: unknown;
  readonly runId?: string;
  /** Exact run leaf to use while the inner provider receipt recovers. */
  readonly replayRunHash?: string;
  readonly providerStarted?: () => void | Promise<void>;
  readonly bindIntent?: (settings: GenerationSettings, context: unknown) => void | Promise<void>;
  /** Persist the compact run identity before the story manifest publishes. */
  readonly recordRun?: (run: FactConsistencyRun) => void | Promise<void>;
}

export interface FactConsistencyServiceDependencies {
  readonly stories: StoryStore;
  readonly settings: SettingsStore;
  readonly storyMutations: StoryMutationStore;
  readonly promptCache: PromptCacheRuntime;
  readonly cancellable: <T>(
    signal: AbortSignal,
    work: (active: AbortSignal) => Promise<T>
  ) => Promise<T>;
}

export class StoryServiceFactConsistency {
  constructor(private readonly dependencies: FactConsistencyServiceDependencies) {}

  async plan(input: unknown): Promise<{
    partCount: number;
    requestCount: number;
    planToken: string;
  }> {
    const request = parseFactConsistencyRequest(input);
    const planned = await this.preparePlan(request);
    return {
      partCount: planned.parts.length,
      requestCount: planned.workload.requestCount,
      planToken: planned.planToken
    };
  }

  async check(
    input: unknown,
    signal: AbortSignal,
    options: FactConsistencyCheckOptions = {}
  ): Promise<{ run: FactConsistencyRun; payload: StoryPayload }> {
    const request = parseFactConsistencyRequest(input, true);
    const runId = options.runId ?? randomUUID();
    // A target take can be deleted after provider work starts. Recovery must
    // validate the retained immutable run first, then let the provider
    // mutation layer publish it. It must not reselect current prose or load
    // utility settings before its started-receipt recovery branch.
    if (options.replayRunHash !== undefined) {
      return await this.recoverExactRun(request, runId, signal, options);
    }
    const planned = await this.preparePlan(request);
    // A provider-start transition changes the aggregate version after the
    // confirmed plan. Fresh checks must always match the current plan token.
    if (request.planToken !== planned.planToken) {
      throw new ServiceError(
        409,
        "Fact consistency plan is stale. Plan the check again before starting it.",
        "conflict"
      );
    }
    const mutationRequest = options.mutationRequest
      ?? await mintStoryMutationRequest(
        this.dependencies.stories,
        request.storyId,
        "checkFactConsistency",
        `${request.focusedPartId}\0${request.scope}`
      );
    return await this.dependencies.cancellable(signal, async (active) => {
      const committed = await this.dependencies.storyMutations.runProviderOperation(
        mutationRequest,
        "checkFactConsistency",
        {
          signal: active,
          work: async ({ stories, providerStarted, signal: providerSignal }) => {
            const story = await stories.loadForMutation(request.storyId);
            const parts = await selectHydratedParts(
              story,
              request,
              async (source, nodeId) => await stories.hydratePath(source, nodeId)
            );
            const loaded = await this.dependencies.settings.loadGeneration("utility");
            const settings = factConsistencySettings(loaded.settings);
            this.dependencies.settings.assertProviderRequestSupported(settings);
            const prompts = parts.map((part) => factConsistencyBatches(part, settings));
            const workload = assertFactConsistencyWorkload(
              parts,
              prompts,
              runId,
              factConsistencyMarker
            );
            assertFactConsistencyRunCapacity(story, request, parts, settings, runId);
            const currentPlanToken = factConsistencyPlanToken(
              planned.aggregateVersion,
              request,
              parts,
              prompts,
              settings
            );
            if (currentPlanToken !== request.planToken) {
              throw new ServiceError(
                409,
                "Fact consistency plan is stale. Plan the check again before starting it.",
                "conflict"
              );
            }
            const budgets = factConsistencyFindingBudgets(
              story,
              request,
              parts,
              settings,
              runId
            );
            await options.bindIntent?.(settings, {
              kind: "fact-check",
              storyId: request.storyId,
              focusedPartId: request.focusedPartId,
              scope: request.scope,
              parts: prompts.map((batches, index) => ({
                partId: parts[index]!.partId,
                batches: batches === null ? null : {
                  count: batches.length,
                  promptHash: factConsistencyBatchHash(parts[index]!, batches, runId)
                }
              }))
            });
            let started: Promise<void> | null = null;
            const ensureStarted = (): Promise<void> => {
              started ??= (async () => {
                await providerStarted();
                await options.providerStarted?.();
              })();
              return started;
            };
            // A fully unchecked run still uses the provider mutation's durable
            // terminal path, but it has no request that can naturally call the
            // start hook. Start it before leasing the run so a crash after the
            // lease has an inner started receipt to recover through.
            if (workload.requestCount === 0) await ensureStarted();
            let completedProviderResponses = 0;
            let firstProviderError: unknown | null = null;
            const checked = await mapWithConcurrency(
              parts,
              FACT_CONSISTENCY_REQUEST_CONCURRENCY,
              async (part, index) => await checkPart(
                part,
                prompts[index]!,
                budgets[index]!,
                settings,
                loaded.promptCache,
                this.dependencies.promptCache,
                request.storyId,
                runId,
                ensureStarted,
                providerSignal,
                () => { completedProviderResponses += 1; },
                (error) => { firstProviderError ??= error; }
              )
            );
            providerSignal.throwIfAborted();
            if (workload.requestCount > 0
              && completedProviderResponses === 0
              && firstProviderError !== null) {
              throw publicProviderFailure(firstProviderError);
            }
            const selectedTakeIds = new Set(activePath(story).map(({ id }) => id));
            const run = boundFactConsistencyRun({
              format: "1667-fact-consistency-run",
              schemaVersion: 1,
              runId,
              scope: request.scope,
              anchor: { partId: request.focusedPartId, takeId: request.focusedPartId },
              checkedAt: new Date().toISOString(),
              provider: {
                profile: "utility",
                preset: providerRuntimeFor(settings).preset,
                model: settings.model
              },
              storyLineTakeIds: factConsistencyLine(story, request.focusedPartId).map((part) => part.id),
              parts: checked.map((part) => ({
                ...part,
                selectedAtRun: selectedTakeIds.has(part.takeId)
              })),
              droppedFindings: checked.reduce((sum, part) => sum + part.droppedFindings, 0)
            });
            const materializedHash = await this.dependencies.stories.materializeFactConsistencyRun(
              request.storyId,
              run,
              async () => await options.recordRun?.(run)
            );
            if (materializedHash !== hashFactConsistencyRun(run)) {
              throw new ServiceError(
                500,
                "Fact consistency run identity changed before publication",
                "internal"
              );
            }
            await stories.commitProviderEffect(request.storyId, {
              kind: "fact-consistency",
              run
            });
            return run;
          },
          replayValue: async (session) => {
            const story = await session.loadLive();
            const runHash = options.replayRunHash ?? story.factConsistencyRunId;
            if (runHash === undefined || runHash === null) {
              throw new ServiceError(500, "Fact consistency run is missing after recovery", "internal");
            }
            const run = await session.readFactConsistencyRun(runHash);
            assertExactFactConsistencyRun(run, runHash, runId, request);
            return run;
          },
          recoverStarted: async (session) => {
            // A started-only inner receipt is recoverable only when the outer
            // receipt retained the exact run identity. The current manifest's
            // pointer alone may name an older completed run.
            const runHash = options.replayRunHash;
            if (runHash === undefined) {
              throw new ServiceError(
                409,
                "Fact consistency run identity is missing during recovery",
                "mutation_outcome_unknown"
              );
            }
            const run = await session.readFactConsistencyRun(runHash);
            assertExactFactConsistencyRun(run, runHash, runId, request);
            return {
              value: run,
              effect: { kind: "fact-consistency", run }
            };
          }
        }
      );
      return {
        run: committed.value,
        payload: buildStoryPayload(committed.story, committed.aggregateVersion)
      };
    });
  }

  private async recoverExactRun(
    request: FactConsistencyRequest,
    runId: string,
    signal: AbortSignal,
    options: FactConsistencyCheckOptions
  ): Promise<{ run: FactConsistencyRun; payload: StoryPayload }> {
    const runHash = options.replayRunHash!;
    const retained = await this.dependencies.stories.loadFactConsistencyRun(
      request.storyId,
      runHash
    );
    assertExactFactConsistencyRun(retained, runHash, runId, request);
    const mutationRequest = options.mutationRequest
      ?? await mintStoryMutationRequest(
        this.dependencies.stories,
        request.storyId,
        "checkFactConsistency",
        `${request.focusedPartId}\0${request.scope}`
      );
    return await this.dependencies.cancellable(signal, async (active) => {
      const committed = await this.dependencies.storyMutations.runProviderOperation(
        mutationRequest,
        "checkFactConsistency",
        {
          signal: active,
          // An exact recovery must never open a fresh provider request if the
          // started receipt is missing. The mutation layer normally selects
          // `recoverStarted` first; this guard keeps the fallback non-billable.
          work: async () => {
            throw new ServiceError(
              409,
              "Fact consistency run recovery evidence is missing.",
              "mutation_outcome_unknown"
            );
          },
          replayValue: async (session) => {
            const run = await session.readFactConsistencyRun(runHash);
            assertExactFactConsistencyRun(run, runHash, runId, request);
            return run;
          },
          recoverStarted: async (session) => {
            const run = await session.readFactConsistencyRun(runHash);
            assertExactFactConsistencyRun(run, runHash, runId, request);
            return {
              value: run,
              effect: { kind: "fact-consistency", run }
            };
          }
        }
      );
      return {
        run: committed.value,
        payload: buildStoryPayload(committed.story, committed.aggregateVersion)
      };
    });
  }

  async getRun(storyId: string, runHash?: string): Promise<FactConsistencyRun | null> {
    if (typeof storyId !== "string" || storyId.length === 0) {
      throw new ServiceError(400, "Missing storyId");
    }
    return await this.dependencies.stories.loadFactConsistencyRun(storyId, runHash);
  }

  private async preparePlan(request: FactConsistencyRequest): Promise<{
    readonly story: Story;
    readonly aggregateVersion: Awaited<ReturnType<StoryStore["loadForFactConsistencyWithVersion"]>>["aggregateVersion"];
    readonly parts: readonly FactConsistencyPartSelection[];
    readonly settings: GenerationSettings;
    readonly batches: readonly (readonly FactConsistencyBatch[] | null)[];
    readonly workload: ReturnType<typeof assertFactConsistencyWorkload>;
    readonly planToken: string;
  }> {
    const loadedStory = await this.dependencies.stories.loadForFactConsistencyWithVersion(
      request.storyId
    );
    const parts = await selectHydratedParts(
      loadedStory.story,
      request,
      async (source, nodeId) => await this.dependencies.stories.hydratePath(source, nodeId)
    );
    const loaded = await this.dependencies.settings.loadGeneration("utility");
    const settings = factConsistencySettings(loaded.settings);
    const batches = parts.map((part) => factConsistencyBatches(part, settings));
    const workload = assertFactConsistencyWorkload(
      parts,
      batches,
      PLAN_RUN_ID,
      factConsistencyMarker
    );
    assertFactConsistencyRunCapacity(
      loadedStory.story,
      request,
      parts,
      settings,
      PLAN_RUN_ID
    );
    return {
      story: loadedStory.story,
      aggregateVersion: loadedStory.aggregateVersion,
      parts,
      settings,
      batches,
      workload,
      planToken: factConsistencyPlanToken(
        loadedStory.aggregateVersion,
        request,
        parts,
        batches,
        settings
      )
    };
  }
}

function assertExactFactConsistencyRun(
  run: FactConsistencyRun | null,
  runHash: string,
  runId: string,
  request: FactConsistencyRequest
): asserts run is FactConsistencyRun {
  if (run === null
    || run.runId !== runId
    || run.scope !== request.scope
    || run.anchor.partId !== request.focusedPartId
    || run.anchor.takeId !== request.focusedPartId
    || hashFactConsistencyRun(run) !== runHash) {
    throw new ServiceError(
      409,
      "Fact consistency run identity changed during recovery",
      "mutation_outcome_unknown"
    );
  }
}

function parseFactConsistencyRequest(
  value: unknown,
  requirePlanToken = false
): FactConsistencyRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "Fact consistency request must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.storyId !== "string" || record.storyId.length === 0) {
    throw new ServiceError(400, "Missing storyId");
  }
  if (typeof record.focusedPartId !== "string" || record.focusedPartId.length === 0) {
    throw new ServiceError(400, "Missing focusedPartId");
  }
  if (record.scope !== "chapter" && record.scope !== "story-line") {
    throw new ServiceError(400, "scope must be chapter or story-line");
  }
  const planToken = record.planToken;
  if (requirePlanToken
    && (typeof planToken !== "string" || !/^[a-f0-9]{64}$/u.test(planToken))) {
    throw new ServiceError(
      400,
      "Fact consistency check requires the current plan token.",
      "invalid_request"
    );
  }
  return {
    storyId: record.storyId,
    focusedPartId: record.focusedPartId,
    scope: record.scope,
    ...(typeof planToken === "string" ? { planToken } : {})
  };
}

function selectParts(
  story: FactConsistencySelectionInput["story"],
  request: FactConsistencyRequest
): readonly FactConsistencyPartSelection[] {
  try {
    assertFactConsistencyLineCapacity(factConsistencyLine(story, request.focusedPartId).length);
    return selectFactConsistencyParts({ story, ...request });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      400,
      error instanceof Error ? error.message : "Unable to select Fact consistency parts",
      "invalid_request"
    );
  }
}

/** Provider admission decodes only the active line, so an explicitly focused
 * off-active take still has an empty text stub. Resolve the structural line
 * first, hydrate the selected branch path, then run the canonical selection
 * again against the real prose. */
async function selectHydratedParts(
  story: Story,
  request: FactConsistencyRequest,
  hydratePath: (story: Story, nodeId: string) => Promise<void>
): Promise<readonly FactConsistencyPartSelection[]> {
  let line: readonly Story["nodes"][number][];
  try {
    line = factConsistencyLine(story, request.focusedPartId);
    assertFactConsistencyLineCapacity(line.length);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      400,
      error instanceof Error ? error.message : "Unable to select Fact consistency parts",
      "invalid_request"
    );
  }
  await hydratePath(story, line[line.length - 1]!.id);
  return selectParts(story, request);
}

function assertFactConsistencyLineCapacity(lineCount: number): void {
  if (lineCount > MAX_FACT_CONSISTENCY_LINE_TAKES) {
    throw new ServiceError(
      400,
      `Fact consistency checks support at most ${MAX_FACT_CONSISTENCY_LINE_TAKES.toLocaleString()} parts. Narrow the selected line or chapter.`,
      "invalid_request"
    );
  }
}

async function checkPart(
  part: FactConsistencyPartSelection,
  batches: readonly FactConsistencyBatch[] | null,
  budget: FactConsistencyPartBudget,
  settings: GenerationSettings,
  promptCache: PromptCacheContext,
  promptCacheRuntime: PromptCacheRuntime,
  storyId: string,
  runId: string,
  providerStarted: () => Promise<void>,
  signal: AbortSignal,
  providerResponseCompleted: () => void,
  providerError: (error: unknown) => void
): Promise<FactConsistencyRunPart> {
  if (batches === null) {
    return {
      partId: part.partId,
      takeId: part.takeId,
      findings: [],
      droppedFindings: 0,
      uncheckedReason: part.text.length > MAX_FACT_CONSISTENCY_PART_CHARS
        ? "The selected part exceeds the Fact consistency part size limit."
        : "The required part and Fact State context does not fit the configured context window."
    };
  }
  const findings = new Map<string, FactConsistencyRunPart["findings"][number]>();
  let droppedFindings = 0;
  let uncheckedReason: string | undefined;
  for (let index = 0; index < batches.length; index += 1) {
    const facts = batches[index]!;
    const marker = factConsistencyMarker(runId, part.partId, index);
    const prompt = factConsistencyPrompt(part, facts, marker);
    const outcome: StreamOutcome = { finishReason: null, providerTerminal: false };
    let responseCompleted = false;
    try {
      await providerStarted();
      const output: string[] = [];
      let outputBytes = 0;
      for await (const delta of streamCompletion(settings, prompt, signal, {
        outcome,
        promptCache: createPromptCacheRequest(
          promptCacheRuntime,
          promptCache,
          storyId,
          "fact-check"
        )
      })) {
        if (outputBytes >= budget.maxResponseBytes) continue;
        const kept = utf8Prefix(delta, budget.maxResponseBytes - outputBytes);
        output.push(kept);
        outputBytes += Buffer.byteLength(kept, "utf8");
      }
      signal.throwIfAborted();
      responseCompleted = true;
      providerResponseCompleted();
      const parsed = parseFactConsistencyFindings(
        output.join(""),
        part.text,
        facts,
        marker,
        {
          maxFindings: MAX_FACT_CONSISTENCY_FINDINGS_PER_PART,
          maxBytes: budget.maxBytes
        }
      );
      if (!parsed.complete) {
        uncheckedReason ??= completionFailureReason(outcome);
        continue;
      }
      droppedFindings += parsed.droppedFindings;
      for (const finding of parsed.findings) {
        const key = `${finding.fact_id}\0${finding.quote}\0${finding.statement}`;
        if (findings.has(key)) continue;
        if (findings.size >= MAX_FACT_CONSISTENCY_FINDINGS_PER_PART) {
          droppedFindings += 1;
          continue;
        }
        const bytes = factFindingBytes(finding)
          + (findings.size === 0 ? 0 : 1);
        if (budget.usedBytes + bytes > budget.maxBytes) {
          droppedFindings += 1;
          continue;
        }
        findings.set(key, finding);
        budget.usedBytes += bytes;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (!responseCompleted) providerError(error);
      uncheckedReason ??= providerFailureReason();
    }
  }
  return {
    partId: part.partId,
    takeId: part.takeId,
    findings: [...findings.values()],
    droppedFindings,
      ...(uncheckedReason === undefined ? {} : { uncheckedReason })
  };
}
