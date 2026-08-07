import type {
  FailureCode,
  TimeoutProvenance
} from "../shared/failure-envelope.js";
import { isDurableMutationId } from "../shared/durable-mutation-id.js";

export type ServiceErrorCode = FailureCode;

/** Transport-neutral application failure. Adapters decide how to encode it. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  /** Set only when a clean deadline is the whole failure — see
   * `TimeoutProvenance` (shared/failure-envelope.ts). */
  readonly timeout?: TimeoutProvenance;

  constructor(
    readonly status: number,
    message: string,
    code?: ServiceErrorCode,
    options: {
      readonly cause?: unknown;
      readonly timeout?: TimeoutProvenance;
    } = {}
  ) {
    super(
      message,
      Object.prototype.hasOwnProperty.call(options, "cause")
        ? { cause: options.cause }
        : undefined
    );
    this.name = "ServiceError";
    this.code = code ?? codeForStatus(status);
    if (options.timeout !== undefined) this.timeout = options.timeout;
  }
}

/** Safe public outcome that also owns a private diagnostic cause. */
export class DiagnosticServiceError extends ServiceError {
  constructor(
    status: number,
    message: string,
    code: ServiceErrorCode,
    readonly diagnosticCause: unknown
  ) {
    super(status, message, code, { cause: diagnosticCause });
    this.name = "DiagnosticServiceError";
  }
}

export class ProviderError extends Error {
  /** Set only when a clean provider deadline is the whole failure — see
   * `TimeoutProvenance` (shared/failure-envelope.ts). */
  readonly timeout?: TimeoutProvenance;

  constructor(
    message: string,
    readonly status: number | null = null,
    readonly body: string = "",
    options: { readonly timeout?: TimeoutProvenance } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    if (options.timeout !== undefined) this.timeout = options.timeout;
  }
}

/** The clean-timeout provenance an error carries, if any. Positive check
 * only: every error without a stamped provenance reads as null. */
export function timeoutProvenanceOf(
  error: unknown
): TimeoutProvenance | null {
  if (error instanceof ServiceError || error instanceof ProviderError) {
    return error.timeout ?? null;
  }
  return null;
}

/** A startup/runtime failure whose message is explicitly safe and actionable
 * at the local process boundary. Unexpected errors remain private. */
export class PublicRuntimeError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(
      message,
      Object.prototype.hasOwnProperty.call(options, "cause")
        ? { cause: options.cause }
        : undefined
    );
    this.name = "PublicRuntimeError";
  }
}

/** The provider finished responding and local validation proved that no commit
 * can still occur. Receipt recovery may safely persist this as terminal. */
export class GenerationResultError extends ServiceError {
  constructor(status: number, message: string) {
    super(
      status,
      message,
      status >= 500 && status < 600 ? "provider_failure" : undefined
    );
    this.name = "GenerationResultError";
  }
}

/** Provider work stopped before it could commit. The durable provider record
 * must close because no provider effect can still occur. */
export class GenerationStoppedError extends GenerationResultError {
  constructor(message = "The model request stopped.") {
    super(409, message);
    this.name = "GenerationStoppedError";
  }
}

/** A user stopped provider work. The worker adapter reports the expected
 * cancellation as a null result. */
export class GenerationCancelledError extends GenerationStoppedError {
  constructor() {
    super("The model request was cancelled.");
    this.name = "GenerationCancelledError";
  }
}

/** A provider warning that identifies the durable provider request which the
 * recovery owner must close. The public message does not expose this ID. */
export class ProviderRecoveryRequiredError extends ServiceError {
  constructor(
    readonly providerMutationId: string,
    options: { readonly diagnostic?: boolean } = {}
  ) {
    super(
      409,
      "The model request stopped. You can try again.",
      "generation_outcome_unknown",
      options.diagnostic === true
        ? { cause: providerRecoveryDiagnostic(providerMutationId) }
        : {}
    );
    this.name = "ProviderRecoveryRequiredError";
    this.hasDiagnosticCause = options.diagnostic === true;
    this.diagnosticCause = this.cause;
  }

  readonly hasDiagnosticCause: boolean;
  readonly diagnosticCause: unknown;
}

const retryablePartialSettlementFailures = new WeakSet<object>();

/** Internal marker for work that must leave its outer mutation receipt pending.
 * The receipt store unwraps the original error before it reaches an adapter. */
export class RetryableMutationReceiptError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly retryablePartialSettlement = false
  ) {
    super("Mutation work can retry with the same receipt");
    this.name = "RetryableMutationReceiptError";
  }
}

/** Carries the narrow partial-settlement retry contract past receipt unwrapping. */
export function markRetryablePartialSettlementFailure(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    retryablePartialSettlementFailures.add(error);
  }
}

export function isRetryablePartialSettlementFailure(error: unknown): boolean {
  return error !== null
    && (typeof error === "object" || typeof error === "function")
    && retryablePartialSettlementFailures.has(error);
}

function providerRecoveryDiagnostic(
  providerMutationId: string
): Error {
  const error = new Error([
    "Provider request outcome is unknown.",
    ...(isDurableMutationId(providerMutationId)
      ? [`providerMutationId=${providerMutationId}`]
      : [])
  ].join(" "));
  error.name = "ProviderRecoveryDiagnostic";
  return error;
}

/** A durable mutation receipt already proved this provider-class outcome
 * terminal. The outer compatibility receipt must not turn it back into an
 * ambiguous/billable result while reconciling after a crash. */
export class DurableMutationResultError extends ServiceError {
  constructor(status: number, message: string, code: ServiceErrorCode) {
    super(status, message, code);
    this.name = "DurableMutationResultError";
  }
}

/** The local generation mutation cannot commit after this failure.
 * A provider can still complete or bill a request after a transport failure,
 * but it cannot write the local story. */
export function isTerminalGenerationFailure(error: unknown): boolean {
  return error instanceof ProviderError
    || error instanceof GenerationResultError
    || error instanceof DurableMutationResultError;
}

function codeForStatus(status: number): ServiceErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "content_too_large";
  if (status === 422) return "unprocessable";
  if (status >= 500 && status < 600) return "internal";
  if (status >= 400 && status < 500) return "invalid_request";
  return "internal";
}
