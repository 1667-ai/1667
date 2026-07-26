import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { runTerminalStoryPhase } from "../server/story-provider-phase.js";

const REQUEST = {
  transportOperationId: "terminal-phase-test",
  mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
  fingerprint: "a".repeat(64),
  scope: "story:q-local-story",
  expectedAggregateVersion: {
    kind: "v6",
    revision: "00000000000000000001"
  }
} as const;

test("terminal phase does not retry resource_busy from inside its claim", async () => {
  const coordinator = createMutationCoordinator();
  let calls = 0;
  await assert.rejects(
    runTerminalStoryPhase(coordinator, REQUEST, () => {
      calls += 1;
      throw new ServiceError(409, "Storage is busy", "resource_busy");
    }),
    (error: unknown) =>
      error instanceof ServiceError && error.code === "resource_busy"
  );
  assert.equal(calls, 1);
});
