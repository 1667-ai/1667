import { isDiagnosticReference } from "../../shared/diagnostic-reference.js";
import {
  decodeHttpFailurePayload,
  diagnosticReferenceFromFailure,
  type CompatibleHttpFailureEnvelope,
  type TimeoutProvenance
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
  constructor(
    message = "Backend recovery changed authoritative state; the operation was not sent. Review the reloaded state and retry."
  ) {
    super(message);
  }
}

/**
 * Transport-neutral proof that a mutation never left the client.
 * Orthogonal to ApiError (application / stay online) vs plain Error
 * (transport / connection monitor goes down).
 */
export type ExplicitMutationUnsent = {
  readonly mutationNotSent: true;
};

export function markExplicitMutationUnsent<E extends Error>(
  error: E
): E & ExplicitMutationUnsent {
  return Object.assign(error, { mutationNotSent: true as const });
}

export function isExplicitMutationUnsent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as ExplicitMutationUnsent).mutationNotSent === true;
}

/**
 * Explicit-unsent preflight failure. Application ApiError causes stay online;
 * other causes keep non-ApiError transport classification and preserve cause.
 */
export function explicitMutationUnsentFromCause(
  cause: unknown,
  detailPrefix: string,
  fallbackMessage: string
): Error {
  if (isExplicitMutationUnsent(cause) && cause instanceof Error) return cause;
  if (cause instanceof ApiRecoveryRequiredError) {
    return markExplicitMutationUnsent(cause);
  }
  if (cause instanceof ApiError) {
    return markExplicitMutationUnsent(
      new ApiRecoveryRequiredError(`${detailPrefix}: ${cause.message}`)
    );
  }
  if (cause instanceof Error) {
    return markExplicitMutationUnsent(
      new Error(`${detailPrefix}: ${cause.message}`, { cause })
    );
  }
  return markExplicitMutationUnsent(new Error(fallbackMessage));
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

  get timeout(): TimeoutProvenance | null {
    return this.failure.timeout ?? null;
  }
}

export class ApiHttpError extends ApiFailureError<CompatibleHttpFailureEnvelope> {
  constructor(
    failure: CompatibleHttpFailureEnvelope,
    readonly requestSent = true
  ) {
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
