import {
  createFailureEnvelope,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import {
  DESKTOP_MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  decodeDesktopRendererMessage,
  workerOperationKey,
  type DesktopMainMessage,
  type DesktopRecoveryWarning,
  type DesktopRendererMessage,
  type DesktopCallId
} from "../shared/desktop-shell.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type { ReasoningDelta } from "../shared/reasoning-delta.js";
import {
  STREAM_METHODS,
  type WorkerMethod,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import { createWorkerHost } from "./worker-host.js";
import type { WorkerHost, WorkerHostOptions } from "./worker-host.js";
import type { WorkerRecoveryWarning } from "./worker-api-contract.js";

export interface DesktopMainPort {
  postMessage(message: DesktopMainMessage): void;
  on(event: "message" | "messageerror" | "close", listener: (event: unknown) => void): void;
  removeListener(event: "message" | "messageerror" | "close", listener: (event: unknown) => void): void;
  start(): void;
  close(): void;
}

interface ActiveRequest {
  readonly callId: DesktopCallId;
  id?: WorkerOperationId;
  readonly controller: AbortController;
  readonly unacknowledged: Set<number>;
  nextSequence: number;
  terminal: boolean;
  stoppedText: string;
  terminalTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Bridge one Renderer port to one already-started WorkerTransport.
 *
 * The Host allocates the worker-shaped operation id. WorkerTransport still
 * owns deadlines, mutation recovery, outbox state, and its own worker credit.
 * This bridge adds only the per-window credit bound and forwards the frozen
 * worker message shapes over the Electron port.
 */
export class DesktopPortBridge {
  private readonly activeByCall = new Map<DesktopCallId, ActiveRequest>();
  private readonly activeByOperation = new Map<string, ActiveRequest>();
  private closed = false;

  private readonly onMessage = (event: unknown): void => {
    const data = isRecord(event) && "data" in event
      ? event.data
      : event;
    const message = decodeDesktopRendererMessage(data);
    if (message === null) {
      this.protocolError("Desktop Renderer sent a malformed message.");
      return;
    }
    void this.receive(message);
  };
  private readonly onMessageError = (): void => {
    this.close();
  };
  private readonly onClose = (): void => {
    this.close();
  };

  constructor(
    private readonly host: WorkerHost,
    private readonly port: DesktopMainPort,
    private readonly onClosed: () => void = () => undefined
  ) {
    port.on("message", this.onMessage);
    port.on("messageerror", this.onMessageError);
    port.on("close", this.onClose);
    port.start();
    this.publishRecoveryWarnings(host.recoveryWarnings);
  }

  publishRecoveryWarnings(warnings: readonly WorkerRecoveryWarning[]): void {
    if (this.closed) return;
    const serializable = warnings.map(toDesktopRecoveryWarning);
    this.post({ type: "recoveryWarnings", warnings: serializable });
  }

  /** Fail this Renderer when its shared Host can no longer serve calls. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.post({ type: "protocolError", failure: failureFromError(error) });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    // A reload cancels this port's unfinished work. The shared Host retains
    // its durable outbox; closing a port does not replay its renderer draft
    // as a new story mutation.
    this.closed = true;
    this.activeByCall.forEach((request) => {
      request.controller.abort();
      if (request.terminalTimer !== null) clearTimeout(request.terminalTimer);
    });
    this.activeByCall.clear();
    this.activeByOperation.clear();
    this.port.removeListener("message", this.onMessage);
    this.port.removeListener("messageerror", this.onMessageError);
    this.port.removeListener("close", this.onClose);
    try {
      this.port.close();
    } finally {
      this.onClosed();
    }
  }

  private async receive(message: DesktopRendererMessage): Promise<void> {
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
    message: Extract<DesktopRendererMessage, { type: "request" }>
  ): Promise<void> {
    if (this.activeByCall.has(message.callId)) {
      this.protocolError("Desktop Renderer reused a call id.");
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
    if (request.unacknowledged.size >= DESKTOP_MAX_UNACKNOWLEDGED_DELTA_BATCHES) {
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
    if (request.unacknowledged.size >= DESKTOP_MAX_UNACKNOWLEDGED_DELTA_BATCHES) {
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
      this.protocolError("Desktop Renderer acknowledged an unknown delta.");
    }
  }

  private sendTerminal(
    request: ActiveRequest,
    message: Extract<DesktopMainMessage, { type: "result" | "complete" | "error" }>
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
    callId: DesktopCallId,
    mutationId: string
  ): Promise<void> {
    try {
      await this.host.transport.dismissArchivedMutation(mutationId);
      this.post({ type: "dismissedArchivedMutation", callId, mutationId });
      this.publishRecoveryWarnings(this.host.recoveryWarnings);
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
    this.close();
  }

  private post(message: DesktopMainMessage): void {
    try {
      this.port.postMessage(message);
    } catch {
      this.close();
    }
  }
}

export interface DesktopProjectHost {
  readonly id: string;
  readonly host: WorkerHost;
  readonly bridges: ReadonlySet<DesktopPortBridge>;
}

/** Own one WorkerHost per open project and share it across Renderer windows. */
export class DesktopHostRegistry {
  private readonly opening = new Map<string, Promise<DesktopProjectHost>>();
  private readonly closing = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly projects = new Map<string, {
    readonly id: string;
    readonly host: WorkerHost;
    readonly bridges: Set<DesktopPortBridge>;
  }>();

  async openProject(
    id: string,
    options: WorkerHostOptions = {}
  ): Promise<DesktopProjectHost> {
    if (this.disposed) throw new Error("Desktop host registry is closed.");
    const closing = this.closing.get(id);
    if (closing !== undefined) {
      await closing;
      if (this.disposed) throw new Error("Desktop host registry is closed.");
    }
    const existing = this.projects.get(id);
    if (existing !== undefined) return existing;
    const pending = this.opening.get(id);
    if (pending !== undefined) return pending;
    const opening = this.startProject(id, options);
    this.opening.set(id, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(id) === opening) this.opening.delete(id);
    }
  }

  private async startProject(
    id: string,
    options: WorkerHostOptions
  ): Promise<DesktopProjectHost> {
    const originalRecovery = options.onRecoveryWarnings;
    const host = await createWorkerHost({
      ...options,
      projectOwner: "desktop",
      onRecoveryWarnings: (warnings) => {
        const result = originalRecovery?.(warnings);
        const project = this.projects.get(id);
        project?.bridges.forEach((bridge) => bridge.publishRecoveryWarnings(warnings));
        return result;
      }
    });
    const project = { id, host, bridges: new Set<DesktopPortBridge>() };
    this.projects.set(id, project);
    void host.failure.then((error) => {
      const current = this.projects.get(id);
      if (current !== project) return;
      current.bridges.forEach((bridge) => bridge.fail(error));
    });
    return project;
  }

  attachPort(id: string, port: DesktopMainPort): DesktopPortBridge {
    const project = this.projects.get(id);
    if (project === undefined) {
      throw new Error(`Desktop project is not open: ${id}`);
    }
    let bridge: DesktopPortBridge;
    bridge = new DesktopPortBridge(project.host, port, () => {
      project.bridges.delete(bridge);
    });
    project.bridges.add(bridge);
    return bridge;
  }

  async closeProject(id: string): Promise<void> {
    const pending = this.closing.get(id);
    if (pending !== undefined) return pending;
    const closing = Promise.resolve().then(async () => {
      await this.opening.get(id)?.catch(() => undefined);
      await this.disposeProject(id);
    });
    this.closing.set(id, closing);
    try {
      await closing;
    } finally {
      if (this.closing.get(id) === closing) this.closing.delete(id);
    }
  }

  private async disposeProject(id: string): Promise<void> {
    const project = this.projects.get(id);
    if (project === undefined) return;
    this.projects.delete(id);
    project.bridges.forEach((bridge) => bridge.close());
    await project.host.dispose();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...new Set([
      ...this.projects.keys(), ...this.opening.keys(), ...this.closing.keys()
    ])];
    await Promise.all(ids.map((id) => this.closeProject(id)));
  }
}

function toDesktopRecoveryWarning(
  warning: WorkerRecoveryWarning
): DesktopRecoveryWarning {
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
