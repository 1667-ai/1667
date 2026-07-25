import type { Story } from "../shared/types.js";
import {
  GenerationResultError,
  isDefinitiveProviderFailure,
  ServiceError
} from "./errors.js";
import type {
  MutationCoordinator,
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import { hashStartedMutationRecord } from "./mutation-ledger-codec.js";
import {
  MutationLedgerStore,
  type StoryMutationReceipt
} from "./mutation-ledger-store.js";
import type {
  MutationResult,
  PreparedUserMutationRecord,
  ProviderMutationMethod,
  StartedMutationRecord
} from "./mutation-ledger-types.js";
import { requireExpectedStoryVersion } from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import {
  applyProviderStoryEffect
} from "./story-provider-effect.js";
import {
  ScopedProviderStoryRuntime,
  type ProviderStoryRuntime
} from "./story-mutation-runtime.js";
import {
  providerOutcomeAcknowledged,
  providerOutcomeUnknown,
  receiptOnlyProviderError,
  requireMatchingAcknowledgedProviderReceipt,
  requireMatchingProviderReceipt
} from "./story-provider-receipt.js";
import {
  commitPreparedStoryTransaction,
  commitReceiptOnlyStoryTransaction,
  corruptStoryReceipt,
  hashStoryManifest,
  requireFreshStoryMutation,
  prepareReceiptOnlyStoryError,
  storyIdFromScope,
  StoryMutationRecovery,
  storyResult,
  timestamp,
  type StoryMutationClock,
  type StoryMutationHooks
} from "./story-mutation-transaction.js";
import { reduceStoryV6 } from "./story-v6-reducer.js";
import type { StoryStore } from "./stories.js";

export interface ProviderStoryMutationCommit<Value> {
  readonly story: Story;
  readonly result: Extract<MutationResult, { kind: "story" }>;
  readonly value: Value;
}

export class StoryProviderMutationStore {
  constructor(
    private readonly stories: StoryStore,
    private readonly coordinator: MutationCoordinator,
    private readonly ledger: MutationLedgerStore,
    private readonly recovery: StoryMutationRecovery,
    private readonly now: StoryMutationClock,
    private readonly hooks: StoryMutationHooks = {}
  ) {}

  /** Three short ADR 006 claims: admission, durable provider start, terminal
   * publication. Provider preparation and streaming run between them, so local
   * edits remain available while the model is working. */
  async run<Value>(
    input: unknown,
    method: ProviderMutationMethod,
    work: (
      stories: ProviderStoryRuntime,
      providerStarted: () => Promise<void>
    ) => Promise<Value>,
    replayValue: () => Value
  ): Promise<ProviderStoryMutationCommit<Value>> {
    const admitted = await this.coordinator.runStory(input, async (request) => {
      const storyId = storyIdFromScope(request.scope);
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      requireFreshStoryMutation(receipt, request.mutationId, this.now);
      if (receipt.acknowledged !== null) {
        requireMatchingAcknowledgedProviderReceipt(receipt, request, method);
        throw providerOutcomeAcknowledged(request.mutationId);
      }
      requireMatchingProviderReceipt(receipt, request, method);

      const opened = await this.open(storyId, request, method, receipt, replayValue);
      return { request, storyId, opened };
    });
    if (admitted.opened.kind === "replayed") {
      return admitted.opened.commit;
    }

    const { request, storyId } = admitted;
    const { story } = admitted.opened;
    const runtime = new ScopedProviderStoryRuntime(story);
    let started: StartedMutationRecord | null = null;
    let startedPromise: Promise<StartedMutationRecord> | null = null;
    const startProvider = async (): Promise<void> => {
      startedPromise ??= this.coordinator.runStoryPhase(
        request,
        async () => await this.publishStarted(storyId, request, method)
      );
      started = await startedPromise;
    };

    let value: Value;
    try {
      value = await work(runtime, startProvider);
    } catch (error) {
      await this.recordFailure(storyId, request, method, started, error);
      throw error;
    }
    if (started === null && runtime.didSave) await startProvider();
    if (started === null) {
      return await this.coordinator.runStoryPhase(request, async () =>
        await this.stories.withAggregateSession(storyId, async (session) => ({
          story: await session.loadLive(),
          result: storyResult(session.snapshot.manifest),
          value
        }))
      );
    }
    if (!runtime.didSave || runtime.effect === null) {
      throw providerOutcomeUnknown(request.mutationId);
    }

    try {
      const committed = await this.coordinator.runStoryPhase(
        request,
        async () => await this.commitTerminal(
          storyId,
          request,
          method,
          started!,
          runtime
        )
      );
      return { ...committed, value };
    } catch (error) {
      if (error instanceof ServiceError && error.code === "resource_busy") {
        throw providerOutcomeUnknown(request.mutationId);
      }
      throw error;
    }
  }

  /** Recovery, idempotency and version admission, all before provider bytes. */
  private async open<Value>(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    receipt: StoryMutationReceipt,
    replayValue: () => Value
  ): Promise<
    | { kind: "replayed"; commit: ProviderStoryMutationCommit<Value> }
    | { kind: "open"; story: Story }
  > {
    return await this.stories.withAggregateSession(storyId, async (session) => {
      await this.recovery.finalizeAggregateTransaction(session, request.mutationId);
      const terminal = await this.recovery.recover(session, request, receipt);
      if (terminal !== null) {
        return {
          kind: "replayed",
          commit: {
            story: await session.loadLive(),
            result: terminal,
            value: replayValue()
          }
        };
      }
      const current = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      requireMatchingProviderReceipt(current, request, method);
      const unresolved = session.snapshot.manifest.unresolvedProvider;
      if (unresolved !== null) {
        throw providerOutcomeUnknown(unresolved.mutationId);
      }
      if (current.started !== null) {
        throw providerOutcomeUnknown(request.mutationId);
      }
      requireExpectedStoryVersion(
        session.snapshot,
        request.expectedAggregateVersion
      );
      return { kind: "open", story: await session.loadLive() };
    });
  }

  /** ADR 006 installs the unresolved-provider pointer durably before network
   * bytes, so this reacquires the session for exactly that publication. */
  private async publishStarted(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod
  ): Promise<StartedMutationRecord> {
    return await this.stories.withAggregateSession(storyId, async (session) => {
      await this.recovery.finalizeAggregateTransaction(
        session,
        request.mutationId
      );
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      requireMatchingProviderReceipt(receipt, request, method);
      if (receipt.started !== null) {
        throw providerOutcomeUnknown(request.mutationId);
      }
      const unresolved = session.snapshot.manifest.unresolvedProvider;
      if (unresolved !== null) {
        throw providerOutcomeUnknown(unresolved.mutationId);
      }
      if (session.snapshot.manifest.kind !== "live") {
        throw new GenerationResultError(
          409,
          "The story was deleted before provider work began."
        );
      }
      const oldStateHash = session.snapshot.manifestHash;
      const record: StartedMutationRecord = {
        schema: 1,
        kind: "started",
        aggregateKey: request.scope,
        mutationId: request.mutationId,
        fingerprintHash: request.fingerprint,
        method,
        oldStateHash,
        createdAt: timestamp(this.now)
      };
      const manifest = reduceStoryV6({
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: oldStateHash
      }, {
        kind: "provider-started",
        expectedManifestHash: oldStateHash,
        provider: {
          mutationId: request.mutationId,
          fingerprintHash: request.fingerprint
        }
      });
      if (manifest === null) {
        throw new Error("Provider start removed its story aggregate");
      }
      await session.stageManifest(manifest);
      try {
        await this.ledger.writeStoryRecord(record);
      } catch (error) {
        await session.discardStagedManifest().catch(() => undefined);
        throw error;
      }
      await session.publishStagedManifest();
      return record;
    });
  }

  private async recordFailure(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord | null,
    error: unknown
  ): Promise<void> {
    if (started !== null) {
      if (!isDefinitiveProviderFailure(error)) return;
      try {
        await this.coordinator.runStoryPhase(request, async () =>
          await this.commitTerminalError(storyId, request, method, started)
        );
      } catch (terminalError) {
        if (terminalError instanceof ServiceError
          && terminalError.code === "resource_busy") {
          throw providerOutcomeUnknown(request.mutationId);
        }
        throw terminalError;
      }
      return;
    }
    const code = receiptOnlyProviderError(error);
    if (code === null) return;
    await this.coordinator.runStoryPhase(request, async () =>
      await this.stories.withAggregateSession(storyId, async (session) => {
        await commitReceiptOnlyStoryTransaction(
          this.ledger,
          prepareReceiptOnlyStoryError(
            method,
            request,
            session,
            code,
            timestamp(this.now)
          ),
          this.now,
          this.hooks
        );
      })
    );
  }

  private async commitTerminal(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord,
    runtime: ScopedProviderStoryRuntime
  ): Promise<Pick<ProviderStoryMutationCommit<never>, "story" | "result">> {
    return await this.stories.withAggregateSession(storyId, async (session) => {
      await this.prepareTerminalPhase(session, request, method, started);
      if (session.snapshot.manifest.kind !== "live") {
        throw providerOutcomeUnknown(request.mutationId);
      }
      const effect = runtime.effect;
      if (effect === null) throw providerOutcomeUnknown(request.mutationId);
      const story = await session.loadLive();
      try {
        await applyProviderStoryEffect(
          story,
          effect,
          async (current, nodeId) => await session.hydratePath(current, nodeId)
        );
        const result = await this.commitTerminalOutcome(
          session,
          request,
          method,
          started,
          story
        );
        return { story, result };
      } catch (error) {
        const terminal = terminalProviderConflict(error);
        if (terminal === null) throw error;
        await this.commitTerminalOutcome(
          session,
          request,
          method,
          started,
          null
        );
        throw terminal;
      }
    });
  }

  private async commitTerminalError(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord
  ): Promise<void> {
    await this.stories.withAggregateSession(storyId, async (session) => {
      await this.prepareTerminalPhase(session, request, method, started);
      await this.commitTerminalOutcome(
        session,
        request,
        method,
        started,
        null
      );
    });
  }

  private async prepareTerminalPhase(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord
  ): Promise<void> {
    await this.recovery.finalizeAggregateTransaction(
      session,
      request.mutationId
    );
    const receipt = await this.ledger.loadStoryReceipt(
      request.scope,
      request.mutationId
    );
    requireMatchingProviderReceipt(receipt, request, method);
    if (receipt.started === null
      || hashStartedMutationRecord(receipt.started)
        !== hashStartedMutationRecord(started)) {
      throw corruptStoryReceipt(request.mutationId);
    }
    const unresolved = session.snapshot.manifest.unresolvedProvider;
    if (unresolved === null
      || unresolved.mutationId !== request.mutationId
      || unresolved.fingerprintHash !== request.fingerprint) {
      throw corruptStoryReceipt(request.mutationId);
    }
  }

  private async commitTerminalOutcome(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord,
    story: Story | null
  ): Promise<Extract<MutationResult, { kind: "story" }>> {
    const oldStateHash = session.snapshot.manifestHash;
    const replacement = story === null
      ? null
      : await session.prepareContent(story);
    const provider = {
      mutationId: request.mutationId,
      fingerprintHash: request.fingerprint
    } as const;
    const manifest = reduceStoryV6({
      kind: "present",
      manifest: session.snapshot.manifest,
      manifestHash: oldStateHash
    }, {
      kind: "provider-terminal-prepared",
      expectedManifestHash: oldStateHash,
      provider,
      outcome: replacement === null
        ? { kind: "error" }
        : {
          kind: "success",
          content: replacement.content,
          summary: replacement.summary
        }
    });
    if (manifest === null) {
      throw new Error("Provider terminal transition removed its story aggregate");
    }
    const prepared: PreparedUserMutationRecord = {
      schema: 1,
      kind: "prepared",
      purpose: "mutation",
      aggregateKey: request.scope,
      key: request.mutationId,
      fingerprintHash: request.fingerprint,
      method,
      oldStateHash,
      newStateHash: hashStoryManifest(manifest),
      startedRecordHash: hashStartedMutationRecord(started),
      result: replacement !== null
        ? storyResult(manifest)
        : {
          kind: "error",
          code: "provider_failure",
          aggregateVersion: {
            kind: "story",
            revision: manifest.revision
          }
        },
      preparedAt: timestamp(this.now)
    };
    await commitPreparedStoryTransaction({
      session,
      ledger: this.ledger,
      manifest,
      prepared,
      now: this.now,
      hooks: this.hooks
    });
    return storyResult(manifest);
  }
}

function terminalProviderConflict(
  error: unknown
): GenerationResultError | null {
  if (error instanceof GenerationResultError) return error;
  if (error instanceof ServiceError && error.status >= 400
    && error.status < 500) {
    return new GenerationResultError(error.status, error.message);
  }
  return null;
}
