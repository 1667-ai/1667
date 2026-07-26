import {
  workerOperationKey,
  type WorkerMethod,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import type { InternalErrorContext } from "./internal-error-log.js";
import type { FailureEnvelope } from "../shared/failure-envelope.js";
import {
  InternalErrorReporter,
  type InternalErrorReporterOptions
} from "./internal-error-reporter.js";

export type WorkerErrorReporterOptions = InternalErrorReporterOptions;

export interface ReportedRuntimeError {
  readonly failure: FailureEnvelope;
}

export interface WorkerErrorMessageContext {
  readonly operation?: WorkerMethod;
  readonly mutationOutcome?: "terminal" | "uncertain";
}

/** Worker wire adapter over the transport-neutral diagnostic reporter. */
export class WorkerErrorReporter {
  private constructor(private readonly reporter: InternalErrorReporter) {}

  get internalReporter(): InternalErrorReporter {
    return this.reporter;
  }

  static disabled(): WorkerErrorReporter {
    return new WorkerErrorReporter(InternalErrorReporter.disabled());
  }

  static async open(
    machineDir: string,
    options: WorkerErrorReporterOptions = {}
  ): Promise<WorkerErrorReporter> {
    return new WorkerErrorReporter(
      await InternalErrorReporter.open(machineDir, options)
    );
  }

  async runtimeMessage(
    error: unknown,
    context: InternalErrorContext
  ): Promise<ReportedRuntimeError> {
    const reported = await this.reporter.report(error, context);
    return { failure: reported.failure };
  }

  async workerMessage(
    id: WorkerOperationId,
    error: unknown,
    context: WorkerErrorMessageContext = {}
  ): Promise<Extract<WorkerToMainMessage, { type: "error" }>> {
    const reported = await this.reporter.report(error, {
      service: "embedded-worker",
      workerOperationId: workerOperationKey(id),
      ...(context.operation === undefined
        ? {}
        : { operation: context.operation })
    });
    return {
      type: "error",
      id,
      failure: reported.failure,
      ...(context.mutationOutcome === undefined
        ? {}
        : { mutationOutcome: context.mutationOutcome })
    };
  }

  async close(): Promise<void> {
    await this.reporter.close();
  }
}
