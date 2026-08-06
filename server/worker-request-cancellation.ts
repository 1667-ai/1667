import type { WorkerCancelReason } from "../shared/worker-protocol.js";
import {
  DiagnosticServiceError,
  GenerationCancelledError,
  GenerationStoppedError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "./errors.js";
import { classifyProviderAbort } from "./provider-abort.js";

export interface WorkerCancellationFailure {
  readonly error: unknown;
  /** True when this request's deadline is what publishes the error
   * terminal. The executor attaches a stream's reclaimed unsent tail to
   * exactly these terminals and to no others. */
  readonly deadline: boolean;
}

/** Owns cooperative abort state without letting a late success erase deadline
 * provenance. The main process remains the hard fence for uncooperative work. */
export class WorkerRequestCancellation {
  private readonly controller = new AbortController();
  private deadlineFailure: ServiceError | null = null;
  private userCancellation: GenerationCancelledError | null = null;

  constructor(
    private readonly mutation: boolean,
    private readonly mutationId?: string
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason: WorkerCancelReason): void {
    if (reason === "deadline" && this.deadlineFailure === null) {
      this.deadlineFailure = deadlineError(this.mutation);
    }
    if (reason === "user" && this.userCancellation === null) {
      this.userCancellation = new GenerationCancelledError();
    }
    this.controller.abort(
      reason === "deadline"
        ? this.deadlineFailure
        : reason === "shutdown" && this.mutation
          ? mutationInterruptedError()
          : this.userCancellation
    );
  }

  settledUserCancellation(error: unknown): boolean {
    const abort = classifyProviderAbort(this.controller.signal);
    return this.deadlineFailure === null
      && this.userCancellation !== null
      && abort.kind === "terminal"
      && abort.userInitiated
      && error instanceof GenerationStoppedError;
  }

  throwIfDeadlineExpired(): void {
    if (this.deadlineFailure !== null) throw this.deadlineFailure;
  }

  failure(error: unknown): WorkerCancellationFailure {
    const deadlineFailure = this.deadlineFailure;
    if (deadlineFailure === null) return { error, deadline: false };
    // A different target proves that the current request did not reach the
    // provider. Its older story fence must survive this request's deadline.
    if (error instanceof ProviderRecoveryRequiredError
      && error.providerMutationId !== this.mutationId) {
      return { error, deadline: false };
    }
    if (isExpectedDeadlineCancellation(
      error,
      deadlineFailure,
      this.controller.signal
    )) {
      return { error: deadlineFailure, deadline: true };
    }
    return {
      error: deadlineError(this.mutation, {
        diagnosticCause: error
      }),
      deadline: true
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
