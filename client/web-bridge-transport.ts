import { ApiFailureError } from "./api-error.js";
import type { StoryWorkerTransport } from "./worker-story-api.js";
import type { ReasoningDelta } from "./reasoning.js";
import type {
  WorkerInput,
  WorkerMethod,
  WorkerOperationId,
  WorkerOutput
} from "../shared/worker-protocol.js";
import { WORKER_PROTOCOL_VERSION } from "../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import {
  WEB_BRIDGE_PATH,
  WEB_BRIDGE_SUBPROTOCOL,
  WEB_BRIDGE_TOKEN_PREFIX,
  decodeBridgeHostMessage,
  decodeBridgeMessageText,
  encodeBridgeMessage,
  workerOperationKey,
  type BridgeCallId,
  type BridgeClientMessage,
  type BridgeHostMessage,
  type BridgeRecoveryWarning
} from "../shared/web-bridge-protocol.js";

/** Structural subset of DOM `WebSocket` this transport needs. The renderer
 * hands over a real `WebSocket`; `test/client-browser.integration.test.ts`
 * hands over a fake, so nothing here may depend on a DOM `WebSocket` member
 * this interface does not list. */
export interface WebBridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: EventListener): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: EventListener): void;
}

/** The two subprotocol offers `new WebSocket(url, webBridgeProtocols(token))`
 * makes. The server echoes only the first one back. */
export function webBridgeProtocols(token: string): string[] {
  return [WEB_BRIDGE_SUBPROTOCOL, `${WEB_BRIDGE_TOKEN_PREFIX}${token}`];
}

/** The bridge endpoint on the page's own origin. Loopback-only, so it is
 * always plain `ws://`, never `wss://`. */
export function webBridgeUrl(location: { readonly host: string }): string {
  return `ws://${location.host}${WEB_BRIDGE_PATH}`;
}

export interface WebBridgeTransportOptions {
  readonly onRecoveryWarnings?: (
    warnings: readonly BridgeRecoveryWarning[]
  ) => void;
  /** Fires once, the only time this transport closes — from the server, from
   * a network failure, or from a caller's own `close()`. */
  readonly onClose?: (error: Error) => void;
}

interface PendingCall {
  readonly callId: BridgeCallId;
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

/** What `openWebBridgeTransport` resolves with: the live transport, plus the
 * `hello` frame's own recovery-warning snapshot — the one frame
 * `options.onRecoveryWarnings` never sees, since it exists before the
 * returned promise does. `options.onRecoveryWarnings` fires only for a later
 * `recoveryWarnings` frame. */
export interface OpenWebBridgeResult {
  readonly transport: WebBridgeTransport;
  readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
}

/**
 * Open the bridge: wait for the server's `hello`, then hand back a live
 * transport and that frame's own recovery-warning snapshot. `socket` must
 * already be connecting (or connected) — this function only attaches
 * listeners, it never constructs the socket, so a caller stays free to
 * choose the exact `WebSocket` constructor arguments (see
 * `webBridgeProtocols`/`webBridgeUrl`).
 *
 * A `hello` whose `workerProtocolVersion` this bundle does not share with
 * the running server closes the socket and rejects: a browser tab left open
 * across an `1667` upgrade must never send a request the server cannot
 * answer.
 */
export async function openWebBridgeTransport(
  socket: WebBridgeSocket,
  options: WebBridgeTransportOptions = {}
): Promise<OpenWebBridgeResult> {
  return await new Promise<OpenWebBridgeResult>((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const fail = (error: Error): void => {
      cleanup();
      try {
        socket.close();
      } catch {
        // The socket may already be closing.
      }
      reject(error);
    };
    const onMessage = ((event: MessageEvent<unknown>) => {
      const message = decodeIncoming(event.data);
      if (message === null) {
        fail(new Error("1667 web: the server sent a malformed handshake."));
        return;
      }
      if (message.type !== "hello") {
        fail(new Error("1667 web: the server did not open with a handshake."));
        return;
      }
      if (message.workerProtocolVersion !== WORKER_PROTOCOL_VERSION) {
        fail(new Error(
          "1667 web: this page does not match the running server. Reload the page."
        ));
        return;
      }
      cleanup();
      const transport = new WebBridgeTransport(socket, options);
      resolve({ transport, recoveryWarnings: message.recoveryWarnings });
    }) as EventListener;
    const onClose = ((event: CloseEvent) => {
      fail(new Error(`1667 web connection closed before it opened (code ${event.code})`));
    }) as EventListener;
    const onError = (() => {
      fail(new Error("1667 web connection failed."));
    }) as EventListener;
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

/** Browser-side `StoryWorkerTransport` over the WebSocket bridge
 * (`host/web-bridge.ts`, `host/web-bridge-server.ts`). Constructed only by
 * `openWebBridgeTransport`, once its `hello` has cleared. */
export class WebBridgeTransport implements StoryWorkerTransport {
  private nextCallId = 1;
  private readonly pendingByCall = new Map<BridgeCallId, PendingCall>();
  private readonly pendingByOperation = new Map<string, PendingCall>();
  private closed = false;

  private readonly onMessage = ((event: MessageEvent<unknown>) => {
    this.receive(event.data);
  }) as EventListener;
  private readonly onSocketClose = ((event: CloseEvent) => {
    this.close(new Error(`1667 web connection closed (code ${event.code})`));
  }) as EventListener;

  constructor(
    private readonly socket: WebBridgeSocket,
    private readonly options: WebBridgeTransportOptions = {}
  ) {
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onSocketClose);
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
    if (this.closed) return Promise.reject(new Error("1667 web transport is closed."));
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
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onSocketClose);
    try {
      this.socket.close();
    } catch {
      // Already closing.
    }
    const error = reason ?? new Error("1667 web transport closed.");
    this.failAll(error);
    this.options.onClose?.(error);
  }

  private receive(raw: unknown): void {
    const message = decodeIncoming(raw);
    if (message === null || message.type === "hello") {
      // A duplicate handshake is a protocol violation: `openWebBridgeTransport`
      // already consumed the one and only `hello`.
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
    message: Extract<BridgeHostMessage, { type: "result" | "complete" | "error" }>,
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
      pending.reject(new WebBridgeTransportError(
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

  private send(message: BridgeClientMessage): void {
    if (this.closed) throw new Error("1667 web transport is closed.");
    this.socket.send(encodeBridgeMessage(message));
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

export class WebBridgeTransportError extends ApiFailureError {
  readonly mutationOutcome: "terminal" | "uncertain" | null;
  readonly providerMutationId: string | undefined;

  constructor(
    failure: ConstructorParameters<typeof ApiFailureError>[0],
    mutationOutcome: "terminal" | "uncertain" | null,
    providerMutationId: string | undefined
  ) {
    super(failure);
    this.name = "WebBridgeTransportError";
    this.mutationOutcome = mutationOutcome;
    this.providerMutationId = providerMutationId;
  }
}

/** Every frame on this bridge is JSON text; anything else (a non-string
 * payload, or text that fails to parse or decode) is a protocol violation
 * the caller closes on. */
function decodeIncoming(raw: unknown): BridgeHostMessage | null {
  if (typeof raw !== "string") return null;
  return decodeBridgeHostMessage(decodeBridgeMessageText(raw));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
