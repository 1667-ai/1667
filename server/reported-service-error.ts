import type {
  DiagnosticFailureEnvelope,
  FailureEnvelope,
  PlainFailureEnvelope
} from "../shared/failure-envelope.js";
import {
  createFailureEnvelope,
  diagnosticReferenceFromFailure
} from "../shared/failure-envelope.js";
import type { DiagnosticReference } from "../shared/diagnostic-reference.js";
import { ServiceError } from "./errors.js";

export type ServiceFailureIncident =
  | {
      readonly persistence: "not-required";
      readonly failure: PlainFailureEnvelope;
      readonly source: unknown;
      readonly diagnostic: null;
    }
  | {
      readonly persistence: "unreported";
      readonly failure: PlainFailureEnvelope;
      readonly source: unknown;
      readonly diagnostic: unknown;
    }
  | {
      readonly persistence: "logged";
      readonly failure: DiagnosticFailureEnvelope;
      readonly source: unknown;
      readonly diagnostic: unknown;
    }
  | {
      readonly persistence: "durable";
      readonly failure: FailureEnvelope;
      readonly source: unknown;
      readonly diagnostic: unknown;
    };

/** The one throwable adapter for an immutable private-failure incident. */
export class ReportedServiceError extends ServiceError {
  constructor(readonly incident: ServiceFailureIncident) {
    const failure = incident.failure;
    super(
      failure.status ?? 500,
      failure.message,
      failure.code,
      { cause: incident.diagnostic ?? incident.source }
    );
    this.name = "ReportedServiceError";
    Object.freeze(this);
  }

  get failure(): FailureEnvelope {
    return this.incident.failure;
  }
}

export function publicFailureIncident(
  failure: PlainFailureEnvelope,
  source: unknown
): ServiceFailureIncident {
  return freezeIncident({
    persistence: "not-required",
    failure,
    source,
    diagnostic: null
  });
}

export function unreportedFailureIncident(
  failure: PlainFailureEnvelope,
  source: unknown,
  diagnostic: unknown
): ServiceFailureIncident {
  return freezeIncident({
    persistence: "unreported",
    failure,
    source,
    diagnostic
  });
}

export function loggedFailureIncident(
  incident: ServiceFailureIncident,
  reference: DiagnosticReference | undefined
): ServiceFailureIncident {
  if (incident.persistence !== "unreported" || reference === undefined) {
    return incident;
  }
  const failure = createFailureEnvelope(incident.failure, reference);
  return failure.kind === "diagnostic"
    ? freezeIncident({
        persistence: "logged",
        failure,
        source: incident.source,
        diagnostic: incident.diagnostic
      })
    : incident;
}

export function durableFailureIncident(
  incident: ServiceFailureIncident
): ServiceFailureIncident {
  if (incident.persistence === "not-required"
    || incident.persistence === "durable") {
    return incident;
  }
  return freezeIncident({
    persistence: "durable",
    failure: incident.failure,
    source: incident.source,
    diagnostic: incident.diagnostic
  });
}

export function restoredFailureIncident(
  failure: FailureEnvelope,
  source: unknown,
  diagnostic: unknown
): ServiceFailureIncident {
  return freezeIncident({
    persistence: "durable",
    failure,
    source,
    diagnostic
  });
}

export function reframeFailureIncident(
  incident: ServiceFailureIncident,
  failure: PlainFailureEnvelope
): ServiceFailureIncident {
  if (incident.persistence === "not-required") {
    return publicFailureIncident(failure, incident.source);
  }
  if (incident.persistence === "unreported") {
    return unreportedFailureIncident(
      failure,
      incident.source,
      incident.diagnostic
    );
  }
  const linked = createFailureEnvelope(
    failure,
    diagnosticReferenceFromFailure(incident.failure)
  );
  if (incident.persistence === "logged" && linked.kind === "diagnostic") {
    return freezeIncident({
      persistence: "logged",
      failure: linked,
      source: incident.source,
      diagnostic: incident.diagnostic
    });
  }
  return freezeIncident({
    persistence: "durable",
    failure: linked,
    source: incident.source,
    diagnostic: incident.diagnostic
  });
}

export function errorFromFailureIncident(
  incident: ServiceFailureIncident
): unknown {
  return incident.persistence === "not-required"
    ? incident.source
    : new ReportedServiceError(incident);
}

export function isReportedServiceError(
  error: unknown
): error is ReportedServiceError {
  return error instanceof ReportedServiceError;
}

function freezeIncident<T extends ServiceFailureIncident>(incident: T): T {
  return Object.freeze(incident);
}
