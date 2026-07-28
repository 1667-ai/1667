import type { Story } from "../shared/types.js";
import {
  isProviderMutationId
} from "../shared/provider-recovery.js";
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
import {
  requireExpectedStoryVersion,
  storyAggregateVersion
} from "./story-aggregate-state.js";
import {
  emptyStoryReceipt,
  resolveProviderRecovery,
  type ProviderRecoveryWarning
} from "./story-provider-recovery.js";
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
    warning: ProviderRecoveryWarning
  ) {
    const aggregateKey = `story:${storyId}` as const;
    return await this.stories.withOptionalAggregateSession(
      storyId,
      async (session) => {
        const warningReceipt = isProviderMutationId(warning.mutationId)
          ? await this.ledger.loadStoryReceipt(
              aggregateKey,
              warning.mutationId
            )
          : null;
        if (session === null) {
          if (warningReceipt === null
            || warningReceipt.completed !== null
            || warningReceipt.acknowledged !== null
            || emptyStoryReceipt(warningReceipt)) {
            return { state: "resolved" as const, deleted: true };
          }
          throw corruptStoryReceipt(warning.mutationId);
        }
        await this.recovery.finalizeAggregateTransaction(session, null);
        const resolution = await resolveProviderRecovery(
          this.ledger,
          aggregateKey,
          warning,
          session.snapshot.manifest.unresolvedProvider,
          storyAggregateVersion(session.snapshot)
        );
        const deleted = session.snapshot.manifest.kind === "deleted";
        if (resolution.state === "resolved") {
          return { state: "resolved" as const, deleted };
        }
        return {
          state: "pending" as const,
          pendingProviderMutationId: resolution.providerMutationId,
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
    warning: ProviderRecoveryWarning
  ): Promise<StoryAcknowledgementCommit> {
    return await this.coordinator.runStory(input, async (request) => {
      if (request.mutationId === warning.mutationId) {
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
        request
      );
      return await this.stories.withAggregateSession(
        storyIdFromScope(request.scope),
        async (session) => {
          await this.recovery.finalizeAggregateTransaction(
            session,
            request.mutationId
          );
          let pendingProviderMutationId: MutationId;
          let original: StoryMutationReceipt;
          if (receipt.prepared === null) {
            const resolution = await resolveProviderRecovery(
              this.ledger,
              request.scope,
              warning,
              session.snapshot.manifest.unresolvedProvider,
              storyAggregateVersion(session.snapshot)
            );
            if (resolution.state === "resolved") {
              throw new ServiceError(
                409,
                "The provider outcome is not currently awaiting acknowledgement.",
                "conflict"
              );
            }
            pendingProviderMutationId = resolution.providerMutationId;
            original = resolution.receipt;
          } else {
            if (receipt.prepared.purpose
              !== "provider-acknowledgement") {
              throw corruptStoryReceipt(request.mutationId);
            }
            pendingProviderMutationId =
              receipt.prepared.originalProviderMutationId;
            original = await this.ledger.loadStoryReceipt(
              request.scope,
              pendingProviderMutationId
            );
          }
          if (request.mutationId === pendingProviderMutationId) {
            throw new ServiceError(
              409,
              "Acknowledgement must use a different mutation ID.",
              "idempotency_conflict"
            );
          }
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
            || pointer.mutationId !== pendingProviderMutationId
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
            originalProviderMutationId: pendingProviderMutationId,
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
                mutationId: pendingProviderMutationId,
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

function requireMatchingAcknowledgementReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>
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
    || receipt.started !== null
    || receipt.acknowledged !== null) {
    throw new ServiceError(
      409,
      "Mutation ID was already used for different acknowledgement input.",
      "idempotency_conflict"
    );
  }
}
