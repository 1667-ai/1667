import {
  isServiceOwnedSettingsMutation,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import type {
  ProviderRecoveryContext
} from "../../shared/provider-recovery.js";
import {
  providerRecoveryFromArchive,
  storyIdFromMutationIntent
} from "../../server/mutation-outbox.js";
import {
  WorkerApiError,
  workerApiErrorFromFailure
} from "./worker-error.js";
import type { SerializedWorkerOutbox } from "./worker-outbox.js";
import type { PendingCall, PendingRequestRegistry } from "./worker-pending.js";
import type {
  OutboxRecoveryCoordinator,
  RecoveryWarning
} from "./worker-recovery.js";

type TerminalMessage = Extract<
  WorkerToMainMessage,
  { type: "result" | "complete" | "error" }
>;

interface WorkerTerminalContext {
  message: TerminalMessage;
  pending: PendingCall;
  pendingRequests: PendingRequestRegistry;
  outbox: SerializedWorkerOutbox;
  recovery: OutboxRecoveryCoordinator<WorkerApiError>;
  acknowledge(): void;
  fail(error: Error): void;
}

/** Reconciles durable caller state before releasing one terminal operation. */
export async function settleWorkerTerminal(
  context: WorkerTerminalContext
): Promise<void> {
  const release = context.outbox.retain();
  try {
    await settleOwnedWorkerTerminal(context);
  } catch (error) {
    context.fail(error instanceof Error ? error : new Error(String(error)));
  } finally {
    release();
  }
}

async function settleOwnedWorkerTerminal(
  context: WorkerTerminalContext
): Promise<void> {
  const {
    message,
    pending,
    pendingRequests,
    outbox,
    recovery
  } = context;
  if (pending.settling) return;
  pending.settling = true;
  pending.cleanup();
  const uncertainMutation = message.type === "error"
    && (pending.mutationId !== undefined
      || isServiceOwnedSettingsMutation(pending.method))
    && message.mutationOutcome !== "terminal";
  let replayResolution: RecoveryWarning<WorkerApiError>["resolution"] | null = null;
  let warningStoryId: string | null = null;
  let providerRecovery: ProviderRecoveryContext | undefined;
  const mutationId = pending.mutationId;
  const store = outbox.store;
  // Local-durability-tier mutations publish no intent, so there is nothing
  // durable to remove or archive here. Terminal recovery below still runs.
  if (mutationId !== undefined && store !== null && pending.durableIntent) {
    if (uncertainMutation && message.type === "error") {
      const archived = await outbox.run(() => store.archive(
        mutationId,
        message.failure,
        message.providerMutationId
      ));
      replayResolution = "archived";
      warningStoryId = storyIdFromMutationIntent(archived.intent);
      providerRecovery = providerRecoveryFromArchive(archived);
    } else if (!uncertainMutation) {
      await outbox.run(() => store.remove(mutationId));
      if (pending.replay && message.type === "error") {
        replayResolution = "cleared";
      }
    }
  }
  if (!pendingRequests.isCurrent(pending)) return;
  if (message.type === "error"
    && pending.replay
    && pending.mutationId !== undefined) {
    pendingRequests.discard(message.id);
    context.acknowledge();
    const error = workerError(message);
    const replayRecord = recovery.recordFor(pending.mutationId);
    recovery.warn({
      mutationId: pending.mutationId,
      method: pending.method,
      storyId: warningStoryId ?? storyIdFromMutationIntent(
        replayRecord
      ),
      ...(providerRecovery === undefined
        ? {}
        : { providerRecovery }),
      resolution: replayResolution
        ?? (uncertainMutation ? "archived" : "cleared"),
      error
    });
    pending.resolve(undefined);
    return;
  }
  if (message.type === "error"
    && uncertainMutation
    && pending.mutationId !== undefined) {
    pendingRequests.discard(message.id);
    context.acknowledge();
    const error = workerError(message);
    recovery.warn({
      mutationId: pending.mutationId,
      method: pending.method,
      storyId: warningStoryId,
      ...(providerRecovery === undefined
        ? {}
        : { providerRecovery }),
      resolution: replayResolution ?? "archived",
      error
    });
    pending.reject(error);
    return;
  }
  if (uncertainMutation && message.type === "error") {
    pendingRequests.discard(message.id);
    context.acknowledge();
    pending.reject(workerError(message));
    return;
  }
  if (!pendingRequests.isCurrent(pending)) return;
  pendingRequests.discard(message.id);
  context.acknowledge();
  if (message.type === "error") {
    pending.reject(workerError(message));
    return;
  }
  pending.resolve(message.value);
}

function workerError(
  message: Extract<WorkerToMainMessage, { type: "error" }>
): WorkerApiError {
  return workerApiErrorFromFailure(message.failure);
}
