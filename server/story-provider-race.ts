import {
  isTerminalGenerationFailure,
  ServiceError
} from "./errors.js";
import type {
  MutationCoordinator,
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import type { MutationLedgerStore } from "./mutation-ledger-store.js";
import type {
  PreparedDomainError,
  ProviderMutationMethod,
  StartedMutationRecord
} from "./mutation-ledger-types.js";
import type {
  ProviderStoryMutationCommit,
  ProviderStoryReplay
} from "./story-provider-contract.js";
import { runTerminalStoryPhase } from "./story-provider-phase.js";
import { storyAggregateVersion } from "./story-aggregate-state.js";
import {
  providerOutcomeUnknown,
  receiptOnlyProviderError,
  requireUnacknowledgedProviderReceipt
} from "./story-provider-receipt.js";
import {
  commitReceiptOnlyStoryTransaction,
  prepareReceiptOnlyStoryError,
  StoryMutationRecovery,
  timestamp,
  type StoryMutationClock,
  type StoryMutationHooks
} from "./story-mutation-transaction.js";
import type { StoryStore } from "./stories.js";

/** Internal control flow: a same-ID contender already published success while
 * this call was doing provider work outside the story claim. */
export class ProviderTerminalReplay extends Error {}

/** Resolves same-ID races that become visible only after provider admission.
 * Keeping them here leaves the main provider store focused on its three phases. */
export class StoryProviderRaceResolver {
  constructor(
    private readonly stories: StoryStore,
    private readonly coordinator: MutationCoordinator,
    private readonly ledger: MutationLedgerStore,
    private readonly recovery: StoryMutationRecovery,
    private readonly now: StoryMutationClock,
    private readonly hooks: StoryMutationHooks
  ) {}

  async recordFailure(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    started: StartedMutationRecord | null,
    error: unknown,
    commitStartedError: (
      started: StartedMutationRecord,
      code: PreparedDomainError
    ) => Promise<void>
  ): Promise<void> {
    if (started !== null) {
      if (!isTerminalGenerationFailure(error)) return;
      const code = receiptOnlyProviderError(error) ?? "provider_failure";
      try {
        await runTerminalStoryPhase(
          this.coordinator,
          request,
          async () => await commitStartedError(started, code)
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
    await runTerminalStoryPhase(this.coordinator, request, async () =>
      await this.stories.withAggregateSession(storyId, async (session) => {
        await this.recovery.finalizeAggregateTransaction(
          session,
          request.mutationId
        );
        const receipt = await this.ledger.loadStoryReceipt(
          request.scope,
          request.mutationId
        );
        requireUnacknowledgedProviderReceipt(receipt, request, method);
        if (receipt.prepared !== null) {
          const terminal = await this.recovery.recover(
            session,
            request,
            receipt
          );
          if (terminal !== null) throw new ProviderTerminalReplay();
          throw providerOutcomeUnknown(request.mutationId);
        }
        if (receipt.started !== null) {
          throw providerOutcomeUnknown(request.mutationId);
        }
        const unresolved = session.snapshot.manifest.unresolvedProvider;
        if (unresolved !== null) {
          throw providerOutcomeUnknown(unresolved.mutationId);
        }
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

  async replayTerminalSuccess<Value>(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: ProviderMutationMethod,
    replayValue: ProviderStoryReplay<Value>
  ): Promise<ProviderStoryMutationCommit<Value>> {
    const committed = await runTerminalStoryPhase(this.coordinator, request, async () =>
      await this.stories.withAggregateSession(storyId, async (session) => {
        await this.recovery.finalizeAggregateTransaction(
          session,
          request.mutationId
        );
        const receipt = await this.ledger.loadStoryReceipt(
          request.scope,
          request.mutationId
        );
        requireUnacknowledgedProviderReceipt(receipt, request, method);
        const terminal = await this.recovery.recover(
          session,
          request,
          receipt
        );
        if (terminal === null) {
          throw providerOutcomeUnknown(request.mutationId);
        }
        return {
          story: await session.loadLive(),
          result: terminal,
          aggregateVersion: storyAggregateVersion(session.snapshot)
        };
      })
    );
    return { ...committed, value: await replayValue() };
  }
}
