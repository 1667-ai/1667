import assert from "node:assert/strict";
import test from "node:test";
import {
  GenerationCancelledError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "../server/errors.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";

test("deadline cancellation survives late mutation success as an uncertain outcome", () => {
  const cancellation = new WorkerRequestCancellation(true);
  const privateFailure = new Error("late private failure");

  cancellation.cancel("deadline");

  assert.equal(cancellation.signal.aborted, true);
  assert.throws(
    () => cancellation.throwIfDeadlineExpired(),
    isServiceError("mutation_outcome_unknown")
  );
  const failure = cancellation.failure(privateFailure);
  assert.ok(failure.error instanceof ServiceError);
  assert.match(
    failure.error.message,
    /retained for reconciliation/
  );
  assert.equal((failure.error as Error).cause, privateFailure);
});

test("routine deadline cancellation keeps one public failure without diagnostics", () => {
  const cancellation = new WorkerRequestCancellation(false);

  cancellation.cancel("deadline");
  const deadlineFailure = cancellation.signal.reason;

  assert.ok(deadlineFailure instanceof ServiceError);
  assert.equal(
    cancellation.failure(deadlineFailure).error,
    deadlineFailure
  );
  assert.throws(
    () => cancellation.throwIfDeadlineExpired(),
    (error: unknown) => error === deadlineFailure
  );
  assert.equal(
    cancellation.failure(
      Object.assign(new Error("operation aborted"), { name: "AbortError" })
    ).error,
    deadlineFailure
  );
  assert.equal((deadlineFailure as Error).cause, undefined);
});

test("user cancellation stays distinct from a deadline", () => {
  const cancellation = new WorkerRequestCancellation(true);
  const failure = new Error("cancelled");

  cancellation.cancel("user");

  cancellation.throwIfDeadlineExpired();
  assert.ok(
    cancellation.signal.reason instanceof GenerationCancelledError
  );
  assert.equal(
    cancellation.settledUserCancellation(cancellation.signal.reason),
    true
  );
  assert.equal(cancellation.settledUserCancellation(failure), false);
  assert.deepEqual(
    cancellation.failure(failure),
    { error: failure, deadline: false }
  );
});

test("a deadline stays authoritative after user cancellation", () => {
  const cancellation = new WorkerRequestCancellation(true);

  cancellation.cancel("user");
  const userReason = cancellation.signal.reason;
  cancellation.cancel("deadline");

  assert.equal(cancellation.settledUserCancellation(userReason), false);
  assert.throws(
    () => cancellation.throwIfDeadlineExpired(),
    isServiceError("mutation_outcome_unknown")
  );
});

test("deadline substitution retains its private error separately", () => {
  const root = new Error("private failure during receipt settlement");
  const cancellation = new WorkerRequestCancellation(true);
  cancellation.cancel("deadline");

  const failure = cancellation.failure(root);
  assert.ok(failure.error instanceof ServiceError);

  assert.match(
    failure.error.message,
    /retained for reconciliation/
  );
  assert.equal((failure.error as Error).cause, root);
});

test("a deadline preserves only an older provider recovery target", () => {
  const currentMutationId =
    "m1.1767225600000.1123456789abcdef0123456789abcdef";
  const olderMutationId =
    "m1.1767225599999.2123456789abcdef0123456789abcdef";
  const cancellation = new WorkerRequestCancellation(
    true,
    currentMutationId
  );
  cancellation.cancel("deadline");

  const current = cancellation.failure(
    new ProviderRecoveryRequiredError(currentMutationId)
  ).error;
  assert.ok(current instanceof ServiceError);
  assert.equal(current.code, "mutation_outcome_unknown");

  const older = new ProviderRecoveryRequiredError(olderMutationId);
  assert.equal(cancellation.failure(older).error, older);
});

function isServiceError(code: string) {
  return (error: unknown): boolean => error instanceof ServiceError
    && error.code === code;
}
