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
import {
  hashStoryV6ManifestBytes,
  hashStoryV8ManifestBytes,
  hashStoryV10ManifestBytes,
  hashStoryV12ManifestBytes,
  hashStoryV14ManifestBytes,
  hashStoryV16ManifestBytes
} from "./story-manifest-hash.js";
import { canonicalJson } from "./canonical-json.js";
import {
  formatV6,
  formatV8,
  formatV10,
  formatV12,
  formatV14,
  formatV16,
  STORY_SCHEMA_VERSION_V8,
  STORY_SCHEMA_VERSION_V10,
  STORY_SCHEMA_VERSION_V12,
  STORY_SCHEMA_VERSION_V14,
  STORY_SCHEMA_VERSION_V16
} from "./story-v6-codec.js";
import type { StoryEnvelopeManifest } from "./story-v6-types.js";
import { StoryDurabilityError } from "./story-lifecycle.js";

export type StoryMutationClock = () => Date;

export interface StoryMutationHooks {
  /** Test-only failure window after a prepared receipt is durable and before
   * the replacement stage is attempted. A real process loss in this window
   * leaves the receipt for exact recovery; a returned failure can prove that
   * no stage materialized and clean it immediately. */
  readonly afterPreparedBeforeStage?: () => void | Promise<void>;
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
  readonly manifest: StoryEnvelopeManifest;
  readonly prepared: PreparedRecord;
  /** Persist identity before staging when recovery must distinguish an
   * unowned replacement from this mutation's replacement. */
  readonly prepareBeforeStage?: boolean;
  readonly now: StoryMutationClock;
  readonly hooks?: StoryMutationHooks;
  readonly afterPublish?: () => void | Promise<void>;
}

interface StoryRecoveryOptions {
  /** Aggregate-pointer finalization must not treat a replacement staged for a
   * different mutation as its own evidence. The active request recovers that
   * stage in its normal direct-lookup pass. */
  readonly ignoreForeignReplacement?: boolean;
}

interface DiscardedClearReceiptEvidence {
  readonly mutationId: MutationId;
  readonly preparedRecordHash: string;
}

/** Shared stage step for both durability tiers. An afterStage failure always
 * propagates with the staged replacement left in place: staged residue is
 * owned by recovery in both tiers, so the crash surface stays identical. */
async function stageManifestForCommit(
  session: StoryAggregateSession,
  manifest: StoryEnvelopeManifest,
  hooks: StoryMutationHooks
): Promise<void> {
  await session.stageManifest(manifest);
  await hooks.afterStage?.();
}

/** Shared publish step for both durability tiers. `onVisible` runs the
 * moment the rename lands, before the afterPublish hook can fail, so the
 * full tier can classify later errors as post-commit. */
async function publishStagedManifestForCommit(
  session: StoryAggregateSession,
  hooks: StoryMutationHooks,
  onVisible?: () => void
): Promise<void> {
  await session.publishStagedManifest();
  onVisible?.();
  await hooks.afterPublish?.();
}

/** One write-side implementation of the prepared/state/terminal order: the
 * shared stage/publish core, extended with the ledger prepared record before
 * the publish and the completed record after it. */
