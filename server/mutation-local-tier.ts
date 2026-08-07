import type { LocalDurabilityMutationMethod } from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";
import {
  createMutationPlan,
  type MutationPlan
} from "./mutation-plan.js";
import { loadVerifiedChapterBreakRemoval } from "./mutation-receipt-codec.js";
import { deterministicMutationEntityId } from "./mutation-receipts.js";
import { unknownOutcomeFromDurabilityFailure } from "./mutation-recovery.js";

/**
 * Runs one local-durability-tier mutation without a receipt store. The plan
 * still derives deterministic entity IDs from the mutation ID, but nothing is
 * persisted around the work: the aggregate transaction inside it commits
 * through one atomic manifest publish, and there is no replay source, so a
 * crash loses at most this mutation. Mutation-ID freshness has one home —
 * `requireFreshStoryMutation` inside the story transaction, judged against
 * the loaded ledger evidence — so this wrapper does not validate it again.
 * Provider capabilities are structurally unreachable and fail closed if a
 * local method ever requests one.
 */
export async function runLocalTierMutation<
  M extends LocalDurabilityMutationMethod,
  T
>(
  mutationId: string,
  method: M,
  work: (plan: MutationPlan<M>) => Promise<T>
): Promise<T> {
  const plan = createMutationPlan(method, "new", {
    entityId: (namespace, index = 0) =>
      deterministicMutationEntityId(mutationId, namespace, index),
    bindGenerationIntent: () => {
      throw localTierViolation(method, "a generation intent");
    },
    providerStarted: () => {
      throw localTierViolation(method, "a provider start");
    },
    providerRecoveryRequired: () => {
      throw localTierViolation(method, "provider recovery");
    },
    preserveChapterBreakRemoval: loadVerifiedChapterBreakRemoval,
    // Import methods are in the local-method type union but the manifest-only
    // eligibility predicate routes them through the full receipt tier. These
    // methods still fail closed if that boundary regresses.
    storedImportPlan: () => null,
    recordImportPlan: async () => {
      throw localTierViolation(method, "import-plan custody");
    }
  });
  try {
    return await work(plan);
  } catch (error) {
    // Parity with the full tier: a durability failure means the commit may or
    // may not have reached disk, so the caller must resynchronize state.
    throw unknownOutcomeFromDurabilityFailure(error) ?? error;
  }
}

function localTierViolation(method: string, capability: string): ServiceError {
  return new ServiceError(
    500,
    `Local mutation ${method} requested ${capability}; provider work requires the full durability tier.`
  );
}
