import { writeSync } from "node:fs";
import { isDiagnosticReference } from "../../shared/diagnostic-reference.js";
import {
  type CompatibleHttpFailureEnvelope,
  type FailureEnvelope
} from "../../shared/failure-envelope.js";
import { terminalLineText } from "../../shared/terminal-text.js";
import { sliceWellFormedUtf16Prefix } from "../../shared/unicode.js";
import { ApiFailureError } from "./api-error.js";

export const BACKEND_RESTART_REQUIRED_EXIT_CODE = 75;
const MAX_BACKEND_RESTART_DETAIL_LENGTH = 1_024;

export class BackendRestartRequiredError extends Error {
  readonly code = "backend_restart_required";
  readonly detail: string;
  private attachedDiagnosticRef: string | null;

  constructor(
    message: string,
    options: { cause?: unknown; diagnosticRef?: string | null } = {}
  ) {
    super(`backend_restart_required: ${message}`, options);
    this.name = "BackendRestartRequiredError";
    this.detail = message;
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
  const detail = error === undefined
    ? ""
    : backendRestartDetail(error);
  const diagnostic = error?.diagnosticRef === null
    || error?.diagnosticRef === undefined
    ? ""
    : ` Diagnostic reference: ${error.diagnosticRef}.`;
  try {
    writeSync(
      process.stderr.fd,
      "1667: the local backend stopped before it confirmed the last change. "
        + `Restart 1667. Saved state will be checked before more work is accepted.${detail}${diagnostic}\n`
    );
  } finally {
    process.exit(BACKEND_RESTART_REQUIRED_EXIT_CODE);
  }
}

function backendRestartDetail(error: BackendRestartRequiredError): string {
  const normalized = terminalLineText(
    error.detail.replace(/\s+/gu, " ").trim()
  );
  const bounded = normalized.length <= MAX_BACKEND_RESTART_DETAIL_LENGTH
    ? normalized
    : `${sliceWellFormedUtf16Prefix(
        normalized,
        MAX_BACKEND_RESTART_DETAIL_LENGTH - 1
      ).trimEnd()}…`;
  return bounded.length === 0
    ? ""
    : ` Failure detail: ${bounded}${/[.!?…]$/.test(bounded) ? "" : "."}`;
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
