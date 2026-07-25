import {
  isServiceOwnedSettingsMutation,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import { storyIdFromMutationIntent } from "../../server/mutation-outbox.js";
import { WorkerApiError } from "./worker-error.js";
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
  const mutationId = pending.mutationId;
  const store = outbox.store;
  if (mutationId !== undefined && store !== null) {
    if (pending.replay && uncertainMutation && message.type === "error") {
      await outbox.run(() => store.archive(mutationId, {
        code: message.code,
        message: message.message,
        status: message.details?.status ?? null
      }));
      replayResolution = "archived";
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
    recovery.warn({
      mutationId: pending.mutationId,
      method: pending.method,
      storyId: storyIdFromMutationIntent(
        recovery.recordFor(pending.mutationId)
      ),
      resolution: replayResolution
        ?? (uncertainMutation ? "archived" : "cleared"),
      error
    });
    pending.resolve(undefined);
    return;
  }
  if (uncertainMutation && message.type === "error") {
    context.fail(workerError(message));
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
  return new WorkerApiError(
    message.message,
    message.code,
    message.details?.status ?? null
  );
}
