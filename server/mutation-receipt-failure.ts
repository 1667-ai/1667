import {
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import { DiagnosticServiceError } from "./errors.js";
import {
  errorFromFailureIncident,
  isReportedServiceError,
  type ReportedServiceError,
  type ServiceFailureIncident
} from "./reported-service-error.js";
import {
  finalizeDurableServiceFailure,
  prepareServiceFailure
} from "./service-error-policy.js";

export type MutationReceiptFailureReporter = (
  error: unknown
) => Promise<ServiceFailureIncident>;

export class MutationReceiptPersistenceError extends DiagnosticServiceError {
  constructor(diagnosticCause: unknown) {
    super(
      500,
      "Mutation receipt durability could not be confirmed; the backend stopped and retained the request for recovery.",
      "mutation_outcome_unknown",
      diagnosticCause
    );
    this.name = "MutationReceiptPersistenceError";
    Object.freeze(this);
  }
}

/** Owns report-before-save and durable terminal failure transitions. */
export class MutationReceiptFailureTerminalizer {
  constructor(
    private readonly reportFailure: MutationReceiptFailureReporter =
      async (error) => prepareServiceFailure(error)
  ) {}

  async reject(error: unknown): Promise<never> {
    throw errorFromFailureIncident(await this.reportFailure(error));
  }

  async persist(
    error: unknown,
    save: (failure: FailureEnvelope) => Promise<void>
  ): Promise<never> {
    const prepared = await this.reportFailure(error);
    await save(prepared.failure);
    throw finalizeDurableServiceFailure(prepared);
  }

  async persistenceFailure(
    error: unknown
  ): Promise<unknown> {
    const failure = isMutationReceiptPersistenceError(error)
      ? error
      : new MutationReceiptPersistenceError(error);
    return errorFromFailureIncident(await this.reportFailure(failure));
  }
}

export function isMutationReceiptPersistenceError(
  error: unknown
): error is MutationReceiptPersistenceError | ReportedServiceError {
  if (error instanceof MutationReceiptPersistenceError) return true;
  return isReportedServiceError(error)
    && error.incident.source instanceof MutationReceiptPersistenceError;
}
