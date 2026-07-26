import {
  STREAM_METHODS,
  WORKER_BUILD_IDENTITY,
  WORKER_PROTOCOL_VERSION,
  WORKER_STARTUP_HEARTBEAT_MS,
  isWorkerMethod,
  isWorkerMutationMethod,
  workerOperationKey,
  type MainToWorkerMessage,
  type WorkerCancelReason,
  type WorkerOperationId,
  type WorkerOperationState,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { randomBytes } from "node:crypto";
import { ServiceError } from "./errors.js";
import { StoryService } from "./story-service.js";
import { validateWorkerRequestSize } from "./worker-request-size.js";
import { WorkerDeltaBatcher } from "./worker-delta-batcher.js";
import { WorkerErrorReporter } from "./worker-error-reporter.js";
import { requireRecord } from "./validation.js";
import {
  parseWorkerBootstrap,
  parseWorkerOperationId,
  parseWorkerRequest,
  preServiceWorkerMutationOutcome,
  rawWorkerMutationOutcome
} from "./worker-message.js";
import { WorkerOperationRegistry } from "./worker-operation-registry.js";
import { WorkerRequestCancellation } from "./worker-request-cancellation.js";
import { WorkerRequestFailureResponder } from "./worker-request-failure-responder.js";
import { createFailureEnvelope } from "../shared/failure-envelope.js";
import { resolveDiagnosticMachineTier } from "./diagnostic-machine-tier.js";
import { executeWorkerRequest } from "./worker-request-executor.js";
import { localStartupFailure } from "./local-startup-failure.js";
import { errorFromFailureIncident } from "./reported-service-error.js";

interface WorkerRuntime {
  postMessage(message: WorkerToMainMessage): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
}

interface ActiveRequest {
  cancel(reason: WorkerCancelReason): void;
  done: Promise<void>;
  deltas: WorkerDeltaBatcher | null;
}

const runtime = globalThis as unknown as WorkerRuntime;
const workerInstanceId = randomBytes(16).toString("hex");
const operations = new WorkerOperationRegistry(workerInstanceId);
let service: StoryService | null = null;
let errorReporter = WorkerErrorReporter.disabled();
let initializing = false;
const active = new Map<string, ActiveRequest>();
let stopping = false;

runtime.onmessage = (event) => {
  void receive(event.data).catch(async (error: unknown) => {
    const reported = await errorReporter.runtimeMessage(
      error,
      { service: "embedded-worker-protocol" }
    );
    runtime.postMessage({
      type: "protocolError",
      ...reported
    });
  });
};

runtime.postMessage({
  type: "starting",
  protocolVersion: WORKER_PROTOCOL_VERSION,
  buildIdentity: WORKER_BUILD_IDENTITY,
  workerInstanceId
});
const startupHeartbeat = setInterval(() => {
  runtime.postMessage({
    type: "starting",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    buildIdentity: WORKER_BUILD_IDENTITY,
    workerInstanceId
  });
}, WORKER_STARTUP_HEARTBEAT_MS);

async function receive(value: unknown): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = requireRecord(value, "worker message");
  } catch (error) {
    return postProtocolError(publicMessage(error));
  }
  if (message.type === "bootstrap") return await bootstrap(parseWorkerBootstrap(message));
  if (message.type === "shutdown") return await shutdown();
  if (message.type === "request") return await receiveRequest(message);
  if (message.type !== "ack"
    && message.type !== "cancel"
    && message.type !== "status"
    && message.type !== "terminalAck") {
    return postProtocolError("Unknown worker message type");
  }
  let id: WorkerOperationId;
  try {
    id = parseWorkerOperationId(message.id);
  } catch (error) {
    return postProtocolError(publicMessage(error));
  }
  if (message.type === "terminalAck") {
    try {
      if (operations.acknowledgeTerminal(id) === "running") {
        throw new ServiceError(409, "Cannot acknowledge a running worker operation");
      }
    } catch (error) {
      postProtocolError(publicMessage(error));
    }
    return;
  }
  let state: WorkerOperationState;
  try {
    state = operations.state(id);
  } catch (error) {
    return postProtocolError(publicMessage(error));
  }
  if (message.type === "cancel") {
    const reason = message.reason;
    if (reason !== "user" && reason !== "deadline" && reason !== "shutdown") {
      return postProtocolError(
        "cancel reason must be user, deadline, or shutdown"
      );
    }
    const request = active.get(workerOperationKey(id));
    request?.cancel(reason);
    request?.deltas?.dispose();
    postOperation(id, state);
    return;
  }
  if (message.type === "ack") {
    const sequence = message.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
      return postProtocolError(
        "ack sequence must be a non-negative integer"
      );
    }
    active.get(workerOperationKey(id))?.deltas?.acknowledge(sequence);
    return;
  }
  postOperation(id, state);
}