export async function commitPreparedStoryTransaction(
  transaction: PreparedStoryTransaction
): Promise<void> {
  const hooks = transaction.hooks ?? {};
  if (transaction.prepareBeforeStage === true) {
    if (transaction.prepared.purpose === "mutation"
      && transaction.prepared.method === "clearAside") {
      // Publish the fixed per-story candidate before the receipt. A process
      // loss between these writes leaves a harmless marker that recovery can
      // remove; the reverse order could leave an undiscoverable receipt.
      await transaction.ledger.writeClearRecoveryCandidate(
        transaction.prepared.aggregateKey as `story:${string}`,
        transaction.prepared.key,
        hashPreparedMutationRecord(transaction.prepared)
      );
    }
    await transaction.ledger.writeStoryRecord(transaction.prepared);
    try {
      await hooks.afterPreparedBeforeStage?.();
      await stageManifestForCommit(transaction.session, transaction.manifest, hooks);
      await hooks.afterPrepared?.();
    } catch (error) {
      if (!(error instanceof InjectedStoryMutationCrash)) {
        await discardUnmaterializedPreparedRecord(transaction);
      }
      throw error;
    }
  } else {
    await stageManifestForCommit(transaction.session, transaction.manifest, hooks);
    try {
      await transaction.ledger.writeStoryRecord(transaction.prepared);
      await hooks.afterPrepared?.();
    } catch (error) {
      if (!(error instanceof InjectedStoryMutationCrash)) {
        await transaction.session.discardStagedManifest().catch(() => undefined);
      }
      throw error;
    }
  }

  let published = false;
  try {
    await publishStagedManifestForCommit(
      transaction.session,
      hooks,
      () => { published = true; }
    );
    await transaction.afterPublish?.();
    await transaction.ledger.writeStoryRecord(
      completedRecord(transaction.prepared, timestamp(transaction.now))
    );
    await hooks.afterCompleted?.();
    if (transaction.prepared.purpose === "mutation"
      && transaction.prepared.method === "clearAside") {
      await transaction.ledger.removeClearRecoveryCandidate(
        transaction.prepared.aggregateKey as `story:${string}`,
        transaction.prepared.key,
        hashPreparedMutationRecord(transaction.prepared)
      );
    }
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

/** Remove a prepared record only when this transaction has no materialized
 * replacement. A final `.next` whose transaction pointer names this request
 * remains recoverable and therefore retains the record; an unreadable stage
 * also fails closed. Provider prepared records retain their started fence. */
async function discardUnmaterializedPreparedRecord(
  transaction: PreparedStoryTransaction
): Promise<void> {
  if (transaction.prepared.purpose !== "mutation"
    || transaction.prepared.startedRecordHash !== null) {
    return;
  }
  let staged: StoryEnvelopeManifest | null;
  try {
    staged = await transaction.session.readStagedManifest();
  } catch {
    return;
  }
  if (staged?.lastTransaction?.mutationId === transaction.prepared.key) return;
  await transaction.ledger.removeOrphanPreparedUserReceipt(
    transaction.prepared.aggregateKey,
    transaction.prepared.key,
    hashPreparedMutationRecord(transaction.prepared)
  );
  if (transaction.prepared.method === "clearAside") {
    await transaction.ledger.removeClearRecoveryCandidate(
      transaction.prepared.aggregateKey as `story:${string}`,
      transaction.prepared.key,
      hashPreparedMutationRecord(transaction.prepared)
    );
  }
}

/**
 * Local-durability-tier commit: the shared stage/publish core with no ledger
 * extension. No record precedes or follows the manifest rename because the
 * published manifest carries no transaction pointer — a crash before the
 * rename leaves only a staged replacement that the next session discards,
 * and a crash after it leaves a complete aggregate.
 */
export async function commitManifestOnlyStoryTransaction(
  session: StoryAggregateSession,
  manifest: StoryEnvelopeManifest,
  hooks: StoryMutationHooks = {}
): Promise<void> {
  await stageManifestForCommit(session, manifest, hooks);
  await publishStagedManifestForCommit(session, hooks);
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

/** Receipt-only Clear commit for an already-empty Aside.
 *
 * The aggregate has no replacement to point at, but the request still needs a
 * durable replay result. The bounded per-story candidate makes every crash
 * window discoverable without scanning retained receipts. */
export async function commitNoopClearStoryTransaction(
  ledger: MutationLedgerStore,
  prepared: PreparedUserMutationRecord & {
    readonly result: Extract<MutationResult, { kind: "story" }>;
  },
  now: StoryMutationClock,
  hooks: StoryMutationHooks = {}
): Promise<void> {
  const aggregateKey = prepared.aggregateKey;
  if (aggregateKey === "settings") {
    throw new Error("No-op Clear receipt must target a story aggregate");
  }
  const preparedRecordHash = hashPreparedMutationRecord(prepared);
  await ledger.writeClearRecoveryCandidate(
    aggregateKey,
    prepared.key,
    preparedRecordHash
  );
  let preparedWritten = false;
  let completed = false;
  try {
    await ledger.writeStoryRecord(prepared);
    preparedWritten = true;
    await hooks.afterPrepared?.();
    await ledger.writeStoryRecord(
      completedRecord(prepared, timestamp(now))
    );
    completed = true;
    await hooks.afterCompleted?.();
    await ledger.removeClearRecoveryCandidate(
      aggregateKey,
      prepared.key,
      preparedRecordHash
    );
  } catch (error) {
    if (error instanceof InjectedStoryMutationCrash
      || error instanceof StoryDurabilityError
      || !preparedWritten
      || !completed) {
      throw error;
    }
    throw new StoryDurabilityError(
      `Story mutation ${prepared.key} committed but its Clear recovery index is incomplete`,
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

  /** Complete a prepared no-op Clear without re-running it.
   *
   * A no-op has no aggregate pointer. Its equal old/new hashes are the
   * durable proof that the prepared request changed no story state. Complete
   * that evidence even when the story now has a newer Side Note. */
  async recoverPreparedNoopClear(
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    receipt: StoryMutationReceipt
  ): Promise<Extract<MutationResult, { kind: "story" }>> {
    const prepared = receipt.prepared;
    if (prepared === null
      || receipt.started !== null
      || receipt.completed !== null
      || receipt.acknowledged !== null
      || prepared.purpose !== "mutation"
      || prepared.method !== "clearAside"
      || prepared.aggregateKey !== request.scope
      || prepared.key !== request.mutationId
      || prepared.fingerprintHash !== request.fingerprint
      || prepared.startedRecordHash !== null
      || prepared.oldStateHash !== prepared.newStateHash
      || prepared.result.kind !== "story") {
      throw corruptStoryReceipt(request.mutationId);
    }
    const preparedRecordHash = hashPreparedMutationRecord(prepared);
    await this.ledger.writeStoryRecord(
      completedRecord(prepared, timestamp(this.now))
    );
    await this.ledger.removeClearRecoveryCandidate(
      request.scope,
      request.mutationId,
      preparedRecordHash
    );
    return prepared.result;
  }

  async recover(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    receipt: StoryMutationReceipt,
    originalProvider: ProviderRecoveryEvidence | null = null,
    surfaceTerminal = true,
    options: StoryRecoveryOptions = {}
  ): Promise<Extract<MutationResult, { kind: "story" }> | null> {
    const staged = await session.readStagedManifest();
    const stagedPointer = staged?.lastTransaction;
    const replacement = options.ignoreForeignReplacement === true
      && (stagedPointer === null
        || stagedPointer === undefined
        || stagedPointer.receiptKind !== "user"
        || stagedPointer.mutationId !== request.mutationId)
      ? null
      : replacementEvidence(staged);
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
        replacement
      },
      unresolvedProvider,
      originalProvider,
      recoveredAt: timestamp(this.now)
    });
    const discardedClear = plan.actions.some((action) => action.kind === "discard-replacement")
      ? await this.discardedClearReceiptEvidence(
        session,
        request,
        replacement === null ? null : staged
      )
      : null;
    await this.apply(session, request, plan.actions);
    if (discardedClear !== null) {
      // The planner owns the active request's receipt. A foreign staged Clear
      // is not part of that request, so remove its hash-proved prepared
      // record here after discarding the stage. Exact same-ID recovery may
      // already have removed it; the direct cleanup is then a no-op.
      await this.ledger.removeOrphanPreparedUserReceipt(
        request.scope,
        discardedClear.mutationId,
        discardedClear.preparedRecordHash
      );
      await this.ledger.removeClearRecoveryCandidate(
        request.scope,
        discardedClear.mutationId,
        discardedClear.preparedRecordHash
      );
    }

    const completed = receipt.completed !== null
      || plan.actions.some((action) => action.kind === "write-completed");
    if (completed
      && receipt.prepared?.purpose === "mutation"
      && receipt.prepared.method === "clearAside") {
      await this.ledger.removeClearRecoveryCandidateIfMatches(
        request.scope,
        request.mutationId,
        hashPreparedMutationRecord(receipt.prepared)
      );
    }

    if (!surfaceTerminal) return null;
    if (receipt.prepared === null) return null;
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
      false,
      { ignoreForeignReplacement: true }
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
    // A terminal provider transaction can leave both its prepared record and
    // its earlier started record when a crash lands after the prepared write.
    // Remove the started record first; its ledger directory then satisfies the
    // prepared-only removal precondition. Recovery action order is otherwise
    // unchanged for publication and completion actions.
    const ordered = [
      ...actions.filter((action) => action.kind !== "discard-record"
        || action.recordKind === "started"),
      ...actions.filter((action) => action.kind === "discard-record"
        && action.recordKind === "prepared")
    ];
    for (const action of ordered) {
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

  /** Capture staged Clear ownership before recovery discards its receipt. */
  private async discardedClearReceiptEvidence(
    session: StoryAggregateSession,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    staged: StoryEnvelopeManifest | null
  ): Promise<DiscardedClearReceiptEvidence | null> {
    if (staged === null) return null;
    const pointer = staged?.lastTransaction;
    if (pointer === null || pointer === undefined
      || pointer.phase !== "prepared") {
      return null;
    }
    const receipt = await this.ledger.loadStoryReceipt(
      request.scope,
      pointer.mutationId
    );
    const prepared = receipt.prepared;
    if (prepared === null
      || receipt.started !== null
      || receipt.completed !== null
      || receipt.acknowledged !== null
      || prepared.purpose !== "mutation"
      || prepared.method !== "clearAside"
      || prepared.key !== pointer.mutationId
      || prepared.aggregateKey !== request.scope
      || prepared.startedRecordHash !== null) {
      return null;
    }
    const stagedHash = hashStoryManifest(staged);
    if (prepared.oldStateHash !== session.snapshot.manifestHash
      || staged.previousManifestHash !== session.snapshot.manifestHash
      || prepared.newStateHash !== stagedHash
      || prepared.result.kind !== "story"
      || canonicalJson(prepared.result) !== canonicalJson(storyResult(staged))) {
      return null;
    }
    return {
      mutationId: pointer.mutationId,
      preparedRecordHash: hashPreparedMutationRecord(prepared)
    };
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
  manifest: StoryEnvelopeManifest,
  factStatesRemoved?: number
): Extract<MutationResult, { kind: "story" }> {
  return {
    kind: "story",
    storyId: manifest.id,
    storyRevision: manifest.revision,
    summary: manifest.kind === "live" ? manifest.summary : null,
    ...(factStatesRemoved === undefined || factStatesRemoved === 0
      ? {}
      : { factStatesRemoved })
  };
}

export function hashStoryManifest(manifest: StoryEnvelopeManifest): string {
  if (manifest.schemaVersion === STORY_SCHEMA_VERSION_V16) {
    return hashStoryV16ManifestBytes(Buffer.from(formatV16(manifest), "utf8"));
  }
  if (manifest.schemaVersion === STORY_SCHEMA_VERSION_V14) {
    return hashStoryV14ManifestBytes(Buffer.from(formatV14(manifest), "utf8"));
  }
  if (manifest.schemaVersion === STORY_SCHEMA_VERSION_V12) {
    return hashStoryV12ManifestBytes(Buffer.from(formatV12(manifest), "utf8"));
  }
  if (manifest.schemaVersion === STORY_SCHEMA_VERSION_V10) {
    return hashStoryV10ManifestBytes(Buffer.from(formatV10(manifest), "utf8"));
  }
  return manifest.schemaVersion === STORY_SCHEMA_VERSION_V8
    ? hashStoryV8ManifestBytes(Buffer.from(formatV8(manifest), "utf8"))
    : hashStoryV6ManifestBytes(Buffer.from(formatV6(manifest), "utf8"));
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
  manifest: StoryEnvelopeManifest | null
): ReplacementRecoveryEvidence | null {
  if (manifest === null) return null;
  return {
    stateHash: hashStoryManifest(manifest),
    oldStateHash: manifest.previousManifestHash ?? "absent",
    state: storyProjection(manifest)
  };
}
