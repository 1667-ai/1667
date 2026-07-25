export type ServiceErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "content_too_large"
  | "unprocessable"
  | "provider_failure"
  | "resource_busy"
  | "story_manifest_requires_successor"
  | "idempotency_conflict"
  | "revision_conflict"
  | "receipt_storage_unavailable"
  | "data_directory_unowned"
  | "data_directory_version_unsupported"
  | "settings_edit_requires_data_format_2"
  | "credential_test_requires_activation"
  | "mutation_expired"
  | "mutation_outcome_unknown"
  | "generation_outcome_unknown"
  | "generation_outcome_unknown_acknowledged"
  | "catalog_cursor_expired"
  | "operation_unknown"
  | "operation_expired"
  | "operation_session_terminal"
  | "internal";

/** Transport-neutral application failure. Adapters decide how to encode it. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(readonly status: number, message: string, code?: ServiceErrorCode) {
    super(message);
    this.name = "ServiceError";
    this.code = code ?? codeForStatus(status);
  }
}

export class ProviderError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly body: string = "") {
    super(message);
    this.name = "ProviderError";
  }
}

/** The provider finished responding and local validation proved that no commit
 * can still occur. Receipt recovery may safely persist this as terminal. */
export class GenerationResultError extends ServiceError {
  constructor(status: number, message: string) {
    super(status, message);
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

export function isDefinitiveProviderFailure(error: unknown): boolean {
  if (error instanceof GenerationResultError
    || error instanceof DurableMutationResultError) return true;
  return error instanceof ProviderError
    && error.status !== null
    && error.status >= 400
    && error.status < 500
    && error.status !== 408;
}

export interface PublicServiceError {
  code: ServiceErrorCode;
  message: string;
  status: number;
}

/** One transport-independent mapping for HTTP JSON/SSE and worker errors. */
export function toPublicServiceError(error: unknown): PublicServiceError {
  if (error instanceof ServiceError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof ProviderError) {
    return { code: "provider_failure", message: error.message, status: 502 };
  }
  return { code: "internal", message: "Internal server error", status: 500 };
}

function codeForStatus(status: number): ServiceErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "content_too_large";
  if (status === 422) return "unprocessable";
  if (status >= 500 && status < 600) return "provider_failure";
  if (status >= 400 && status < 500) return "invalid_request";
  return "internal";
}