async function receiveRequest(value: Record<string, unknown>): Promise<void> {
  let id: WorkerOperationId;
  try {
    id = parseWorkerOperationId(value.id);
  } catch (error) {
    return postProtocolError(publicMessage(error));
  }
  const operation = isWorkerMethod(value.method) ? value.method : undefined;
  let failures = new WorkerRequestFailureResponder(
    runtime,
    errorReporter,
    operations,
    id,
    {
      operation,
      mutationOutcome: preServiceWorkerMutationOutcome(value)
    }
  );
  try {
    if (operations.accept(id) === "capacity") {
      return failures.untracked(
        new ServiceError(503, "Worker operation capacity is full", "resource_busy")
      );
    }
  } catch (error) {
    return failures.untracked(error);
  }
  let message: Extract<MainToWorkerMessage, { type: "request" }>;
  try {
    message = parseWorkerRequest(value, id);
  } catch (error) {
    return failures.tracked(error, rawWorkerMutationOutcome(value));
  }
  const mutation = isWorkerMutationMethod(message.method);
  failures = failures.forParsedRequest(
    message.method,
    mutation ? "terminal" : undefined
  );
  if (service === null) {
    return failures.tracked(
      new ServiceError(
        503,
        "Embedded backend is still starting",
        "resource_busy"
      )
    );
  }
  if (stopping) {
    return failures.tracked(
      new ServiceError(503, "Story service is shutting down", "resource_busy")
    );
  }
  try {
    validateWorkerRequestSize(
      message.method,
      message.input,
      message.protocolVersion
    );
  } catch (error) {
    return failures.tracked(error);
  }

  const cancellation = new WorkerRequestCancellation(mutation);
  const deadlineDelay = message.deadlineMs - Date.now();
  if (deadlineDelay <= 0) {
    return failures.tracked(
      new ServiceError(408, "Worker request deadline exceeded")
    );
  }
  const cancel = (reason: WorkerCancelReason) => cancellation.cancel(reason);
  const deadline = setTimeout(() => cancel("deadline"), deadlineDelay);
  // The main transport owns the hard deadline: it terminates this worker and
  // retains the durable outbox, so unary code cannot continue committing after
  // its caller has been rejected. This local signal cancels cooperative work
  // and prevents a stale read result from crossing the boundary.
  const deltas = STREAM_METHODS.has(message.method)
    ? new WorkerDeltaBatcher(message.id, (delta) => runtime.postMessage(delta))
    : null;
  const done = executeWorkerRequest(
    service,
    message,
    cancellation,
    deltas,
    failures,
    postTerminal
  ).finally(() => {
    clearTimeout(deadline);
    active.delete(workerOperationKey(message.id));
  });
  active.set(workerOperationKey(message.id), {
    cancel,
    done,
    deltas
  });
  await done;
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const request of active.values()) {
    request.cancel("shutdown");
    request.deltas?.dispose();
  }
  await Promise.allSettled([...active.values()].map((request) => request.done));
  clearInterval(startupHeartbeat);
  await service?.dispose();
  await errorReporter.close().catch(() => undefined);
  errorReporter = WorkerErrorReporter.disabled();
  runtime.postMessage({ type: "stopped" });
  setTimeout(() => runtime.close(), 0);
}

async function bootstrap(message: Extract<MainToWorkerMessage, { type: "bootstrap" }>): Promise<void> {
  if (service !== null || initializing) throw new ServiceError(409, "Embedded backend was already bootstrapped");
  const machineDir = await resolveDiagnosticMachineTier(
    message.machineDir,
    {
      service: "embedded-worker-startup",
      operation: "machine-tier-resolution"
    },
    { print: message.printLogs === true }
  );
  const candidateReporter = await WorkerErrorReporter.open(machineDir, {
    print: message.printLogs === true
  });
  if (service !== null || initializing) {
    await candidateReporter.close().catch(() => undefined);
    throw new ServiceError(409, "Embedded backend was already bootstrapped");
  }
  initializing = true;
  await errorReporter.close().catch(() => undefined);
  errorReporter = candidateReporter;
  let candidate: StoryService | null = null;
  try {
    candidate = new StoryService({
      dataDir: message.dataDir,
      machineDir,
      dataLock: "external",
      mutationRecovery: "external",
      errorReporter: candidateReporter.internalReporter,
      starterVault: "seed-when-new",
      freshDataDirectory: message.freshDataDirectory === true
    });
    await candidate.init();
    service = candidate;
    clearInterval(startupHeartbeat);
    runtime.postMessage({
      type: "ready",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      buildIdentity: WORKER_BUILD_IDENTITY,
      workerInstanceId
    });
  } catch (error) {
    clearInterval(startupHeartbeat);
    let failure = localStartupFailure(error);
    try {
      await candidate?.dispose();
    } catch (cleanupError) {
      failure = new AggregateError(
        [failure, cleanupError],
        "Embedded backend startup and cleanup both failed",
        { cause: failure }
      );
    }
    try {
      const reported = await candidateReporter.internalReporter.report(
        failure,
        {
          service: "embedded-worker-startup",
          operation: "bootstrap"
        }
      );
      throw errorFromFailureIncident(reported);
    } finally {
      await candidateReporter.close().catch(() => undefined);
      if (errorReporter === candidateReporter) {
        errorReporter = WorkerErrorReporter.disabled();
      }
    }
  } finally {
    initializing = false;
  }
}

function postTerminal(
  message: Extract<WorkerToMainMessage, { type: "result" | "complete" }>,
  state: "completed" | "canceled"
): void {
  operations.finish(message.id, state);
  runtime.postMessage(message);
}

function postOperation(id: WorkerOperationId, state: WorkerOperationState): void {
  runtime.postMessage({
    type: "operation",
    id,
    state,
    terminal: state !== "running"
  });
}

function publicMessage(error: unknown): string {
  return error instanceof ServiceError
    ? error.message
    : "Malformed worker message";
}

function postProtocolError(message: string): void {
  runtime.postMessage({
    type: "protocolError",
    failure: createFailureEnvelope({
      code: "invalid_request",
      message,
      status: 400
    })
  });
}
