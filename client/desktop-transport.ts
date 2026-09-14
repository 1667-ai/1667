import { ApiFailureError } from "./api-error.js";
import type { StoryWorkerTransport } from "./worker-story-api.js";
import type { ReasoningDelta } from "./reasoning.js";
import type {
  WorkerInput,
  WorkerMethod,
  WorkerOperationId,
  WorkerOutput
} from "../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import {
  decodeDesktopMainMessage,
  workerOperationKey,
  type DesktopCallId,
  type DesktopMainMessage,
  type DesktopRecoveryWarning,
  type DesktopRendererMessage
} from "../shared/desktop-shell.js";

export interface DesktopRendererPort {
  postMessage(message: DesktopRendererMessage): void;
  addEventListener(type: "message" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "messageerror", listener: EventListener): void;
  start?(): void;
  close?(): void;
}

interface PendingCall {
  readonly callId: DesktopCallId;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onDelta?: (text: string) => void;
  readonly onStopped?: (text: string) => void;
  readonly onReasoning?: (delta: ReasoningDelta) => void;
  readonly onReasoningStopped?: (text: string) => void;
  abortCleanup?: () => void;
  operationId?: WorkerOperationId;
  expectedSequence: number;
  cancelled: boolean;
  stoppedText: string;
  stoppedReasoningText: string;
}

export interface DesktopTransportOptions {
  readonly onRecoveryWarnings?: (
    warnings: readonly DesktopRecoveryWarning[]
  ) => void;
}

/** Renderer-side StoryWorkerTransport over the isolated desktop MessagePort. */
export class DesktopTransport implements StoryWorkerTransport {
  private nextCallId = 1;
  private readonly pendingByCall = new Map<DesktopCallId, PendingCall>();
  private readonly pendingByOperation = new Map<string, PendingCall>();
  private closed = false;

  private readonly onMessage = ((event: MessageEvent<unknown>) => {
    this.receive(event.data);
  }) as EventListener;
  private readonly onMessageError = (() => {
    this.close();
  }) as EventListener;

  constructor(
    private readonly port: DesktopRendererPort,
    private readonly options: DesktopTransportOptions = {}
  ) {
    port.addEventListener("message", this.onMessage);
    port.addEventListener("messageerror", this.onMessageError);
    port.start?.();
  }

