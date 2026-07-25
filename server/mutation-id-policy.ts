import type { MutationId } from "./mutation-ledger-types.js";
import { mutationTimestampMs } from "./mutation-ledger-scalars.js";
import { ServiceError } from "./errors.js";

export const MUTATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MUTATION_CLOCK_SKEW_MS = 5 * 60 * 1_000;

/** Call only after a direct receipt lookup proved this mutation ID unseen. */
export function requireFreshUnseenMutationId(
  mutationId: MutationId,
  nowMs: number
): void {
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error("Mutation admission clock returned an invalid time");
  }
  const createdAt = mutationTimestampMs(mutationId);
  if (createdAt < nowMs - MUTATION_RETENTION_MS
    || createdAt > nowMs + MUTATION_CLOCK_SKEW_MS) {
    throw new ServiceError(
      409,
      "Mutation ID is outside its retry window.",
      "mutation_expired"
    );
  }
}
