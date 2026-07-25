import type { WorkerCancelReason } from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";

/** Owns cooperative abort state without letting a late success erase deadline
 * provenance. The main process remains the hard fence for uncooperative work. */
export class WorkerRequestCancellation {
  private readonly controller = new AbortController();
  private deadlineExpired = false;

  constructor(private readonly mutation: boolean) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason: WorkerCancelReason): void {
    if (reason === "deadline") this.deadlineExpired = true;
    this.controller.abort(
      reason === "deadline"
        ? deadlineError(this.mutation)
        : reason === "shutdown" && this.mutation
          ? mutationInterruptedError()
          : undefined
    );
  }

  throwIfDeadlineExpired(): void {
    if (this.deadlineExpired) throw deadlineError(this.mutation);
  }

  failure(error: unknown): unknown {
    return this.deadlineExpired ? deadlineError(this.mutation) : error;
  }
}

function deadlineError(mutation: boolean): ServiceError {
  return mutation
    ? new ServiceError(
      408,
      "Worker mutation recovery deadline exceeded; the request was retained for reconciliation.",
      "mutation_outcome_unknown"
    )
    : new ServiceError(408, "Worker request deadline exceeded");
}

function mutationInterruptedError(): ServiceError {
  return new ServiceError(
    409,
    "Worker shutdown interrupted an active mutation; the request was retained for reconciliation.",
    "mutation_outcome_unknown"
  );
}
