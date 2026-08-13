import { resolveAsideActivation } from "../shared/aside-release.js";
import type {
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import type { StoryMutationReceipt } from "./mutation-ledger-store.js";
import type { StoryMutationMethod } from "./mutation-ledger-types.js";
import type { StoryStore } from "./stories.js";

export interface StoryRecoveryAdmission {
  readonly allowed: boolean;
}

/** Decide whether an inactive predecessor may reopen a story mutation.
 *
 * Only a receipt for this exact mutation identity is retry evidence. The
 * current successor slot and a staged replacement do not identify their
 * writer: another provider or local mutation may own them. Inactive
 * predecessors may therefore reopen only a request whose durable story
 * receipt has the same method, identity, scope, and fingerprint.
 */
export function storyRecoveryAdmission(
  stories: StoryStore,
  method: StoryMutationMethod,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  receipt: StoryMutationReceipt
): StoryRecoveryAdmission {
  if (resolveAsideActivation(stories.asideActivation)) {
    return { allowed: true };
  }
  const hasExactStartedReceipt = receipt.started !== null
    && receipt.started.aggregateKey === request.scope
    && receipt.started.mutationId === request.mutationId
    && receipt.started.method === method
    && receipt.started.fingerprintHash === request.fingerprint;
  const hasExactPreparedReceipt = receipt.prepared !== null
    && receipt.prepared.aggregateKey === request.scope
    && receipt.prepared.key === request.mutationId
    && receipt.prepared.method === method
    && receipt.prepared.fingerprintHash === request.fingerprint;
  return {
    allowed: hasExactStartedReceipt || hasExactPreparedReceipt
  };
}
