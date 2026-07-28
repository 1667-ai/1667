import type { FailureCode } from "../shared/failure-envelope.js";

export type ServiceErrorCode = FailureCode;

/** Transport-neutral application failure. Adapters decide how to encode it. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(
    readonly status: number,
    message: string,
    code?: ServiceErrorCode,
    options: {
      readonly cause?: unknown;
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
  constructor(message: string, readonly status: number | null = null, readonly body: string = "") {
    super(message);
    this.name = "ProviderError";
  }
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
