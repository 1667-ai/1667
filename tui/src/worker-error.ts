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
  readonly diagnosticRef: string | null;

  constructor(
    message: string,
    options: { cause?: unknown; diagnosticRef?: string | null } = {}
  ) {
    super(`backend_restart_required: ${message}`, options);
    this.name = "BackendRestartRequiredError";
    this.diagnosticRef = isDiagnosticReference(options.diagnosticRef)
      ? options.diagnosticRef
      : null;
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
      "1667: backend_restart_required: backend stopped; restart 1667. "
        + `Interrupted changes will be checked on next launch.${diagnostic}\n`
    );
  } finally {
    process.exit(BACKEND_RESTART_REQUIRED_EXIT_CODE);
  }
}

export class WorkerApiError extends ApiFailureError<CompatibleHttpFailureEnvelope> {
  constructor(failure: CompatibleHttpFailureEnvelope) {
    super(failure);
    this.name = "WorkerApiError";
  }
}

export function workerApiErrorFromFailure(
  failure: FailureEnvelope
): WorkerApiError {
  return new WorkerApiError(failure);
}
