import {
  DurableMutationResultError,
  ServiceError
} from "./errors.js";
import type {
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import {
  hashPreparedMutationRecord,
  hashStartedMutationRecord
} from "./mutation-ledger-codec.js";
import {
  MutationLedgerStore,
  type StoryMutationReceipt
} from "./mutation-ledger-store.js";
import {
  planMutationLedgerRecovery,
  type MutationLedgerRecoveryAction,
  type ProviderRecoveryEvidence,
  type ReplacementRecoveryEvidence
} from "./mutation-ledger-recovery.js";
import type {
  CompletedMutationRecord,
  MutationId,
  MutationResult,
  PreparedDomainError,
  PreparedRecord,
  PreparedUserMutationRecord
} from "./mutation-ledger-types.js";
import { requireFreshUnseenMutationId } from "./mutation-id-policy.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import { storyProjection } from "./story-aggregate-state.js";
import { hashStoryV6ManifestBytes } from "./story-manifest-hash.js";
import { formatV6 } from "./story-v6-codec.js";
import type { StoryManifestV6 } from "./story-v6-types.js";
import { StoryDurabilityError } from "./story-lifecycle.js";

export type StoryMutationClock = () => Date;

export interface StoryMutationHooks {
  readonly afterStage?: () => void | Promise<void>;
  readonly afterPrepared?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
  readonly afterAcknowledged?: () => void | Promise<void>;
  readonly afterCompleted?: () => void | Promise<void>;
}

/** Test-only crash marker: unlike ordinary failures, injected process loss
 * deliberately preserves durable residue for the next store instance. */
export class InjectedStoryMutationCrash extends Error {
  constructor(readonly point: string) {
    super(`Injected story mutation crash after ${point}`);
    this.name = "InjectedStoryMutationCrash";
  }
}

export interface PreparedStoryTransaction {
  readonly session: StoryAggregateSession;
  readonly ledger: MutationLedgerStore;
  readonly manifest: StoryManifestV6;
  readonly prepared: PreparedRecord;
  readonly now: StoryMutationClock;
  readonly hooks?: StoryMutationHooks;
  readonly afterPublish?: () => void | Promise<void>;
}

/** One write-side implementation of ADR-006's prepared/state/terminal order. */
export async function commitPreparedStoryTransaction(
  transaction: PreparedStoryTransaction
): Promise<void> {
  const hooks = transaction.hooks ?? {};
  await transaction.session.stageManifest(transaction.manifest);
  await hooks.afterStage?.();
  try {
    await transaction.ledger.writeStoryRecord(transaction.prepared);
    await hooks.afterPrepared?.();
  } catch (error) {
    if (!(error instanceof InjectedStoryMutationCrash)) {
      await transaction.session.discardStagedManifest().catch(() => undefined);
    }
    throw error;
  }

  let published = false;
  try {
    await transaction.session.publishStagedManifest();
    published = true;
    await hooks.afterPublish?.();
    await transaction.afterPublish?.();
    await transaction.ledger.writeStoryRecord(
      completedRecord(transaction.prepared, timestamp(transaction.now))
    );
    await hooks.afterCompleted?.();
  } catch (error) {
    if (error instanceof InjectedStoryMutationCrash
      || error instanceof StoryDurabilityError
      || !published) {
      throw error;
    }
    throw new StoryDurabilityError(
      `Story mutation ${transaction.prepared.key} committed but its terminal evidence is incomplete`,
      { cause: error }
    );
  }
}

export async function commitReceiptOnlyStoryTransaction(
  ledger: MutationLedgerStore,
  prepared: PreparedRecord,
  now: StoryMutationClock,
  hooks: StoryMutationHooks = {}
): Promise<void> {
  let preparedWritten = false;
  try {
    await ledger.writeStoryRecord(prepared);
    preparedWritten = true;
    await hooks.afterPrepared?.();
    await ledger.writeStoryRecord(completedRecord(prepared, timestamp(now)));
    await hooks.afterCompleted?.();
  } catch (error) {
    if (error instanceof InjectedStoryMutationCrash
      || error instanceof StoryDurabilityError
      || !preparedWritten) {
      throw error;
    }
    throw new StoryDurabilityError(
      `Story mutation ${prepared.key} has durable receipt authority but incomplete terminal evidence`,
      { cause: error }
    );
  }
}

export function prepareReceiptOnlyStoryError(
  method: PreparedUserMutationRecord["method"],
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  session: StoryAggregateSession,
  code: PreparedDomainError,
  preparedAt: string
): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: request.scope,
    key: request.mutationId,
    fingerprintHash: request.fingerprint,
    method,
    oldStateHash: session.snapshot.manifestHash,
    newStateHash: session.snapshot.manifestHash,
    startedRecordHash: null,
    result: {
      kind: "error",
      code,
      aggregateVersion: {
        kind: "story",
        revision: session.snapshot.manifest.revision
      }
    },
    preparedAt
  };
}

