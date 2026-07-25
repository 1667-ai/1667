import type { Story } from "../shared/types.js";
import {
  isDefinitiveProviderFailure,
  ProviderError,
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
import {
  isPreparedDomainError,
  type PreparedDomainError
} from "./mutation-ledger-types.js";
import { requireExpectedStoryVersion } from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import {
  captureStoryBaseline,
  deriveStoryDelta,
  rebaseStoryDelta,
  type StoryBaseline
} from "./story-generation-rebase.js";
import {
  ScopedProviderStoryRuntime,
  type ProviderStoryRuntime
} from "./story-mutation-runtime.js";
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

  /** ADR 006 holds the story scope for the whole call, so no other mutation
   * interleaves. The aggregate session is a separate lock that serializes
   * story file I/O against readers, so it is released across the provider
   * round-trip and reacquired to commit; otherwise every read of the story
   * waits out the generation. */
  async run<Value>(
    input: unknown,
    method: ProviderMutationMethod,
    work: (
      stories: ProviderStoryRuntime,
      providerStarted: () => Promise<void>
    ) => Promise<Value>,
    replayValue: () => Value
  ): Promise<ProviderStoryMutationCommit<Value>> {
    return await this.coordinator.runStory(input, async (request) => {
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
      if (opened.kind === "replayed") return opened.commit;
      const { story, baseline } = opened;
      const runtime = new ScopedProviderStoryRuntime(story);
      let started: StartedMutationRecord | null = null;
      const startProvider = async (): Promise<void> => {
        if (started === null) started = await this.publishStarted(storyId, request, method);
      };

      let value: Value;
      try {
        value = await work(runtime, startProvider);
      } catch (error) {
        await this.recordFailure(
          storyId,
          request,
          method,
          started,
          runtime,
          baseline,
          error
        );
        throw error;
      }
      if (started === null && runtime.didSave) await startProvider();
      if (started === null) {
        const result = await this.stories.withAggregateSession(
          storyId,
          async (session) => storyResult(session.snapshot.manifest)
        );
        return { story, result, value };
      }
      if (!runtime.didSave) throw providerOutcomeUnknown(request.mutationId);
      const terminal = started;
      let result: Extract<MutationResult, { kind: "story" }>;
      try {
        result = await this.stories.withAggregateSession(
          storyId,
          async (session) => await this.commitTerminal(
            session,
            request,
            method,
            terminal,
            runtime,
            baseline,
            "success"
          )
        );
      } catch (error) {
        if (error instanceof ProviderError) {
          await this.stories.withAggregateSession(storyId, async (session) => {
            await this.commitTerminal(
              session,
              request,
              method,
              terminal,
              runtime,
              baseline,
              "error"
            );
          });
        }
        throw error;
      }
      return { story, result, value };
    });
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
    | { kind: "open"; story: Story; baseline: StoryBaseline }
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
      const story = await session.loadLive();
      return {
        kind: "open",
        story,
        baseline: captureStoryBaseline(story)
      };
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
    runtime: ScopedProviderStoryRuntime,
    baseline: StoryBaseline,
    error: unknown
  ): Promise<void> {
    if (started !== null) {
      if (!isDefinitiveProviderFailure(error)) return;
      await this.stories.withAggregateSession(storyId, async (session) => {
        await this.commitTerminal(
          session,
          request,
          method,
          started,
          runtime,
          baseline,
          "error"
        );
      });
      return;
    }
    const code = receiptOnlyProviderError(error);
    if (code === null) return;
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
    });
  }

  private async commitTerminal(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord,
    runtime: ScopedProviderStoryRuntime,
    baseline: StoryBaseline,
    outcome: "success" | "error"
  ): Promise<Extract<MutationResult, { kind: "story" }>> {
    const oldStateHash = session.snapshot.manifestHash;
    const draft = outcome === "success"
      ? await runtime.loadForMutation(storyIdFromScope(request.scope))
      : null;
    const rebased = draft === null
      ? null
      : rebaseStoryDelta(
        await session.loadLive(),
        deriveStoryDelta(baseline, draft)
      );
    const replacement = rebased === null
      ? null
      : await session.prepareContent(rebased);
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
      result: outcome === "success"
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

function receiptOnlyProviderError(error: unknown): PreparedDomainError | null {
  if (error instanceof ProviderError) {
    return isDefinitiveProviderFailure(error) ? "provider_failure" : null;
  }
  if (!(error instanceof ServiceError) || !isPreparedDomainError(error.code)) {
    return null;
  }
  if (error.code === "provider_failure"
    && !isDefinitiveProviderFailure(error)) {
    return null;
  }
  return error.code;
}

function requireMatchingProviderReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: ProviderMutationMethod
): void {
  if (receipt.started !== null && (
    receipt.started.aggregateKey !== request.scope
    || receipt.started.mutationId !== request.mutationId
    || receipt.started.method !== method
    || receipt.started.fingerprintHash !== request.fingerprint
  )) {
    throw providerIdempotencyConflict();
  }
  if (receipt.prepared !== null) {
    if (receipt.prepared.purpose !== "mutation"
      || receipt.prepared.aggregateKey !== request.scope
      || receipt.prepared.key !== request.mutationId
      || receipt.prepared.method !== method
      || receipt.prepared.fingerprintHash !== request.fingerprint
      || (receipt.prepared.startedRecordHash === null
        && (receipt.prepared.result.kind !== "error"
          || receipt.prepared.oldStateHash !== receipt.prepared.newStateHash))) {
      throw providerIdempotencyConflict();
    }
  } else if (receipt.completed !== null || receipt.acknowledged !== null) {
    throw corruptStoryReceipt(request.mutationId);
  }
}

function requireMatchingAcknowledgedProviderReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: ProviderMutationMethod
): void {
  const started = receipt.started;
  const acknowledged = receipt.acknowledged;
  if (started === null || acknowledged === null
    || started.aggregateKey !== request.scope
    || started.mutationId !== request.mutationId
    || started.method !== method
    || started.fingerprintHash !== request.fingerprint
    || acknowledged.aggregateKey !== request.scope
    || acknowledged.mutationId !== request.mutationId
    || acknowledged.startedRecordHash !== hashStartedMutationRecord(started)
    || receipt.prepared !== null
    || receipt.completed !== null) {
    throw providerIdempotencyConflict();
  }
}

function providerIdempotencyConflict(): ServiceError {
  return new ServiceError(
    409,
    "Mutation ID was already used for different provider input.",
    "idempotency_conflict"
  );
}

function providerOutcomeUnknown(mutationId: string): ServiceError {
  return new ServiceError(
    409,
    `Provider outcome is unknown for mutation ${mutationId}; acknowledge it before continuing.`,
    "generation_outcome_unknown"
  );
}

function providerOutcomeAcknowledged(mutationId: string): ServiceError {
  return new ServiceError(
    409,
    `Provider outcome was acknowledged for mutation ${mutationId}.`,
    "generation_outcome_unknown_acknowledged"
  );
}