  call<M extends WorkerMethod>(
    method: M,
    input: WorkerInput<M>,
    options: {
      onDelta?: (text: string) => void;
      onStopped?: (text: string) => void;
      onReasoning?: (delta: ReasoningDelta) => void;
      onReasoningStopped?: (text: string) => void;
      signal?: AbortSignal;
      expectedAggregateVersion?: StoryAggregateVersion;
    } = {}
  ): Promise<WorkerOutput<M>> {
    if (this.closed) return Promise.reject(new Error("Desktop transport is closed."));
    if (options.signal?.aborted) return Promise.resolve(null as WorkerOutput<M>);
    const callId = `c${this.nextCallId++}`;
    return new Promise<WorkerOutput<M>>((resolve, reject) => {
      const pending: PendingCall = {
        callId,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        ...(options.onStopped === undefined ? {} : { onStopped: options.onStopped }),
        ...(options.onReasoning === undefined ? {} : { onReasoning: options.onReasoning }),
        ...(options.onReasoningStopped === undefined ? {} : { onReasoningStopped: options.onReasoningStopped }),
        expectedSequence: 0,
        cancelled: false,
        stoppedText: "",
        stoppedReasoningText: ""
      };
      this.pendingByCall.set(callId, pending);
      const onAbort = (): void => {
        if (!this.pendingByCall.has(callId) || pending.cancelled) return;
        pending.cancelled = true;
        const id = pending.operationId;
        if (id !== undefined) this.sendCancelSafely(id);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      pending.abortCleanup = options.signal === undefined
        ? undefined
        : () => options.signal?.removeEventListener("abort", onAbort);
      try {
        this.send({
          type: "request",
          callId,
          method,
          input,
          ...(options.expectedAggregateVersion === undefined
            ? {}
            : { expectedAggregateVersion: options.expectedAggregateVersion })
        });
      } catch (error) {
        pending.abortCleanup?.();
        this.removePending(pending);
        reject(asError(error));
      }
    });
  }

  async dismissArchivedMutation(mutationId: string): Promise<void> {
    if (this.closed) return;
    const callId = `d${this.nextCallId++}`;
    await new Promise<void>((resolve, reject) => {
      const pending: PendingCall = {
        callId,
        resolve: () => resolve(),
        reject,
        expectedSequence: 0,
        cancelled: false,
        stoppedText: "",
        stoppedReasoningText: ""
      };
      this.pendingByCall.set(callId, pending);
      try {
        this.send({ type: "dismissArchivedMutation", callId, mutationId });
      } catch (error) {
        this.removePending(pending);
        reject(asError(error));
      }
    });
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener("message", this.onMessage);
    this.port.removeEventListener("messageerror", this.onMessageError);
    this.port.close?.();
    this.failAll(reason ?? new Error("Desktop transport closed."));
  }

  private receive(value: unknown): void {
    const message = decodeDesktopMainMessage(value);
    if (message === null) {
      this.close();
      return;
    }
    if (message.type === "recoveryWarnings") {
      this.options.onRecoveryWarnings?.(message.warnings);
      return;
    }
    if (message.type === "protocolError") {
      this.close(new ApiFailureError(message.failure));
      return;
    }
    if (message.type === "accepted") {
      const pending = this.pendingByCall.get(message.callId);
      if (pending === undefined) return;
      pending.operationId = message.id;
      this.pendingByOperation.set(workerOperationKey(message.id), pending);
      if (pending.cancelled) this.sendCancelSafely(message.id);
      return;
    }
    if (message.type === "rejected") {
      const pending = this.pendingByCall.get(message.callId);
      if (pending === undefined) return;
      pending.abortCleanup?.();
      this.removePending(pending);
      if (pending.cancelled) pending.resolve(null);
      else pending.reject(new ApiFailureError(message.failure));
      return;
    }
    if (message.type === "dismissedArchivedMutation") {
      const pending = this.pendingByCall.get(message.callId);
      if (pending === undefined) return;
      pending.abortCleanup?.();
      this.removePending(pending);
      pending.resolve(undefined);
      return;
    }
    if (message.type === "dismissalError") {
      const pending = this.pendingByCall.get(message.callId);
      if (pending === undefined) return;
      pending.abortCleanup?.();
      this.removePending(pending);
      pending.reject(new ApiFailureError(message.failure));
      return;
    }
    if (message.type === "reasoningStopped") {
      const pending = this.operationPending(message.id);
      if (pending !== undefined) pending.stoppedReasoningText += message.text;
      return;
    }
    if (message.type === "operation") {
      const pending = this.operationPending(message.id);
      if (pending !== undefined && message.state !== "running") pending.cancelled = true;
      return;
    }
    const pending = this.operationPending(message.id);
    if (pending === undefined) return;
    if (message.type === "delta") {
      if (message.sequence !== pending.expectedSequence) {
        this.close();
        return;
      }
      pending.expectedSequence += 1;
      try {
        if (pending.cancelled) {
          if (message.reasoning === undefined) pending.stoppedText += message.text;
          else pending.stoppedReasoningText += message.text;
        } else if (message.reasoning === undefined) {
          pending.onDelta?.(message.text);
        } else {
          pending.onReasoning?.({ text: message.text, tokenCount: message.reasoning.tokenCount });
        }
        this.send({ type: "ack", id: message.id, sequence: message.sequence });
      } catch (error) {
        pending.cancelled = true;
        this.sendCancelSafely(message.id);
        this.failOne(pending, asError(error));
      }
      return;
    }
    if (message.type === "result") {
      this.finish(pending, message, undefined);
      return;
    }
    if (message.type === "complete") {
      this.finish(pending, message, message.stoppedText);
      return;
    }
    if (message.type === "error") {
      this.finish(pending, message, message.unsentText);
    }
  }

  private finish(
    pending: PendingCall,
    message: Extract<DesktopMainMessage, { type: "result" | "complete" | "error" }>,
    stoppedText: string | undefined
  ): void {
    try {
      const proseTail = pending.stoppedText + (stoppedText ?? "");
      if (proseTail.length > 0) pending.onStopped?.(proseTail);
      if (pending.stoppedReasoningText.length > 0) {
        pending.onReasoningStopped?.(pending.stoppedReasoningText);
      }
      this.send({ type: "terminalAck", id: message.id });
    } catch (error) {
      pending.abortCleanup?.();
      this.removePending(pending);
      pending.reject(asError(error));
      return;
    }
    pending.abortCleanup?.();
    this.removePending(pending);
    if (message.type === "error") {
      pending.reject(new DesktopTransportError(
        message.failure,
        message.mutationOutcome ?? null,
        message.providerMutationId
      ));
    } else {
      pending.resolve(message.value);
    }
  }

  private operationPending(id: WorkerOperationId): PendingCall | undefined {
    return this.pendingByOperation.get(workerOperationKey(id));
  }

  private sendCancel(id: WorkerOperationId): void {
    this.send({ type: "cancel", id, reason: "user" });
  }

  private sendCancelSafely(id: WorkerOperationId): void {
    try {
      this.sendCancel(id);
    } catch {
      // The pending call receives the callback error below.
    }
  }

  private send(message: DesktopRendererMessage): void {
    if (this.closed) throw new Error("Desktop transport is closed.");
    this.port.postMessage(message);
  }

  private failOne(pending: PendingCall, error: Error): void {
    pending.abortCleanup?.();
    this.removePending(pending);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    const pending = new Set([
      ...this.pendingByCall.values(),
      ...this.pendingByOperation.values()
    ]);
    this.pendingByCall.clear();
    this.pendingByOperation.clear();
    pending.forEach((call) => {
      call.abortCleanup?.();
      call.reject(error);
    });
  }

  private removePending(pending: PendingCall): void {
    this.pendingByCall.delete(pending.callId);
    if (pending.operationId !== undefined) {
      this.pendingByOperation.delete(workerOperationKey(pending.operationId));
    }
  }
}

export class DesktopTransportError extends ApiFailureError {
  readonly mutationOutcome: "terminal" | "uncertain" | null;
  readonly providerMutationId: string | undefined;

  constructor(
    failure: ConstructorParameters<typeof ApiFailureError>[0],
    mutationOutcome: "terminal" | "uncertain" | null,
    providerMutationId: string | undefined
  ) {
    super(failure);
    this.name = "DesktopTransportError";
    this.mutationOutcome = mutationOutcome;
    this.providerMutationId = providerMutationId;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