export function prepareReceiptOnlyStorySuccess(
  method: PreparedUserMutationRecord["method"],
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  session: StoryAggregateSession,
  preparedAt: string
): PreparedUserMutationRecord & {
  readonly result: Extract<MutationResult, { kind: "story" }>;
} {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: request.scope,
    key: request.mutationId,
    fingerprintHash: request.fingerprint,
    method,
    oldStateHash: session.snapshot.manifestHash,
    newStateHash: session.snapshot.manifestHash,
    startedRecordHash: null,
    result: storyResult(session.snapshot.manifest),
    preparedAt
  };
}

export class StoryMutationRecovery {
  constructor(
    private readonly ledger: MutationLedgerStore,
    private readonly now: StoryMutationClock
  ) {}

  async recover(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    receipt: StoryMutationReceipt,
    originalProvider: ProviderRecoveryEvidence | null = null,
    surfaceTerminal = true
  ): Promise<Extract<MutationResult, { kind: "story" }> | null> {
    const staged = await session.readStagedManifest();
    const unresolvedProvider = await this.loadProviderEvidence(
      request.scope,
      session.snapshot.manifest.unresolvedProvider?.mutationId ?? null
    );
    const plan = planMutationLedgerRecovery({
      aggregateKey: request.scope,
      aggregate: {
        stateHash: session.snapshot.manifestHash,
        state: session.snapshot.projection,
        lastTransaction: session.snapshot.manifest.lastTransaction,
        unresolvedProvider: session.snapshot.manifest.unresolvedProvider
      },
      transaction: {
        key: request.mutationId,
        started: receipt.started,
        prepared: receipt.prepared,
        completed: receipt.completed,
        replacement: replacementEvidence(staged)
      },
      unresolvedProvider,
      originalProvider,
      recoveredAt: timestamp(this.now)
    });
    await this.apply(session, request, plan.actions);

    if (!surfaceTerminal) return null;
    if (receipt.prepared === null) return null;
    const completed = receipt.completed !== null
      || plan.actions.some((action) => action.kind === "write-completed");
    if (!completed) return null;
    if (receipt.prepared.result.kind === "error") {
      throw new DurableMutationResultError(
        409,
        `Story mutation previously completed with ${receipt.prepared.result.code}.`,
        receipt.prepared.result.code
      );
    }
    if (receipt.prepared.result.kind !== "story") {
      throw corruptStoryReceipt(request.mutationId);
    }
    return receipt.prepared.result;
  }

  async finalizeAggregateTransaction(
    session: StoryAggregateSession,
    currentMutationId: MutationId | null
  ): Promise<void> {
    const pointer = session.snapshot.manifest.lastTransaction;
    if (pointer === null
      || pointer.receiptKind !== "user"
      || pointer.phase !== "prepared"
      || (currentMutationId !== null
        && pointer.mutationId === currentMutationId)) {
      return;
    }
    const aggregateKey = `story:${session.storyId}` as const;
    const receipt = await this.ledger.loadStoryReceipt(
      aggregateKey,
      pointer.mutationId
    );
    const prepared = receipt.prepared;
    if (prepared === null) throw corruptStoryReceipt(pointer.mutationId);
    let originalProvider: ProviderRecoveryEvidence | null = null;
    if (prepared.purpose === "provider-acknowledgement") {
      const original = await this.ledger.loadStoryReceipt(
        aggregateKey,
        prepared.originalProviderMutationId
      );
      if (original.started === null) {
        throw corruptStoryReceipt(prepared.originalProviderMutationId);
      }
      originalProvider = {
        started: original.started,
        acknowledged: original.acknowledged
      };
    }
    await this.recover(
      session,
      {
        transportOperationId: "aggregate-transaction-recovery",
        mutationId: pointer.mutationId,
        fingerprint: prepared.fingerprintHash,
        scope: aggregateKey,
        expectedAggregateVersion: session.snapshot.storageKind === "v5"
          ? { kind: "v5", manifestHash: session.snapshot.manifestHash }
          : { kind: "v6", revision: session.snapshot.manifest.revision }
      },
      receipt,
      originalProvider,
      false
    );
  }

