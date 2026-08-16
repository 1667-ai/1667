import {
  createFailureEnvelope,
  diagnosticReferenceFromFailure,
  type FailureEnvelope,
  type TimeoutProvenance
} from "../shared/failure-envelope.js";
import type { DiagnosticReference } from "../shared/diagnostic-reference.js";
import {
  DiagnosticServiceError,
  ProviderError,
  ProviderRecoveryRequiredError,
  PublicRuntimeError,
  ServiceError,
  type ServiceErrorCode
} from "./errors.js";
import { formatInternalErrorMessage } from "./internal-error-format.js";
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
  readonly timeout?: TimeoutProvenance;
}

export interface ServiceErrorClassification {
  readonly publicError: PublicServiceError;
  readonly diagnostic: "none" | "required";
}

export type StoredServiceError = FailureEnvelope;

type DiagnosticSelection =
  | { readonly kind: "none" }
  | { readonly kind: "present"; readonly error: unknown };

/** One transport-independent exposure policy for HTTP, SSE, and workers. */
export function classifyServiceError(
  error: unknown
): ServiceErrorClassification {
  if (isReportedServiceError(error)) {
    return {
      publicError: {
        code: error.failure.code,
        message: error.failure.message,
        status: error.failure.status ?? 500,
        ...timeoutField(error.failure.timeout)
      },
      diagnostic: "none"
    };
  }
  if (error instanceof PublicRuntimeError) {
    return {
      publicError: {
        code: "startup_failure",
        message: error.message,
        status: 500
      },
      diagnostic: "none"
    };
  }
  if (error instanceof DiagnosticServiceError) {
    return {
      publicError: {
        code: error.code,
        message: error.message,
        status: error.status,
        ...timeoutField(error.timeout)
      },
      diagnostic: "required"
    };
  }
  if (error instanceof ServiceError && error.code !== "internal") {
    return {
      publicError: {
        code: error.code,
        message: error.message,
        status: error.status,
        ...timeoutField(error.timeout)
      },
      diagnostic: "none"
    };
  }
  if (error instanceof ProviderError) {
    return {
      publicError: {
        code: "provider_failure",
        message: error.message,
        status: 502,
        ...timeoutField(error.timeout)
      },
      diagnostic: "none"
    };
  }
  return {
    publicError: {
      code: "internal",
      message: formatInternalErrorMessage(error),
      status: 500
    },
    diagnostic: "required"
  };
}

function timeoutField(
  timeout: TimeoutProvenance | undefined
): { readonly timeout?: TimeoutProvenance } {
  return timeout === undefined ? {} : { timeout };
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
  const selected = diagnosticSelection(error, classified);
  if (selected.kind === "none") {
    return publicFailureIncident(failure, error);
  }
  return isReportedServiceError(selected.error)
    ? reframeFailureIncident(selected.error.incident, failure)
    : unreportedFailureIncident(failure, error, selected.error);
}

function diagnosticSelection(
  error: unknown,
  classified = classifyServiceError(error)
): DiagnosticSelection {
  if (error instanceof DiagnosticServiceError) {
    return { kind: "present", error: error.diagnosticCause };
  }
  if (error instanceof ProviderRecoveryRequiredError
    && error.hasDiagnosticCause) {
    return { kind: "present", error: error.diagnosticCause };
  }
  return classified.diagnostic === "required"
    ? { kind: "present", error }
    : { kind: "none" };
}

export function restoreStoredServiceFailure(
  failure: StoredServiceError
): unknown {
  const error = new ServiceError(
    failure.status ?? 500,
    failure.message,
    failure.code,
    failure.timeout === undefined ? {} : { timeout: failure.timeout }
  );
  return failure.kind === "diagnostic" || failure.code === "internal"
    ? errorFromFailureIncident(
        restoredFailureIncident(failure, error, error)
      )
    : error;
}

/** Once a failure envelope is durable, a missing reference is final. Domain
 * errors keep their original subtype. Unreported diagnostic errors need
 * restored provenance to prevent a later transport from inventing one. */
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
