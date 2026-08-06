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
  readonly mutationId?: string;
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
    mutationId: string | undefined,
    mutationOutcome?: WorkerMutationFailureOutcome
  ): WorkerRequestFailureResponder {
    return new WorkerRequestFailureResponder(
      this.sink,
      this.reporter,
      this.operations,
      this.id,
      { operation, mutationId, mutationOutcome }
    );
  }

  async tracked(
    error: unknown,
    ...override: [
      mutationOutcome?: WorkerMutationFailureOutcome,
      unsentText?: string
    ]
  ): Promise<void> {
    const message = await this.message(
      error,
      override.length === 0
        ? this.context.mutationOutcome
        : override[0]
    );
    this.operations.finish(this.id, "failed");
    const unsentText = override[1];
    this.sink.postMessage(
      unsentText === undefined || unsentText.length === 0
        ? message
        : { ...message, unsentText }
    );
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
      mutationId: this.context.mutationId,
      mutationOutcome
    });
  }
}
