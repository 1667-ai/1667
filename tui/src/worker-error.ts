import { writeSync } from "node:fs";
import { isDiagnosticReference } from "../../shared/diagnostic-reference.js";
import {
  type CompatibleHttpFailureEnvelope,
  type FailureEnvelope
} from "../../shared/failure-envelope.js";
import { ApiFailureError } from "./api-error.js";

export const BACKEND_RESTART_REQUIRED_EXIT_CODE = 75;

export class BackendRestartRequiredError extends Error {
  readonly code = "backend_restart_required";
  private attachedDiagnosticRef: string | null;

  constructor(
    message: string,
    options: { cause?: unknown; diagnosticRef?: string | null } = {}
  ) {
    super(`backend_restart_required: ${message}`, options);
    this.name = "BackendRestartRequiredError";
    this.attachedDiagnosticRef = isDiagnosticReference(options.diagnosticRef)
      ? options.diagnosticRef
      : null;
  }

  get diagnosticRef(): string | null {
    return this.attachedDiagnosticRef;
  }

  attachDiagnosticReference(reference: unknown): void {
    if (this.attachedDiagnosticRef === null && isDiagnosticReference(reference)) {
      this.attachedDiagnosticRef = reference;
    }
  }
}

export function exitForBackendRestart(
  error?: BackendRestartRequiredError
): never {
  const diagnostic = error?.diagnosticRef === null
    || error?.diagnosticRef === undefined
    ? ""
    : ` Diagnostic reference: ${error.diagnosticRef}.`;
  try {
    writeSync(
      process.stderr.fd,
      "1667: the local backend stopped before it confirmed the last change. "
        + `Restart 1667. Saved state will be checked before more work is accepted.${diagnostic}\n`
    );
  } finally {
    process.exit(BACKEND_RESTART_REQUIRED_EXIT_CODE);
  }
}

/** Authoritative mutation settlement from the worker transport. */
export type WorkerMutationOutcome = "terminal" | "uncertain";

export class WorkerApiError extends ApiFailureError<CompatibleHttpFailureEnvelope> {
  /**
   * Transport-owned mutation settlement outcome when this error rejects a
   * mutation call. Null for non-mutation failures and legacy/synthetic errors
   * that never settled through the transport.
   */
  readonly mutationOutcome: WorkerMutationOutcome | null;

  constructor(
    failure: CompatibleHttpFailureEnvelope,
    mutationOutcome: WorkerMutationOutcome | null = null
  ) {
    super(failure);
    this.name = "WorkerApiError";
    this.mutationOutcome = mutationOutcome;
  }
}

export function workerApiErrorFromFailure(
  failure: FailureEnvelope,
  mutationOutcome: WorkerMutationOutcome | null = null
): WorkerApiError {
  return new WorkerApiError(failure, mutationOutcome);
}
