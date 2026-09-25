import {
  createFailureEnvelope,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import {
  WEB_BRIDGE_MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  decodeBridgeClientMessage,
  decodeBridgeMessageText,
  encodeBridgeMessage,
  workerOperationKey,
  type BridgeCallId,
  type BridgeClientMessage,
  type BridgeHostMessage,
  type BridgeRecoveryWarning
} from "../shared/web-bridge-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type { ReasoningDelta } from "../shared/reasoning-delta.js";
import {
  STREAM_METHODS,
  WORKER_BUILD_IDENTITY,
  WORKER_PROTOCOL_VERSION,
  type WorkerMethod,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import type { WorkerHost } from "./worker-host.js";
import type { WorkerRecoveryWarning } from "./worker-api-contract.js";

/**
 * The transport-agnostic surface `WebBridge` needs from one upgraded
 * connection. `host/web-bridge-server.ts` is the only file that constructs
 * one, over the `ws` package's `WebSocket`; this file never imports "ws"
 * itself, so it stays reachable from root (Node) code and testable without
 * a real socket.
 */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: string) => void): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
}

interface ActiveRequest {
  readonly callId: BridgeCallId;
  id?: WorkerOperationId;
  readonly controller: AbortController;
  readonly unacknowledged: Set<number>;
  nextSequence: number;
  terminal: boolean;
  stoppedText: string;
  terminalTimer: ReturnType<typeof setTimeout> | null;
}

/** The one caller, `host/web-bridge-server.ts`'s `upgrade` handler, has every
 * field in hand at once — an options object keeps that call site readable
 * without positional-argument order to track. */
export interface WebBridgeOptions {
  readonly host: WorkerHost;
  readonly socket: BridgeSocket;
  readonly onClosed: () => void;
  /** Fired after this connection dismisses an archived mutation, so the
   * hub (`host/web-bridge-server.ts`) can broadcast the changed snapshot
   * to every other open connection — the dismisser's own view comes from
   * this instance's own `post` below, same as before. `WebBridge` owns no
   * registry of siblings, so it cannot broadcast this itself. */
  readonly onRecoveryWarningsChanged: () => void;
}

/**
 * Bridge one browser connection to the shared, already-started
 * `WorkerTransport` that `1667 web` holds. The Host allocates the
 * worker-shaped operation id; `WorkerTransport` still owns deadlines,
 * mutation recovery, outbox state, and its own worker credit. This bridge
 * adds only the per-connection credit bound and forwards the frozen worker
 * message shapes over the WebSocket — the same split the removed desktop
 * port bridge (`host/desktop-port-bridge.ts` at 67856fe7) kept over an
 * Electron `MessagePort`. Unlike that bridge, this one owns no per-project
 * registry: `1667 web` opens exactly one project, so `host/web-bridge-server.ts`
 * hands every connection the same `WorkerHost`.
 */
export class WebBridge {
  private readonly host: WorkerHost;
  private readonly socket: BridgeSocket;
  private readonly onClosed: () => void;
  private readonly onRecoveryWarningsChanged: () => void;
  private readonly activeByCall = new Map<BridgeCallId, ActiveRequest>();
  private readonly activeByOperation = new Map<string, ActiveRequest>();
  private closed = false;

  constructor(options: WebBridgeOptions) {
    this.host = options.host;
    this.socket = options.socket;
    this.onClosed = options.onClosed;
    this.onRecoveryWarningsChanged = options.onRecoveryWarningsChanged;
    this.socket.on("message", (data) => this.onMessage(data));
    this.socket.on("close", () => this.close());
  }

  /** Send the handshake. Split from the constructor so the caller can add
   * this instance to its active set first: a `hello` whose send fails closes
   * the bridge synchronously (through `onClosed`), and a bridge that closes
   * itself before the caller could ever remove it from that set would occupy
   * a connection slot forever. Call this right after adding, never before. */
  start(): void {
    this.post({
      type: "hello",
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
      build: WORKER_BUILD_IDENTITY,
      recoveryWarnings: this.host.recoveryWarnings.map(toBridgeRecoveryWarning)
    });
  }

  /** Publish the live snapshot (`host.recoveryWarnings`), never the argument
   * that triggered this call — every caller (a dismissal here, or the Worker
   * host on any new or resolved warning) wants the same full, current list,
   * never a delta. */
  publishRecoveryWarnings(): void {
    if (this.closed) return;
    this.post({
      type: "recoveryWarnings",
      warnings: this.host.recoveryWarnings.map(toBridgeRecoveryWarning)
    });
  }

