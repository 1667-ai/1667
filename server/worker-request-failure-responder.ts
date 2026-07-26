import type {
  WorkerMethod,
  WorkerOperationId,
  WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { WorkerOperationRegistry } from "./worker-operation-registry.js";
import type { WorkerErrorMessageContext } from "./worker-error-reporter.js";

export type WorkerMutationFailureOutcome = "terminal" | "uncertain";

interface WorkerMessageSink {
  postMessage(message: WorkerToMainMessage): void;
}

interface WorkerFailureReporter {
  workerMessage(
    id: WorkerOperationId,
    error: unknown,
    context?: WorkerErrorMessageContext
  ): Promise<Extract<WorkerToMainMessage, { type: "error" }>>;
}

interface WorkerRequestFailureContext {
  readonly operation?: WorkerMethod;
  readonly mutationOutcome?: WorkerMutationFailureOutcome;
}

/** Request-scoped owner for worker failure lifecycle, diagnostics, and wire
 * encoding. The dispatcher only decides whether an outcome is terminal. */
export class WorkerRequestFailureResponder {
  constructor(
    private readonly sink: WorkerMessageSink,
    private readonly reporter: WorkerFailureReporter,
    private readonly operations: WorkerOperationRegistry,
    private readonly id: WorkerOperationId,
    private readonly context: WorkerRequestFailureContext
  ) {}

  forParsedRequest(
    operation: WorkerMethod,
    mutationOutcome?: WorkerMutationFailureOutcome
  ): WorkerRequestFailureResponder {
    return new WorkerRequestFailureResponder(
      this.sink,
      this.reporter,
      this.operations,
      this.id,
      { operation, mutationOutcome }
    );
  }

  async tracked(
    error: unknown,
    ...override: [
      mutationOutcome?: WorkerMutationFailureOutcome
    ]
  ): Promise<void> {
    const message = await this.message(
      error,
      override.length === 0
        ? this.context.mutationOutcome
        : override[0]
    );
    this.operations.finish(this.id, "failed");
    this.sink.postMessage(message);
  }

  async untracked(
    error: unknown,
    mutationOutcome = this.context.mutationOutcome
  ): Promise<void> {
    this.sink.postMessage(await this.message(error, mutationOutcome));
  }

  private async message(
    error: unknown,
    mutationOutcome?: WorkerMutationFailureOutcome
  ): Promise<Extract<WorkerToMainMessage, { type: "error" }>> {
    return await this.reporter.workerMessage(this.id, error, {
      operation: this.context.operation,
      mutationOutcome
    });
  }
}
