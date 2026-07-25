import type { Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import type {
  MutationCoordinator,
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
import type {
  MutationId,
  MutationResult,
  PreparedProviderAcknowledgementRecord
} from "./mutation-ledger-types.js";
import { requireExpectedStoryVersion } from "./story-aggregate-state.js";
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

export interface StoryAcknowledgementCommit {
  readonly story: Story | null;
  readonly result: Extract<MutationResult, { kind: "story" }>;
}

export class StoryUnknownOutcomeStore {
  constructor(
    private readonly stories: StoryStore,
    private readonly coordinator: MutationCoordinator,
    private readonly ledger: MutationLedgerStore,
    private readonly recovery: StoryMutationRecovery,
    private readonly now: StoryMutationClock,
    private readonly hooks: StoryMutationHooks
  ) {}

  async status(
    storyId: string,
    originalProviderMutationId: MutationId
  ) {
    const aggregateKey = `story:${storyId}` as const;
    return await this.stories.withOptionalAggregateSession(
      storyId,
      async (session) => {
        let receipt = await this.ledger.loadStoryReceipt(
          aggregateKey,
          originalProviderMutationId
        );
        if (session === null) {
          if (receipt.completed !== null || receipt.acknowledged !== null
            || emptyStoryReceipt(receipt)) {
            return { state: "resolved" as const, deleted: true };
          }
          throw corruptStoryReceipt(originalProviderMutationId);
        }
        await this.recovery.finalizeAggregateTransaction(session, null);
        receipt = await this.ledger.loadStoryReceipt(
          aggregateKey,
          originalProviderMutationId
        );
        const deleted = session.snapshot.manifest.kind === "deleted";
        const pointer = session.snapshot.manifest.unresolvedProvider;
        if (receipt.completed !== null || receipt.acknowledged !== null) {
          if (pointer?.mutationId === originalProviderMutationId) {
            throw corruptStoryReceipt(originalProviderMutationId);
          }
          return { state: "resolved" as const, deleted };
        }
        if (emptyStoryReceipt(receipt)) {
          if (pointer?.mutationId === originalProviderMutationId) {
            throw corruptStoryReceipt(originalProviderMutationId);
          }
          return { state: "resolved" as const, deleted };
        }
        if (receipt.started === null || receipt.prepared !== null
          || pointer === null
          || pointer.mutationId !== originalProviderMutationId
          || pointer.fingerprintHash !== receipt.started.fingerprintHash
          || receipt.started.aggregateKey !== aggregateKey) {
          throw corruptStoryReceipt(originalProviderMutationId);
        }
        return {
          state: "pending" as const,
          deleted,
          aggregateVersion: session.snapshot.storageKind === "v5"
            ? {
              kind: "v5" as const,
              manifestHash: session.snapshot.manifestHash
            }
            : {
              kind: "v6" as const,
              revision: session.snapshot.manifest.revision
            }
        };
      }
    );
  }

  async run(
    input: unknown,
    originalProviderMutationId: MutationId
  ): Promise<StoryAcknowledgementCommit> {
    return await this.coordinator.runStory(input, async (request) => {
      if (request.mutationId === originalProviderMutationId) {
        throw new ServiceError(
          409,
          "Acknowledgement must use a different mutation ID.",
          "idempotency_conflict"
        );
      }
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      requireFreshStoryMutation(receipt, request.mutationId, this.now);
      requireMatchingAcknowledgementReceipt(
        receipt,
        request,
        originalProviderMutationId
      );
      const original = await this.ledger.loadStoryReceipt(
        request.scope,
        originalProviderMutationId
      );
      return await this.stories.withAggregateSession(
        storyIdFromScope(request.scope),
        async (session) => {
          await this.recovery.finalizeAggregateTransaction(
            session,
            request.mutationId
          );
          const originalEvidence = original.started === null
            ? null
            : {
              started: original.started,
              acknowledged: original.acknowledged
            };
          const terminal = await this.recovery.recover(
            session,
            request,
            receipt,
            originalEvidence
          );
          if (terminal !== null) {
            return {
              story: session.snapshot.manifest.kind === "live"
                ? await session.loadLive()
                : null,
              result: terminal
            };
          }
          if (original.started === null || original.prepared !== null
            || original.completed !== null || original.acknowledged !== null) {
            throw new ServiceError(
              409,
              "The provider outcome is not currently awaiting acknowledgement.",
              "conflict"
            );
          }
          const pointer = session.snapshot.manifest.unresolvedProvider;
          const startedHash = hashStartedMutationRecord(original.started);
          if (pointer === null
            || pointer.mutationId !== originalProviderMutationId
            || pointer.fingerprintHash !== original.started.fingerprintHash
            || original.started.aggregateKey !== request.scope) {
            throw new ServiceError(
              409,
              "The provider outcome changed before acknowledgement.",
              "conflict"
            );
          }
          requireExpectedStoryVersion(
            session.snapshot,
            request.expectedAggregateVersion
          );
          const oldStateHash = session.snapshot.manifestHash;
          const manifest = reduceStoryV6({
            kind: "present",
            manifest: session.snapshot.manifest,
            manifestHash: oldStateHash
          }, {
            kind: "acknowledge-prepared",
            expectedManifestHash: oldStateHash,
            provider: pointer,
            acknowledgementMutationId: request.mutationId
          });
          if (manifest === null) {
            throw new Error("Acknowledgement removed its story aggregate");
          }
          const prepared: PreparedProviderAcknowledgementRecord = {
            schema: 1,
            kind: "prepared",
            purpose: "provider-acknowledgement",
            aggregateKey: request.scope,
            key: request.mutationId,
            fingerprintHash: request.fingerprint,
            method: "acknowledgeUnknownOutcomes",
            oldStateHash,
            newStateHash: hashStoryManifest(manifest),
            originalProviderMutationId,
            originalStartedRecordHash: startedHash,
            result: storyResult(manifest),
            preparedAt: timestamp(this.now)
          };
          const preparedHash = hashPreparedMutationRecord(prepared);
          await commitPreparedStoryTransaction({
            session,
            ledger: this.ledger,
            manifest,
            prepared,
            now: this.now,
            hooks: this.hooks,
            afterPublish: async () => {
              await this.ledger.writeStoryRecord({
                schema: 1,
                kind: "acknowledged",
                aggregateKey: request.scope,
                mutationId: originalProviderMutationId,
                startedRecordHash: startedHash,
                acknowledgementMutationId: request.mutationId,
                acknowledgementPreparedHash: preparedHash,
                acknowledgedAt: timestamp(this.now)
              });
              await this.hooks.afterAcknowledged?.();
            }
          });
          return {
            story: manifest.kind === "live" ? await session.loadLive() : null,
            result: prepared.result
          };
        }
      );
    });
  }
}

function emptyStoryReceipt(receipt: StoryMutationReceipt): boolean {
  return receipt.started === null
    && receipt.prepared === null
    && receipt.completed === null
    && receipt.acknowledged === null;
}

function requireMatchingAcknowledgementReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  originalProviderMutationId: MutationId
): void {
  if (receipt.prepared === null) {
    if (receipt.started !== null || receipt.completed !== null
      || receipt.acknowledged !== null) {
      throw corruptStoryReceipt(request.mutationId);
    }
    return;
  }
  const prepared = receipt.prepared;
  if (prepared.purpose !== "provider-acknowledgement"
    || prepared.aggregateKey !== request.scope
    || prepared.key !== request.mutationId
    || prepared.method !== "acknowledgeUnknownOutcomes"
    || prepared.fingerprintHash !== request.fingerprint
    || prepared.originalProviderMutationId !== originalProviderMutationId
    || receipt.started !== null
    || receipt.acknowledged !== null) {
    throw new ServiceError(
      409,
      "Mutation ID was already used for different acknowledgement input.",
      "idempotency_conflict"
    );
  }
}