  /** Fail this connection when the shared Host can no longer serve calls. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.post({ type: "protocolError", failure: failureFromError(error) });
    this.close(1011, "1667 web: the embedded backend failed");
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    // A closed tab cancels this connection's unfinished work. The shared
    // Host retains its durable outbox; closing a bridge does not replay its
    // browser draft as a new story mutation.
    this.closed = true;
    this.activeByCall.forEach((request) => {
      request.controller.abort();
      if (request.terminalTimer !== null) clearTimeout(request.terminalTimer);
    });
    this.activeByCall.clear();
    this.activeByOperation.clear();
    try {
      this.socket.close(code, reason);
    } finally {
      this.onClosed();
    }
  }

  private onMessage(data: string): void {
    if (this.closed) return;
    const message = decodeBridgeClientMessage(decodeBridgeMessageText(data));
    if (message === null) {
      this.protocolError("1667 web: the browser sent a malformed message.");
      return;
    }
    void this.receive(message);
  }

  private async receive(message: BridgeClientMessage): Promise<void> {
    if (this.closed) return;
    switch (message.type) {
      case "request":
        await this.startRequest(message);
        return;
      case "ack":
        this.acknowledge(message.id, message.sequence);
        return;
      case "cancel":
        this.activeByOperation.get(workerOperationKey(message.id))?.controller.abort();
        return;
      case "terminalAck":
        this.finishTerminalAck(message.id);
        return;
      case "dismissArchivedMutation":
        await this.dismissArchivedMutation(message.callId, message.mutationId);
        return;
    }
  }

  private async startRequest(
    message: Extract<BridgeClientMessage, { type: "request" }>
  ): Promise<void> {
    if (this.activeByCall.has(message.callId)) {
      this.protocolError("1667 web: the browser reused a call id.");
      return;
    }
    const request: ActiveRequest = {
      callId: message.callId,
      controller: new AbortController(),
      unacknowledged: new Set(),
      nextSequence: 0,
      terminal: false,
      stoppedText: "",
      terminalTimer: null
    };
    this.activeByCall.set(message.callId, request);
    try {
      const call = this.host.transport.call.bind(this.host.transport) as unknown as (
        method: WorkerMethod,
        input: unknown,
        options: {
          onDelta?: (text: string) => void;
          onStopped?: (text: string) => void;
          onReasoning?: (delta: ReasoningDelta) => void;
          onReasoningStopped?: (text: string) => void;
          signal?: AbortSignal;
          expectedAggregateVersion?: StoryAggregateVersion;
          /** WorkerTransport allocates the durable id before posting. */
          onAccepted?: (id: WorkerOperationId) => void;
        }
      ) => Promise<unknown>;
      const value = await call(message.method, message.input, {
        signal: request.controller.signal,
        onAccepted: (id) => {
          if (request.id !== undefined) {
            this.protocolError("Host allocated an operation id twice.");
            return;
          }
          request.id = id;
          this.activeByOperation.set(workerOperationKey(id), request);
          this.post({ type: "accepted", callId: request.callId, id });
        },
        ...(message.expectedAggregateVersion === undefined
          ? {}
          : { expectedAggregateVersion: message.expectedAggregateVersion }),
        onDelta: (text) => this.sendDelta(request, text),
        onStopped: (text) => { request.stoppedText += text; },
        onReasoning: (delta) => this.sendReasoningDelta(request, delta),
        onReasoningStopped: (text) => this.sendReasoningStopped(request, text)
      });
      this.sendTerminal(request, STREAM_METHODS.has(message.method)
        ? {
            type: "complete",
            id: requireOperationId(request),
            value,
            ...(request.stoppedText.length === 0 ? {} : { stoppedText: request.stoppedText })
          }
        : { type: "result", id: requireOperationId(request), value });
    } catch (error) {
      if (request.id === undefined) {
        this.activeByCall.delete(request.callId);
        this.post({
          type: "rejected",
          callId: request.callId,
          failure: failureFromError(error)
        });
        return;
      }
      this.sendTerminal(request, {
        type: "error",
        id: request.id,
        failure: failureFromError(error),
        ...mutationFailureFields(error),
        ...(request.stoppedText.length === 0 ? {} : { unsentText: request.stoppedText })
      });
    }
  }

  private sendDelta(request: ActiveRequest, text: string): void {
    const id = request.id;
    if (id === undefined) return;
    if (request.unacknowledged.size >= WEB_BRIDGE_MAX_UNACKNOWLEDGED_DELTA_BATCHES) {
      request.controller.abort();
      request.stoppedText += text;
      return;
    }
    const sequence = request.nextSequence++;
    request.unacknowledged.add(sequence);
    this.post({ type: "delta", id, sequence, text });
  }

  private sendReasoningDelta(request: ActiveRequest, delta: ReasoningDelta): void {
    const id = request.id;
    if (id === undefined) return;
    if (request.unacknowledged.size >= WEB_BRIDGE_MAX_UNACKNOWLEDGED_DELTA_BATCHES) {
      request.controller.abort();
      this.sendReasoningStopped(request, delta.text);
      return;
    }
    const sequence = request.nextSequence++;
    request.unacknowledged.add(sequence);
    this.post({
      type: "delta",
      id,
      sequence,
      text: delta.text,
      reasoning: { tokenCount: delta.tokenCount }
    });
  }

  private sendReasoningStopped(request: ActiveRequest, text: string): void {
    if (request.id !== undefined) {
      this.post({ type: "reasoningStopped", id: request.id, text });
    }
  }

  private acknowledge(id: WorkerOperationId, sequence: number): void {
    const request = this.activeByOperation.get(workerOperationKey(id));
    if (request === undefined || request.terminal) return;
    if (!request.unacknowledged.delete(sequence)) {
      this.protocolError("1667 web: the browser acknowledged an unknown delta.");
    }
  }

  private sendTerminal(
    request: ActiveRequest,
    message: Extract<BridgeHostMessage, { type: "result" | "complete" | "error" }>
  ): void {
    if (this.closed || request.terminal || request.id === undefined) return;
    request.terminal = true;
    this.post(message);
    request.terminalTimer = setTimeout(() => {
      this.activeByCall.delete(request.callId);
      this.activeByOperation.delete(workerOperationKey(request.id!));
    }, 10_000);
  }

  private finishTerminalAck(id: WorkerOperationId): void {
    const key = workerOperationKey(id);
    const request = this.activeByOperation.get(key);
    if (request === undefined || !request.terminal) return;
    if (request.terminalTimer !== null) clearTimeout(request.terminalTimer);
    this.activeByCall.delete(request.callId);
    this.activeByOperation.delete(key);
  }

  private async dismissArchivedMutation(
    callId: BridgeCallId,
    mutationId: string
  ): Promise<void> {
    try {
      await this.host.transport.dismissArchivedMutation(mutationId);
      this.post({ type: "dismissedArchivedMutation", callId, mutationId });
      this.onRecoveryWarningsChanged();
    } catch (error) {
      this.post({
        type: "dismissalError",
        callId,
        mutationId,
        failure: failureFromError(error)
      });
    }
  }

  private protocolError(message: string): void {
    this.post({
      type: "protocolError",
      failure: createFailureEnvelope({ code: "invalid_request", message, status: 400 })
    });
    this.close(1002, message);
  }

  private post(message: BridgeHostMessage): void {
    try {
      this.socket.send(encodeBridgeMessage(message));
    } catch {
      this.close();
    }
  }
}

