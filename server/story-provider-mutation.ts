import type { Story } from "../shared/types.js";
import {
  GenerationResultError,
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
  PreparedDomainError,
  PreparedUserMutationRecord,
  ProviderMutationMethod,
  StartedMutationRecord
} from "./mutation-ledger-types.js";
import {
  requireExpectedStoryVersion
} from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import type { ActiveProviderStarts } from "./story-provider-active-starts.js";
import type {
  ProviderStoryAdmission, ProviderStoryMutationCommit, ProviderStoryWork
} from "./story-provider-contract.js";
import { applyProviderStoryEffect } from "./story-provider-effect.js";
import {
  ScopedProviderStoryRuntime
} from "./story-mutation-runtime.js";
import {
  providerOutcomeAcknowledged,
  providerOutcomeUnknown,
  requireMatchingAcknowledgedProviderReceipt,
  requireMatchingProviderReceipt,
  terminalProviderConflict
} from "./story-provider-receipt.js";
import { runTerminalStoryPhase } from "./story-provider-phase.js";
import {
  ProviderTerminalReplay,
  StoryProviderRaceResolver
} from "./story-provider-race.js";
import {
  commitPreparedStoryTransaction,
  corruptStoryReceipt,
  hashStoryManifest,
  requireFreshStoryMutation,
  storyIdFromScope,
  StoryMutationRecovery,
  storyResult,
  timestamp,
  type StoryMutationClock,
  type StoryMutationHooks
} from "./story-mutation-transaction.js";
import { reduceStoryV6 } from "./story-v6-reducer.js";
import type { StoryStore } from "./stories.js";

export class StoryProviderMutationStore {
  private readonly races: StoryProviderRaceResolver;

  constructor(
    private readonly stories: StoryStore,
    private readonly coordinator: MutationCoordinator,
    private readonly ledger: MutationLedgerStore,
    private readonly recovery: StoryMutationRecovery,
    private readonly activeStarts: ActiveProviderStarts,
    private readonly now: StoryMutationClock,
    private readonly hooks: StoryMutationHooks = {}
  ) {
    this.races = new StoryProviderRaceResolver(
      stories,
      coordinator,
      ledger,
      recovery,
      now,
      hooks
    );
  }

  /** Three short ADR 006 claims: admission, durable provider start, terminal
   * publication. Provider preparation and streaming run between them, so local
   * edits remain available while the model is working. */
  async run<Method extends ProviderMutationMethod, Value>(
    input: unknown,
    method: Method,
    work: ProviderStoryWork<Method, Value>,
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
    const { story, releaseSnapshot } = admitted.opened;
    try {
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
        if (error instanceof ProviderTerminalReplay) {
          return await this.races.replayTerminalSuccess(
            storyId,
            request,
            method,
            replayValue
          );
        }
        try {
          await this.races.recordFailure(
            storyId,
            request,
            method,
            started,
            error,
            async (record, code) => await this.commitTerminalError(
              storyId,
              request,
              method,
              record,
              code
            )
          );
        } catch (failure) {
          if (failure instanceof ProviderTerminalReplay) {
            return await this.races.replayTerminalSuccess(
              storyId,
              request,
              method,
              replayValue
            );
          }
          throw failure;
        }
        throw error;
      }
      if (started === null && runtime.effect !== null) await startProvider();
      if (started === null) {
        return await this.coordinator.runStoryPhase(request, async () =>
          await this.stories.withAggregateSession(storyId, async (session) => ({
            story: await session.loadLive(),
            result: storyResult(session.snapshot.manifest),
            value
          }))
        );
      }
      if (runtime.effect === null) {
        throw providerOutcomeUnknown(request.mutationId);
      }

      try {
        const committed = await runTerminalStoryPhase(
          this.coordinator,
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
    } finally {
      releaseSnapshot();
    }
  }

  /** Recovery, idempotency and version admission, all before provider bytes. */
  private async open<Value>(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    receipt: StoryMutationReceipt,
    replayValue: () => Value
  ): Promise<ProviderStoryAdmission<Value>> {
    const pin: { release: (() => void) | null } = { release: null };
    try {
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
        const story = await session.loadLive();
        pin.release = this.activeStarts.pinSnapshot(
          this.stories,
          session,
          request.mutationId
        );
        return {
          kind: "open",
          story,
          releaseSnapshot: pin.release
        };
      });
    } catch (error) {
      pin.release?.();
      throw error;
    }
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
      if (receipt.prepared !== null) {
        const terminal = await this.recovery.recover(session, request, receipt);
        if (terminal !== null) throw new ProviderTerminalReplay();
        throw providerOutcomeUnknown(request.mutationId);
      }
      if (receipt.started !== null) throw providerOutcomeUnknown(request.mutationId);
      const unresolved = session.snapshot.manifest.unresolvedProvider;
      if (unresolved !== null) throw providerOutcomeUnknown(unresolved.mutationId);
      if (session.snapshot.manifest.kind !== "live") {
        throw new GenerationResultError(
          409,
          "The story was deleted before provider work began."
        );
      }
      this.activeStarts.remember(
        storyId,
        request.mutationId,
        session.snapshot
      );
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
          { kind: "success", story }
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
          { kind: "error", code: terminal.code }
        );
        throw terminal.error;
      }
    });
  }

  private async commitTerminalError(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord,
    code: PreparedDomainError
  ): Promise<void> {
    await this.stories.withAggregateSession(storyId, async (session) => {
      await this.prepareTerminalPhase(session, request, method, started);
      await this.commitTerminalOutcome(
        session,
        request,
        method,
        started,
        { kind: "error", code }
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
    outcome:
      | { kind: "success"; story: Story }
      | { kind: "error"; code: PreparedDomainError }
  ): Promise<Extract<MutationResult, { kind: "story" }>> {
    const oldStateHash = session.snapshot.manifestHash;
    const replacement = outcome.kind === "success"
      ? await session.prepareContent(outcome.story)
      : null;
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
      result: outcome.kind === "success"
        ? storyResult(manifest)
        : {
          kind: "error",
          code: outcome.code,
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
