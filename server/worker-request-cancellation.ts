import type { WorkerCancelReason } from "../shared/worker-protocol.js";
import {
  DiagnosticServiceError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "./errors.js";

export interface WorkerCancellationFailure {
  readonly error: unknown;
}

/** Owns cooperative abort state without letting a late success erase deadline
 * provenance. The main process remains the hard fence for uncooperative work. */
export class WorkerRequestCancellation {
  private readonly controller = new AbortController();
  private deadlineFailure: ServiceError | null = null;

  constructor(private readonly mutation: boolean) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason: WorkerCancelReason): void {
    if (reason === "deadline" && this.deadlineFailure === null) {
      this.deadlineFailure = deadlineError(this.mutation);
    }
    this.controller.abort(
      reason === "deadline"
        ? this.deadlineFailure
        : reason === "shutdown" && this.mutation
          ? mutationInterruptedError()
          : undefined
    );
  }

  throwIfDeadlineExpired(): void {
    if (this.deadlineFailure !== null) throw this.deadlineFailure;
  }

  failure(error: unknown): WorkerCancellationFailure {
    const deadlineFailure = this.deadlineFailure;
    if (deadlineFailure === null) return { error };
    // This error proves that the current request did not reach the provider.
    // Its target identifies an older provider request that still owns the
    // story fence. A deadline must not replace that recovery identity.
    if (error instanceof ProviderRecoveryRequiredError) {
      return { error };
    }
    if (isExpectedDeadlineCancellation(
      error,
      deadlineFailure,
      this.controller.signal
    )) {
      return { error: deadlineFailure };
    }
    return {
      error: deadlineError(this.mutation, {
        diagnosticCause: error
      })
    };
  }
}

function isExpectedDeadlineCancellation(
  error: unknown,
  deadlineFailure: ServiceError,
  signal: AbortSignal
): boolean {
  return error === deadlineFailure
    || error === signal.reason
    || (error instanceof Error && error.name === "AbortError");
}

function deadlineError(
  mutation: boolean,
  options?: { readonly diagnosticCause: unknown }
): ServiceError {
  const status = 408;
  const message = mutation
    ? "Worker mutation recovery deadline exceeded; the request was retained for reconciliation."
    : "Worker request deadline exceeded";
  const code = mutation ? "mutation_outcome_unknown" : "invalid_request";
  if (options !== undefined) {
    return new DiagnosticServiceError(
      status,
      message,
      code,
      options.diagnosticCause
    );
  }
  return mutation
    ? new ServiceError(
        status,
        message,
        code
      )
    : new ServiceError(status, message);
}

function mutationInterruptedError(): ServiceError {
  return new ServiceError(
    409,
    "Worker shutdown interrupted an active mutation; the request was retained for reconciliation.",
    "mutation_outcome_unknown"
  );
}
