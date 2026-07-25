import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import {
  MUTATION_CLOCK_SKEW_MS,
  MUTATION_RETENTION_MS,
  requireFreshUnseenMutationId
} from "../server/mutation-id-policy.js";
import type { MutationId } from "../server/mutation-ledger-types.js";

const NOW = 1_800_000_000_000;

test("Q unseen mutation IDs use the exact 90-day and five-minute window", () => {
  assert.doesNotThrow(() => requireFreshUnseenMutationId(
    mutationAt(NOW - MUTATION_RETENTION_MS),
    NOW
  ));
  assert.doesNotThrow(() => requireFreshUnseenMutationId(
    mutationAt(NOW + MUTATION_CLOCK_SKEW_MS),
    NOW
  ));
  assert.throws(
    () => requireFreshUnseenMutationId(
      mutationAt(NOW - MUTATION_RETENTION_MS - 1),
      NOW
    ),
    hasCode("mutation_expired")
  );
  assert.throws(
    () => requireFreshUnseenMutationId(
      mutationAt(NOW + MUTATION_CLOCK_SKEW_MS + 1),
      NOW
    ),
    hasCode("mutation_expired")
  );
});

function mutationAt(timestamp: number): MutationId {
  return `m1.${timestamp}.${"a".repeat(32)}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}
