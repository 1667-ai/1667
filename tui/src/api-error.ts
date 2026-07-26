import { isDiagnosticReference } from "../../shared/diagnostic-reference.js";
import {
  decodeHttpFailurePayload,
  diagnosticReferenceFromFailure,
  type CompatibleHttpFailureEnvelope
} from "../../shared/failure-envelope.js";

/** Application errors do not indicate loss of the backend connection. */
export class ApiError extends Error {
  readonly diagnosticRef: string | null;

  constructor(message: string, diagnosticRef: unknown = null) {
    const reference = isDiagnosticReference(diagnosticRef)
      ? diagnosticRef
      : null;
    super(reference === null ? message : `${message} (${reference})`);
    this.diagnosticRef = reference;
  }
}

export class ApiRecoveryRequiredError extends ApiError {
  constructor() {
    super(
      "Backend recovery changed authoritative state; the operation was not sent. Review the reloaded state and retry."
    );
  }
}

/** One envelope-backed application error shared by HTTP and worker clients. */
export class ApiFailureError<
  TFailure extends CompatibleHttpFailureEnvelope =
    CompatibleHttpFailureEnvelope
> extends ApiError {
  constructor(readonly failure: TFailure) {
    super(
      failure.message,
      diagnosticReferenceFromFailure(failure)
    );
    this.name = "ApiFailureError";
  }

  get code(): string {
    return this.failure.code;
  }

  get status(): number | null {
    return this.failure.status;
  }
}

export class ApiHttpError extends ApiFailureError<CompatibleHttpFailureEnvelope> {
  constructor(failure: CompatibleHttpFailureEnvelope) {
    super(failure);
    this.name = "ApiHttpError";
  }

  override get status(): number {
    return this.failure.status ?? 500;
  }
}

export function apiHttpErrorFromPayload(
  payload: unknown,
  fallbackMessage: string,
  status: unknown
): ApiHttpError {
  const failure = decodeHttpFailurePayload(
    payload,
    fallbackMessage,
    status
  );
  return new ApiHttpError(failure);
}

export function apiErrorCode(error: unknown): string | null {
  return error instanceof ApiError
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}
