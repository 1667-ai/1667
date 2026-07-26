import {
  createFailureEnvelope,
  diagnosticReferenceFromFailure,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import type { DiagnosticReference } from "../shared/diagnostic-reference.js";
import {
  DiagnosticServiceError,
  ProviderError,
  PublicRuntimeError,
  ServiceError,
  type ServiceErrorCode
} from "./errors.js";
import {
  durableFailureIncident,
  errorFromFailureIncident,
  isReportedServiceError,
  publicFailureIncident,
  reframeFailureIncident,
  restoredFailureIncident,
  unreportedFailureIncident,
  type ServiceFailureIncident
} from "./reported-service-error.js";

export interface PublicServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
  readonly status: number;
}

export interface ServiceErrorClassification {
  readonly publicError: PublicServiceError;
  readonly exposure: "public" | "private";
}

export type StoredServiceError = FailureEnvelope;

type PrivateDiagnosticSelection =
  | { readonly kind: "none" }
  | { readonly kind: "present"; readonly error: unknown };

const INTERNAL_PUBLIC_ERROR: PublicServiceError = Object.freeze({
  code: "internal",
  message: "Internal server error",
  status: 500
});

/** One transport-independent exposure policy for HTTP, SSE, and workers. */
export function classifyServiceError(
  error: unknown
): ServiceErrorClassification {
  if (isReportedServiceError(error)) {
    return {
      publicError: {
        code: error.failure.code,
        message: error.failure.message,
        status: error.failure.status ?? 500
      },
      exposure: "public"
    };
  }
  if (error instanceof PublicRuntimeError) {
    return {
      publicError: {
        code: "startup_failure",
        message: error.message,
        status: 500
      },
      exposure: "public"
    };
  }
  if (error instanceof ServiceError) {
    if (error.code === "internal") {
      return { publicError: INTERNAL_PUBLIC_ERROR, exposure: "private" };
    }
    return {
      publicError: {
        code: error.code,
        message: error.message,
        status: error.status
      },
      exposure: "public"
    };
  }
  if (error instanceof ProviderError) {
    return {
      publicError: {
        code: "provider_failure",
        message: error.message,
        status: 502
      },
      exposure: "public"
    };
  }
  return { publicError: INTERNAL_PUBLIC_ERROR, exposure: "private" };
}

export function toPublicServiceError(error: unknown): PublicServiceError {
  return classifyServiceError(error).publicError;
}

export function prepareServiceFailure(
  error: unknown
): ServiceFailureIncident {
  if (isReportedServiceError(error)) return error.incident;
  const classified = classifyServiceError(error);
  const failure = createFailureEnvelope(classified.publicError);
  const selected = privateDiagnosticSelection(error, classified);
  if (selected.kind === "none") {
    return publicFailureIncident(failure, error);
  }
  return isReportedServiceError(selected.error)
    ? reframeFailureIncident(selected.error.incident, failure)
    : unreportedFailureIncident(failure, error, selected.error);
}

function privateDiagnosticSelection(
  error: unknown,
  classified = classifyServiceError(error)
): PrivateDiagnosticSelection {
  if (error instanceof DiagnosticServiceError) {
    return { kind: "present", error: error.diagnosticCause };
  }
  return classified.exposure === "private"
    ? { kind: "present", error }
    : { kind: "none" };
}

export function restoreStoredServiceFailure(
  failure: StoredServiceError
): unknown {
  const error = new ServiceError(
    failure.status ?? 500,
    failure.message,
    failure.code
  );
  return failure.kind === "diagnostic" || failure.code === "internal"
    ? errorFromFailureIncident(
        restoredFailureIncident(failure, error, error)
      )
    : error;
}

/** Once a failure envelope is durable, a missing reference is final. Public
 * domain errors keep their original subtype; only unreported private errors
 * need restored provenance to prevent a later transport from inventing one. */
export function finalizeDurableServiceFailure(
  incident: ServiceFailureIncident
): unknown {
  return errorFromFailureIncident(durableFailureIncident(incident));
}

export function internalErrorReference(
  error: unknown
): DiagnosticReference | null {
  return isReportedServiceError(error)
    ? diagnosticReferenceFromFailure(error.failure)
    : null;
}