  private async loadProviderEvidence(
    aggregateKey: `story:${string}`,
    mutationId: MutationId | null
  ): Promise<ProviderRecoveryEvidence | null> {
    if (mutationId === null) return null;
    const receipt = await this.ledger.loadStoryReceipt(aggregateKey, mutationId);
    if (receipt.started === null) throw corruptStoryReceipt(mutationId);
    return {
      started: receipt.started,
      acknowledged: receipt.acknowledged
    };
  }

  private async apply(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    actions: readonly MutationLedgerRecoveryAction[]
  ): Promise<void> {
    for (const action of actions) {
      if (action.kind === "discard-replacement") {
        await session.discardStagedManifest();
      } else if (action.kind === "discard-record"
        && action.recordKind === "prepared") {
        const receipt = await this.ledger.loadStoryReceipt(
          request.scope,
          request.mutationId
        );
        if (receipt.prepared === null) {
          throw corruptStoryReceipt(request.mutationId);
        }
        await this.ledger.removeOrphanPreparedUserReceipt(
          request.scope,
          request.mutationId,
          hashPreparedMutationRecord(receipt.prepared)
        );
      } else if (action.kind === "write-completed"
        || action.kind === "write-acknowledged") {
        await this.ledger.writeStoryRecord(action.record);
      } else if (action.kind === "discard-record"
        && action.recordKind === "started") {
        const receipt = await this.ledger.loadStoryReceipt(
          request.scope,
          request.mutationId
        );
        if (receipt.started === null) {
          throw corruptStoryReceipt(request.mutationId);
        }
        await this.ledger.removeOrphanStartedStoryReceipt(
          request.scope,
          request.mutationId,
          hashStartedMutationRecord(receipt.started)
        );
      } else if (action.kind === "discard-record") {
        throw corruptStoryReceipt(request.mutationId);
      }
    }
  }
}

export function completedRecord(
  prepared: PreparedRecord,
  completedAt: string
): CompletedMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: prepared.aggregateKey,
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt
  };
}

export function storyResult(
  manifest: StoryManifestV6
): Extract<MutationResult, { kind: "story" }> {
  return {
    kind: "story",
    storyId: manifest.id,
    storyRevision: manifest.revision,
    summary: manifest.kind === "live" ? manifest.summary : null
  };
}

export function hashStoryManifest(manifest: StoryManifestV6): string {
  return hashStoryV6ManifestBytes(Buffer.from(formatV6(manifest), "utf8"));
}

export function storyIdFromScope(scope: `story:${string}`): string {
  return scope.slice("story:".length);
}

export function corruptStoryReceipt(mutationId: string): ServiceError {
  return new ServiceError(
    500,
    `Story mutation receipt is corrupt: ${mutationId}`,
    "internal"
  );
}

export function requireFreshStoryMutation(
  receipt: StoryMutationReceipt,
  mutationId: MutationId,
  now: StoryMutationClock
): void {
  if (receipt.started === null && receipt.prepared === null
    && receipt.completed === null && receipt.acknowledged === null) {
    requireFreshUnseenMutationId(mutationId, now().getTime());
  }
}

export function timestamp(now: StoryMutationClock): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Story mutation clock returned an invalid date");
  }
  return value.toISOString();
}

function replacementEvidence(
  manifest: StoryManifestV6 | null
): ReplacementRecoveryEvidence | null {
  if (manifest === null) return null;
  return {
    stateHash: hashStoryManifest(manifest),
    oldStateHash: manifest.previousManifestHash ?? "absent",
    state: storyProjection(manifest)
  };
}
