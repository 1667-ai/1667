import {
  STREAM_METHODS,
  WORKER_BUILD_IDENTITY,
  WORKER_PROTOCOL_VERSION,
  WORKER_STARTUP_HEARTBEAT_MS,
  isMutatingWorkerMethod,
  isServiceOwnedSettingsMutation,
  isWorkerMutationMethod,
  workerOperationKey,
  type MainToWorkerMessage,
  type WorkerCancelReason,
  type WorkerMethod,
  type WorkerOperationId,
  type WorkerOperationState,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { randomBytes } from "node:crypto";
import {
  isDefinitiveProviderFailure,
  ProviderError,
  ServiceError,
  toPublicServiceError
} from "./errors.js";
import { resolveMachineTierRoot } from "./machine-tier.js";
import { StoryService } from "./story-service.js";
import { validateWorkerRequestSize } from "./worker-request-size.js";
import { WorkerDeltaBatcher } from "./worker-delta-batcher.js";
import {
  executeWorkerMutation,
  parseWorkerMutation,
  preflightWorkerMutation,
  storyIdForWorkerMutation
} from "./worker-mutations.js";
import { mutationFingerprint } from "./mutation-receipts.js";
import { storyIdForMutation } from "./story-identity.js";
import { requireRecord, requireString } from "./validation.js";
import {
  parseWorkerBootstrap,
  parseWorkerOperationId,
  parseWorkerRequest,
  preServiceWorkerMutationOutcome,
  rawWorkerMutationOutcome
} from "./worker-message.js";
import { WorkerOperationRegistry } from "./worker-operation-registry.js";
import { WorkerRequestCancellation } from "./worker-request-cancellation.js";

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
let initializing = false;
const active = new Map<string, ActiveRequest>();
let stopping = false;

runtime.onmessage = (event) => {
  void receive(event.data).catch((error: unknown) => {
    runtime.postMessage({ type: "protocolError", message: runtimeFailureMessage(error) });
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
    return runtime.postMessage({ type: "protocolError", message: publicMessage(error) });
  }
  if (message.type === "bootstrap") return await bootstrap(parseWorkerBootstrap(message));
  if (message.type === "shutdown") return await shutdown();
  if (message.type === "request") return await receiveRequest(message);
  if (message.type !== "ack"
    && message.type !== "cancel"
    && message.type !== "status"
    && message.type !== "terminalAck") {
    return runtime.postMessage({
      type: "protocolError",
      message: "Unknown worker message type"
    });
  }
  let id: WorkerOperationId;
  try {
    id = parseWorkerOperationId(message.id);
  } catch (error) {
    return runtime.postMessage({ type: "protocolError", message: publicMessage(error) });
  }
  if (message.type === "terminalAck") {
    try {
      if (operations.acknowledgeTerminal(id) === "running") {
        throw new ServiceError(409, "Cannot acknowledge a running worker operation");
      }
    } catch (error) {
      runtime.postMessage({ type: "protocolError", message: publicMessage(error) });
    }
    return;
  }
  let state: WorkerOperationState;
  try {
    state = operations.state(id);
  } catch (error) {
    return runtime.postMessage({ type: "protocolError", message: publicMessage(error) });
  }
  if (message.type === "cancel") {
    const reason = message.reason;
    if (reason !== "user" && reason !== "deadline" && reason !== "shutdown") {
      return runtime.postMessage({
        type: "protocolError",
        message: "cancel reason must be user, deadline, or shutdown"
      });
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
      return runtime.postMessage({
        type: "protocolError",
        message: "ack sequence must be a non-negative integer"
      });
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
    return runtime.postMessage({ type: "protocolError", message: publicMessage(error) });
  }
  try {
    if (operations.accept(id) === "capacity") {
      return postUntrackedError(
        id,
        new ServiceError(503, "Worker operation capacity is full", "resource_busy"),
        preServiceWorkerMutationOutcome(value)
      );
    }
  } catch (error) {
    return postUntrackedError(id, error, preServiceWorkerMutationOutcome(value));
  }
  let message: Extract<MainToWorkerMessage, { type: "request" }>;
  try {
    message = parseWorkerRequest(value, id);
  } catch (error) {
    return postError(id, error, rawWorkerMutationOutcome(value));
  }
  const mutation = isWorkerMutationMethod(message.method);
  if (service === null) {
    return postError(
      message.id,
      new ServiceError(503, "Embedded backend is still starting"),
      mutation ? "terminal" : undefined
    );
  }
  if (stopping) {
    return postError(
      message.id,
      new ServiceError(503, "Story service is shutting down"),
      mutation ? "terminal" : undefined
    );
  }
  try {
    validateWorkerRequestSize(
      message.method,
      message.input,
      message.protocolVersion
    );
  } catch (error) {
    return postError(message.id, error, mutation ? "terminal" : undefined);
  }

  const cancellation = new WorkerRequestCancellation(mutation);
  const deadlineDelay = message.deadlineMs - Date.now();
  if (deadlineDelay <= 0) {
    return postError(
      message.id,
      new ServiceError(408, "Worker request deadline exceeded"),
      mutation ? "terminal" : undefined
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
  const done = runRequest(message, cancellation, deltas).finally(() => {
    clearTimeout(deadline);
    active.delete(workerOperationKey(message.id));
  });
  active.set(workerOperationKey(message.id), { cancel, done, deltas });
  await done;
}

async function runRequest(
  message: Extract<MainToWorkerMessage, { type: "request" }>,
  cancellation: WorkerRequestCancellation,
  deltas: WorkerDeltaBatcher | null
): Promise<void> {
  const stream = STREAM_METHODS.has(message.method);
  try {
    const onDelta = (text: string) => deltas?.push(text);
    const mutation = isWorkerMutationMethod(message.method);
    let value: unknown;
    if (isServiceOwnedSettingsMutation(message.method)) {
      const input = requireRecord(message.input, `${message.method} input`);
      const command = requireRecord(input.command, "command");
      const settingsService = service!;
      value = message.method === "saveSettings"
        ? await settingsService.saveSettings(command)
        : await settingsService.discardPendingSettings(command);
    } else if (message.mutationId === undefined) {
      value = await invokeReadOnly(message.method, message.input, cancellation.signal);
    } else {
      const method = message.method;
      if (!isMutatingWorkerMethod(method)) throw new ServiceError(400, `${method} is not a mutation`);
      let parsed: ReturnType<typeof parseWorkerMutation<typeof method>> | undefined;
      // MutationReceiptStore invokes neither callback for an exact terminal
      // replay. For new/pending work, parse once after receipt identity wins;
      // preflight then runs before the first receipt is persisted.
      const input = () => parsed ??= parseWorkerMutation(method, message.input, message.protocolVersion);
      value = await service!.runMutation(
        message.mutationId,
        method,
        message.input,
        (plan) => {
          const parsedInput = input();
          const storyId = message.expectedAggregateVersion !== null
            && typeof message.expectedAggregateVersion === "object"
            && "kind" in message.expectedAggregateVersion
            && message.expectedAggregateVersion.kind === "absent"
            ? storyIdForMutation(message.mutationId!)
            : storyIdForWorkerMutation(parsedInput, plan);
          const storyMutationRequest = message.expectedAggregateVersion === undefined
            || storyId === null
            ? undefined
            : {
              transportOperationId: workerOperationKey(message.id),
              mutationId: message.mutationId!,
              fingerprint: mutationFingerprint(
                method,
                message.input,
                message.protocolVersion
              ),
              scope: `story:${storyId}` as const,
              expectedAggregateVersion: message.expectedAggregateVersion
            };
          return executeWorkerMutation(service!, parsedInput, plan, {
            onDelta,
            signal: cancellation.signal,
            ...(storyMutationRequest === undefined ? {} : {
              storyMutationRequest
            })
          });
        },
        message.protocolVersion,
        (plan) => message.expectedAggregateVersion === undefined
          ? preflightWorkerMutation(service!, input(), plan)
          : undefined
      );
    }
    cancellation.throwIfDeadlineExpired();
    if (stream && (cancellation.signal.aborted || value === null || value === false)) {
      deltas?.dispose();
      postTerminal(
        { type: "complete", id: message.id, value: null },
        cancellation.signal.aborted ? "canceled" : "completed"
      );
      return;
    }
    await deltas?.flush();
    cancellation.throwIfDeadlineExpired();
    postTerminal(
      stream
        ? { type: "complete", id: message.id, value }
        : { type: "result", id: message.id, value },
      "completed"
    );
  } catch (error) {
    const failure = cancellation.failure(error);
    const outcome = isWorkerMutationMethod(message.method) ? mutationOutcome(failure) : undefined;
    if (outcome === "uncertain") deltas?.dispose();
    else await deltas?.flush();
    postError(message.id, failure, outcome);
  } finally {
    deltas?.dispose();
  }
}

async function invokeReadOnly(
  method: WorkerMethod,
  value: unknown,
  signal: AbortSignal
): Promise<unknown> {
  if (service === null) throw new ServiceError(503, "Embedded backend is still starting");
  if (signal.aborted) throw new ServiceError(408, "Worker request deadline exceeded or was cancelled");
  const input = requireRecord(value, `${method} input`);
  switch (method) {
    case "listStories": return await service.listStories();
    case "listStoriesPage": return await service.listStoriesPage(input);
    case "loadStory": return await service.loadStory(requireString(input.id, "id"));
    case "getUnknownOutcomeStatus": return await service.getUnknownOutcomeStatus(
      requireString(input.storyId, "storyId"),
      requireString(input.originalProviderMutationId, "originalProviderMutationId")
    );
    case "previewChapterBreakRemoval": {
      const preview = await service.previewChapterBreakRemoval(
        requireString(input.storyId, "storyId"),
        requireString(input.breakId, "breakId")
      );
      return {
        removedFingerprint: preview.removedFingerprint,
        aggregateVersion: preview.aggregateVersion
      };
    }
    case "exportMarkdown": return await service.exportMarkdown(requireString(input.id, "id"));
    case "getSettings": return await service.getSettings();
    case "checkModelServer":
      return await service.checkModelServer(requireRecord(input.settings, "settings"), signal);
    case "probeContextWindow":
      return await service.probeContextWindow(requireRecord(input.settings, "settings"), signal);
    case "discoverModels":
      return await service.discoverModels(requireRecord(input.settings, "settings"), signal);
    default: throw new ServiceError(400, `${method} is not a read-only worker method`);
  }
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
  runtime.postMessage({ type: "stopped" });
  setTimeout(() => runtime.close(), 0);
}

async function bootstrap(message: Extract<MainToWorkerMessage, { type: "bootstrap" }>): Promise<void> {
  if (service !== null || initializing) throw new ServiceError(409, "Embedded backend was already bootstrapped");
  initializing = true;
  const candidate = new StoryService({
    dataDir: message.dataDir,
    machineDir: message.machineDir ?? await resolveMachineTierRoot(),
    dataLock: "external",
    mutationRecovery: "external",
    starterVault: "seed-when-new",
    freshDataDirectory: message.freshDataDirectory === true
  });
  try {
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
    await candidate.dispose();
    throw error;
  } finally {
    initializing = false;
  }
}
function postError(
  id: WorkerOperationId,
  error: unknown,
  mutationOutcome?: "terminal" | "uncertain"
): void {
  operations.finish(id, "failed");
  postUntrackedError(id, error, mutationOutcome);
}

function postUntrackedError(
  id: WorkerOperationId,
  error: unknown,
  mutationOutcome?: "terminal" | "uncertain"
): void {
  const known = toPublicServiceError(error);
  runtime.postMessage({
    type: "error",
    id,
    code: known.code,
    message: known.message,
    details: { status: known.status },
    ...(mutationOutcome === undefined ? {} : { mutationOutcome })
  });
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

function mutationOutcome(error: unknown): "terminal" | "uncertain" {
  const code = toPublicServiceError(error).code;
  if (code === "mutation_outcome_unknown" || code === "generation_outcome_unknown") return "uncertain";
  if (error instanceof ProviderError) {
    return isDefinitiveProviderFailure(error) ? "terminal" : "uncertain";
  }
  if (error instanceof ServiceError) return error.code === "internal" ? "uncertain" : "terminal";
  return "uncertain";
}

function publicMessage(error: unknown): string {
  return error instanceof ServiceError ? error.message : "Malformed worker message";
}

function runtimeFailureMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) {
    return `Embedded backend failed: ${error.message}`;
  }
  return "Embedded backend failed during startup or shutdown";
}
