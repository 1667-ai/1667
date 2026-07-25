import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";

test("deadline cancellation survives late mutation success as an uncertain outcome", () => {
  const cancellation = new WorkerRequestCancellation(true);

  cancellation.cancel("deadline");

  assert.equal(cancellation.signal.aborted, true);
  assert.throws(
    () => cancellation.throwIfDeadlineExpired(),
    isServiceError("mutation_outcome_unknown")
  );
  assert.match(
    (cancellation.failure(new Error("late success")) as Error).message,
    /retained for reconciliation/
  );
});

test("user cancellation stays distinct from a deadline", () => {
  const cancellation = new WorkerRequestCancellation(true);
  const failure = new Error("cancelled");

  cancellation.cancel("user");

  cancellation.throwIfDeadlineExpired();
  assert.equal(cancellation.failure(failure), failure);
});

function isServiceError(code: string) {
  return (error: unknown): boolean => error instanceof ServiceError
    && error.code === code;
}