function toBridgeRecoveryWarning(
  warning: WorkerRecoveryWarning
): BridgeRecoveryWarning {
  return {
    mutationId: warning.mutationId,
    method: warning.method,
    storyId: warning.storyId,
    ...(warning.providerRecovery === undefined ? {} : { providerRecovery: warning.providerRecovery }),
    resolution: warning.resolution,
    error: failureFromError(warning.error)
  };
}

function failureFromError(error: unknown): FailureEnvelope {
  if (isRecord(error) && "failure" in error) {
    const failure = error.failure;
    if (isRecord(failure)
      && "code" in failure
      && "message" in failure
      && "status" in failure) {
      return createFailureEnvelope(
        {
          code: failure.code,
          message: failure.message,
          status: failure.status,
          ...(failure.timeout === undefined ? {} : { timeout: failure.timeout })
        },
        "diagnosticRef" in failure ? failure.diagnosticRef : undefined
      );
    }
  }
  return createFailureEnvelope({
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    status: 500
  });
}

function requireOperationId(request: ActiveRequest): WorkerOperationId {
  if (request.id === undefined) {
    throw new Error("WorkerTransport completed a call without an operation id");
  }
  return request.id;
}

function mutationFailureFields(error: unknown): {
  mutationOutcome?: "terminal" | "uncertain";
  providerMutationId?: string;
} {
  if (!isRecord(error)) return {};
  const outcome = error.mutationOutcome;
  const providerMutationId = error.providerMutationId;
  return {
    ...(outcome === "terminal" || outcome === "uncertain"
      ? { mutationOutcome: outcome }
      : {}),
    ...(typeof providerMutationId === "string" ? { providerMutationId } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
