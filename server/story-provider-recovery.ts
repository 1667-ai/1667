import type { StoryAggregateVersion } from "./mutation-coordinator.js";
import {
  isProviderMutationId,
  type ProviderRecoveryContext
} from "../shared/provider-recovery.js";
import {
  MutationLedgerStore,
  type StoryMutationReceipt
} from "./mutation-ledger-store.js";
import type { MutationId } from "./mutation-ledger-types.js";
import {
  sameStoryAggregateVersion
} from "./story-aggregate-state.js";
import {
  corruptStoryReceipt
} from "./story-mutation-transaction.js";
import type { ProviderPointer } from "./story-v6-types.js";

export interface ProviderRecoveryWarning {
  readonly mutationId: string;
  readonly recovery?: ProviderRecoveryContext;
}

export type ProviderRecoveryResolution =
  | { readonly state: "resolved" }
  | {
      readonly state: "pending";
      readonly providerMutationId: MutationId;
      readonly receipt: StoryMutationReceipt;
    };

/** Select the provider receipt that one warning can close.
 * The warning version is the causal link when dispatch stopped before the
 * warning mutation wrote a receipt. */
export async function resolveProviderRecovery(
  ledger: MutationLedgerStore,
  aggregateKey: `story:${string}`,
  warning: ProviderRecoveryWarning,
  pointer: Readonly<ProviderPointer> | null,
  currentVersion: StoryAggregateVersion
): Promise<ProviderRecoveryResolution> {
  const recovery = warning.recovery;
  if (!isProviderMutationId(warning.mutationId)) {
    return await resolveLegacyProviderRecovery(
      ledger,
      aggregateKey,
      recovery,
      pointer,
      currentVersion
    );
  }
  if (recovery?.kind === "target") {
    if (pointer === null
      || pointer.mutationId !== recovery.providerMutationId) {
      return { state: "resolved" };
    }
    return pendingProviderRecovery(
      await ledger.loadStoryReceipt(
        aggregateKey,
        recovery.providerMutationId
      ),
      recovery.providerMutationId,
      aggregateKey,
      pointer
    );
  }

  const warningReceipt = await ledger.loadStoryReceipt(
    aggregateKey,
    warning.mutationId
  );
  if (warningReceipt.completed !== null
    || warningReceipt.acknowledged !== null) {
    if (pointer?.mutationId === warning.mutationId) {
      throw corruptStoryReceipt(warning.mutationId);
    }
    return { state: "resolved" };
  }

  if (emptyStoryReceipt(warningReceipt)) {
    if (pointer === null) return { state: "resolved" };
    if (pointer.mutationId === warning.mutationId) {
      throw corruptStoryReceipt(warning.mutationId);
    }
    return await resolveLegacyProviderRecovery(
      ledger,
      aggregateKey,
      recovery,
      pointer,
      currentVersion
    );
  }

  return pendingProviderRecovery(
    warningReceipt,
    warning.mutationId,
    aggregateKey,
    pointer
  );
}

async function resolveLegacyProviderRecovery(
  ledger: MutationLedgerStore,
  aggregateKey: `story:${string}`,
  recovery: ProviderRecoveryContext | undefined,
  pointer: Readonly<ProviderPointer> | null,
  currentVersion: StoryAggregateVersion
): Promise<ProviderRecoveryResolution> {
  if (recovery?.kind !== "legacy"
    || pointer === null
    || !sameStoryAggregateVersion(
      currentVersion,
      recovery.warningAggregateVersion
    )) {
    return { state: "resolved" };
  }
  return pendingProviderRecovery(
    await ledger.loadStoryReceipt(
      aggregateKey,
      pointer.mutationId
    ),
    pointer.mutationId,
    aggregateKey,
    pointer
  );
}

function pendingProviderRecovery(
  providerReceipt: StoryMutationReceipt,
  providerMutationId: MutationId,
  aggregateKey: `story:${string}`,
  pointer: Readonly<ProviderPointer> | null
): ProviderRecoveryResolution {
  if (providerReceipt.started === null
    || providerReceipt.prepared !== null
    || providerReceipt.completed !== null
    || providerReceipt.acknowledged !== null
    || pointer === null
    || pointer.mutationId !== providerMutationId
    || pointer.fingerprintHash !== providerReceipt.started.fingerprintHash
    || providerReceipt.started.aggregateKey !== aggregateKey
    || providerReceipt.started.mutationId !== providerMutationId) {
    throw corruptStoryReceipt(providerMutationId);
  }
  return {
    state: "pending",
    providerMutationId,
    receipt: providerReceipt
  };
}

export function emptyStoryReceipt(
  receipt: StoryMutationReceipt
): boolean {
  return receipt.started === null
    && receipt.prepared === null
    && receipt.completed === null
    && receipt.acknowledged === null;
}
