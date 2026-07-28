import type { LocalDurabilityMutationMethod } from "../shared/worker-protocol.js";
import { chapterBreakRemovalFingerprint } from "./chapter-breaks.js";
import { ServiceError } from "./errors.js";
import {
  createMutationPlan,
  type MutationPlan
} from "./mutation-plan.js";
import { isMutationFingerprint } from "./mutation-receipt-codec.js";
import {
  deterministicMutationEntityId,
  validateUnseenMutationId
} from "./mutation-receipts.js";
import { mutationOutcomeUnknown } from "./mutation-recovery.js";
import { StoryDurabilityError } from "./story-lifecycle.js";

/**
 * Runs one local-durability-tier mutation without a receipt store. The plan
 * still derives deterministic entity IDs from the mutation ID, but nothing is
 * persisted around the work: the aggregate transaction inside it commits
 * through one atomic manifest publish, and there is no replay source, so a
 * crash loses at most this mutation. Provider capabilities are structurally
 * unreachable and fail closed if a local method ever requests one.
 */
export async function runLocalTierMutation<
  M extends LocalDurabilityMutationMethod,
  T
>(
  mutationId: string,
  method: M,
  work: (plan: MutationPlan<M>) => Promise<T>
): Promise<T> {
  validateUnseenMutationId(mutationId);
  const plan = createMutationPlan(method, "new", {
    entityId: (namespace, index = 0) =>
      deterministicMutationEntityId(mutationId, namespace, index),
    bindGenerationIntent: () => {
      throw localTierViolation(method, "a generation intent");
    },
    providerStarted: () => {
      throw localTierViolation(method, "a provider start");
    },
    preserveChapterBreakRemoval: async (expectedFingerprint, load) => {
      if (!isMutationFingerprint(expectedFingerprint)) {
        throw new ServiceError(400, "Invalid chapter-break removal fingerprint");
      }
      const value = structuredClone(await load());
      if (chapterBreakRemovalFingerprint(value) !== expectedFingerprint) {
        throw new ServiceError(
          409,
          "Chapter-break removal input no longer matches the aggregate.",
          "conflict"
        );
      }
      return value;
    }
  });
  try {
    return await work(plan);
  } catch (error) {
    // Parity with the full tier: a durability failure means the commit may or
    // may not have reached disk, so the caller must resynchronize state.
    if (error instanceof StoryDurabilityError) {
      throw mutationOutcomeUnknown({ diagnosticCause: error });
    }
    throw error;
  }
}

function localTierViolation(method: string, capability: string): ServiceError {
  return new ServiceError(
    500,
    `Local mutation ${method} requested ${capability}; provider work requires the full durability tier.`
  );
}
