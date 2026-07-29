import { performance } from "node:perf_hooks";
import type { HttpCapabilityScope } from "../shared/http-auth.js";
import {
  HTTP_OPERATION_CAPACITY,
  HTTP_OPERATION_CANCEL_GRACE_MS,
  HTTP_OPERATION_MAX_SEQUENCE,
  HTTP_OPERATION_PER_SESSION_CAPACITY,
  HTTP_OPERATION_RESERVATION_LIMIT,
  HTTP_OPERATION_RESERVATION_WINDOW_MS,
  HTTP_OPERATION_SCOPE_SESSION_CAPACITY,
  HTTP_OPERATION_SESSION_CAPACITY,
  HTTP_OPERATION_SESSION_CREATION_LIMIT,
  HTTP_OPERATION_SESSION_CREATION_WINDOW_MS,
  HTTP_OPERATION_SESSION_IDLE_MS,
  HTTP_OPERATION_TERMINAL_RETENTION_MS,
  isTerminalHttpOperationState,
  type HttpOperationReservationRequest,
  type HttpOperationReservationResponse,
  type HttpOperationSessionResponse,
  type HttpOperationStatusResponse
} from "../shared/http-operation-protocol.js";
import {
  GenerationCancelledError,
  ServiceError
} from "./errors.js";
import type { HttpSupervisedOperationDescriptor } from "../shared/supervised-serve-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { HttpOperationAuthority } from "./http-operation-authority.js";
import {
  createHttpOperationRecord,
  resolveHttpOperationReservation
} from "./http-operation-reservation.js";
import {
  canonicalHttpOperationMethod,
  canonicalHttpOperationPath,
  httpOperationKey,
  httpOperationStatusResponse,
  operationAdmissionBusy,
  operationSessionTerminal,
  operationSessionUnauthorized,
  type HttpOperationRecord,
  type HttpOperationSessionRecord
} from "./http-operation-session-state.js";

export type HttpOperationLifecycleAuthority =
  | { readonly kind: "local" }
  | {
      readonly kind: "supervised";
      admit(operation: HttpSupervisedOperationDescriptor): Promise<void>;
      terminal(operation: HttpSupervisedOperationDescriptor): void;
      hardDeadline(operation: {
        readonly sessionId: string;
        readonly sequence: bigint;
        readonly mutationId: string | null;
      }): void;
    };

export interface HttpOperationSessionStoreOptions {
  readonly now?: () => number;
  readonly epochNow?: () => number;
  readonly secret?: Uint8Array;
  readonly capacity?: number;
  readonly terminalRetentionMs?: number;
  readonly lifecycle?: HttpOperationLifecycleAuthority;
}

export interface RunningHttpOperation {
  readonly scope: HttpCapabilityScope;
  readonly signal: AbortSignal;
  readonly mutationId: string | null;
  readonly expectedAggregateVersion: StoryAggregateVersion | null;
  finish(state: "completed" | "canceled" | "failed"): void;
}

/**
 * Listener-incarnation operation authority. Capabilities and tickets are
 * self-authenticating; mutable lifecycle state stays bounded and in memory.
 */
export class HttpOperationSessionStore {
  private readonly sessions = new Map<string, HttpOperationSessionRecord>();
  private readonly operations = new Map<string, HttpOperationRecord>();
  private globalReservationTail = Promise.resolve();
  private readonly creationHistory = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly epochNow: () => number;
  private readonly authority: HttpOperationAuthority;
  private readonly capacity: number;
  private readonly terminalRetentionMs: number;
  private readonly lifecycle: HttpOperationLifecycleAuthority;

  constructor(
    readonly listenerInstanceId: string,
    options: HttpOperationSessionStoreOptions = {}
  ) {
    this.now = options.now ?? (() => performance.now());
    this.epochNow = options.epochNow ?? (() => Date.now());
    this.authority = new HttpOperationAuthority(
      listenerInstanceId,
      options.secret
    );
    this.capacity = options.capacity ?? HTTP_OPERATION_CAPACITY;
    this.terminalRetentionMs = options.terminalRetentionMs
      ?? HTTP_OPERATION_TERMINAL_RETENTION_MS;
    this.lifecycle = options.lifecycle ?? { kind: "local" };
  }

  createSession(
    scope: HttpCapabilityScope,
    originatingCapability: string
  ): HttpOperationSessionResponse {
    const now = this.now();
    this.sweep(now);
    const originKey = this.authority.originKey(originatingCapability);
    const scopeSessions = [...this.sessions.values()]
      .filter((session) => session.originKey === originKey).length;
    if (this.sessions.size >= HTTP_OPERATION_SESSION_CAPACITY
      || scopeSessions >= HTTP_OPERATION_SCOPE_SESSION_CAPACITY) {
      throw operationAdmissionBusy("HTTP operation-session capacity is full");
    }
    const history = (this.creationHistory.get(originKey) ?? [])
      .filter((createdAt) =>
        createdAt > now - HTTP_OPERATION_SESSION_CREATION_WINDOW_MS);
    if (history.length >= HTTP_OPERATION_SESSION_CREATION_LIMIT) {
      this.creationHistory.set(originKey, history);
      throw new ServiceError(
        429,
        "HTTP operation-session creation rate exceeded",
        "resource_busy"
      );
    }
    const id = this.authority.createSessionId();
    const capability = this.authority.sessionCapability(id, scope);
    const record: HttpOperationSessionRecord = {
      id,
      scope,
      createdAt: now,
      originKey,
      capability,
      lastActivityAt: now,
      lastSequence: 0n,
      closed: false,
      active: 0,
      reservationHistory: [],
      closeWaiters: []
    };
    this.sessions.set(id, record);
    history.push(now);
    this.creationHistory.set(originKey, history);
    return {
      listenerInstanceId: this.listenerInstanceId,
      sessionId: id,
      scope,
      capability,
      idleTimeoutMs: HTTP_OPERATION_SESSION_IDLE_MS
    };
  }

  async reserve(
    capability: string,
    request: HttpOperationReservationRequest
  ): Promise<HttpOperationReservationResponse> {
    const initialSession = this.requireLiveSession(capability, true);
    return await this.withGlobalReservationTurn(async () => {
      const session = this.requireLiveSessionRecord(initialSession, true);
      const resolved = resolveHttpOperationReservation(request, session.scope);
      const now = this.now();
      this.sweep(now);
      session.reservationHistory = session.reservationHistory.filter(
        (reservedAt) =>
          reservedAt > now - HTTP_OPERATION_RESERVATION_WINDOW_MS
      );
      if (session.active >= HTTP_OPERATION_PER_SESSION_CAPACITY
        || session.reservationHistory.length >= HTTP_OPERATION_RESERVATION_LIMIT) {
        throw operationAdmissionBusy("HTTP operation-session admission is full");
      }
      if (this.operations.size >= this.capacity) {
        throw operationAdmissionBusy("HTTP operation capacity is full");
      }
      if (session.lastSequence === HTTP_OPERATION_MAX_SEQUENCE) {
        session.closed = true;
        throw new ServiceError(
          409,
          "HTTP operation sequence is exhausted; create a new session",
          "invalid_request"
        );
      }
      const sequence = session.lastSequence + 1n;
      session.lastActivityAt = now;
      const epochNow = this.epochNow();
      const ticket = this.authority.operationTicket(session, sequence);
      const operation = createHttpOperationRecord(
        resolved,
        session.id,
        sequence,
        session.scope,
        ticket,
        now,
        epochNow
      );
      if (this.lifecycle.kind === "supervised") {
        await this.lifecycle.admit({
          listenerInstanceId: this.listenerInstanceId,
          sessionId: session.id,
          sequence: sequence.toString(),
          scope: session.scope,
          operation: resolved.operation,
          mutationId: resolved.mutationId,
          lifetime: resolved.lifetime,
          deadlineDelayMs: resolved.lifetimeMs
        });
      }
      session.lastSequence = sequence;
      this.operations.set(httpOperationKey(session.id, sequence), operation);
      session.active += 1;
      session.reservationHistory.push(now);
      operation.timer = setTimeout(() => {
        if (operation.state === "reserved") {
          operation.cancelRequested = true;
          this.finishRecord(operation, "canceled", this.now());
        }
      }, Math.max(0, operation.startDeadline - now));
      return {
        listenerInstanceId: this.listenerInstanceId,
        sessionId: session.id,
        sequence: sequence.toString(),
        ticket,
        lifetime: resolved.lifetime,
        deadlineEpochMs: operation.deadlineEpochMs,
        startDeadlineEpochMs: operation.startDeadlineEpochMs
      };
    });
  }

  authenticate(capability: string): HttpCapabilityScope {
    return this.requireLiveSession(capability, true).scope;
  }

  begin(
    capability: string,
    ticket: string,
    methodInput: string,
    pathInput: string
  ): RunningHttpOperation {
    const session = this.requireLiveSession(capability, false);
    const { sessionId, sequence } = this.parseTicket(ticket, session);
    const operation = this.requireOperation(sessionId, sequence);
    if (operation.state !== "reserved") {
      throw new ServiceError(409, "HTTP operation was already started", "invalid_request");
    }
    const method = canonicalHttpOperationMethod(methodInput);
    const path = canonicalHttpOperationPath(pathInput);
    if (operation.method !== method || operation.path !== path) {
      throw new ServiceError(
        409,
        "HTTP operation reservation does not match the request",
        "invalid_request"
      );
    }
    const now = this.now();
    if (now >= operation.startDeadline || now >= operation.deadline) {
      this.finishRecord(operation, "canceled", now);
      throw new ServiceError(
        408,
        "HTTP operation start deadline exceeded",
        "operation_expired"
      );
    }
    if (operation.timer !== null) clearTimeout(operation.timer);
    operation.state = "running";
    operation.timer = setTimeout(() => {
      this.requestCancellation(
        operation,
        new Error("HTTP operation deadline exceeded")
      );
    }, Math.max(0, operation.deadline - now));
    let finished = false;
    return {
      scope: session.scope,
      signal: operation.abort.signal,
      mutationId: operation.mutationId,
      expectedAggregateVersion: operation.expectedAggregateVersion,
      finish: (state) => {
        if (finished) return;
        finished = true;
        this.finishRecord(operation, state, this.now());
      }
    };
  }

  status(capability: string, ticket: string): HttpOperationStatusResponse {
    const session = this.requireLiveSession(capability);
    const { sessionId, sequence } = this.parseTicket(ticket, session);
    this.sweep(this.now());
    const operation = this.operations.get(httpOperationKey(sessionId, sequence));
    if (operation === undefined) {
      if (sequence <= session.lastSequence) {
        throw new ServiceError(410, "HTTP operation is unknown", "operation_unknown");
      }
      throw new ServiceError(409, "HTTP operation sequence was never reserved", "invalid_request");
    }
    return httpOperationStatusResponse(this.listenerInstanceId, operation);
  }

  cancel(capability: string, ticket: string): HttpOperationStatusResponse {
    const session = this.requireLiveSession(capability);
    const { sessionId, sequence } = this.parseTicket(ticket, session);
    const operation = this.requireOperation(sessionId, sequence);
    if (operation.state === "reserved") {
      operation.cancelRequested = true;
      this.finishRecord(operation, "canceled", this.now());
    } else if (operation.state === "running") {
      this.requestCancellation(
        operation,
        operation.lifetime === "generation"
          ? new GenerationCancelledError()
          : new Error("HTTP operation canceled")
      );
    }
    return httpOperationStatusResponse(this.listenerInstanceId, operation);
  }

  acknowledge(capability: string, ticket: string): void {
    const session = this.requireLiveSession(capability);
    const { sessionId, sequence } = this.parseTicket(ticket, session);
    const key = httpOperationKey(sessionId, sequence);
    const operation = this.operations.get(key);
    if (operation === undefined) return;
    if (!isTerminalHttpOperationState(operation.state)) {
      throw new ServiceError(
        409,
        "Cannot acknowledge a nonterminal HTTP operation",
        "invalid_request"
      );
    }
    this.operations.delete(key);
  }

  async closeSession(capability: string): Promise<void> {
    const session = this.requireLiveSession(capability, true);
    if (!session.closed) {
      session.closed = true;
      for (const operation of this.operations.values()) {
        if (operation.sessionId !== session.id
          || isTerminalHttpOperationState(operation.state)) continue;
        operation.cancelRequested = true;
        if (operation.state === "reserved") {
          this.finishRecord(operation, "canceled", this.now());
        } else {
          this.requestCancellation(
            operation,
            new Error("HTTP operation session closed")
          );
        }
      }
    }
    if (session.active > 0) {
      await new Promise<void>((resolve) => session.closeWaiters.push(resolve));
    }
    this.removeClosedSessionWhenIdle(session);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      if (session.closed) {
        if (session.active > 0) {
          await new Promise<void>((resolve) =>
            session.closeWaiters.push(resolve));
        }
        return;
      }
      try {
        await this.closeSession(session.capability);
      } catch (error) {
        if (!(error instanceof ServiceError
          && error.code === "operation_session_terminal")) throw error;
      }
    }));
  }

  get size(): number {
    this.sweep(this.now());
    return this.operations.size;
  }

  private requireLiveSession(
    capability: string,
    touch = true
  ): HttpOperationSessionRecord {
    return this.requireLiveSessionRecord(
      this.requireSessionCapability(capability),
      touch
    );
  }

  private requireLiveSessionRecord(
    session: HttpOperationSessionRecord,
    touch = true
  ): HttpOperationSessionRecord {
    if (this.sessions.get(session.id) !== session) {
      throw operationSessionTerminal();
    }
    if (session.closed) throw operationSessionTerminal();
    const now = this.now();
    if (session.active === 0
      && session.lastActivityAt <= now - HTTP_OPERATION_SESSION_IDLE_MS) {
      session.closed = true;
      this.sessions.delete(session.id);
      throw operationSessionTerminal();
    }
    if (touch) session.lastActivityAt = now;
    return session;
  }

  private requireSessionCapability(
    capability: string
  ): HttpOperationSessionRecord {
    const sessionId = this.authority.sessionId(capability);
    if (sessionId === null) throw operationSessionUnauthorized();
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      if (this.authority.matchesAnySessionScope(capability, sessionId)) {
        throw operationSessionTerminal();
      }
      throw operationSessionUnauthorized();
    }
    if (!this.authority.matchesStoredValue(
      capability,
      session.capability
    )) {
      throw operationSessionUnauthorized();
    }
    return session;
  }

  private parseTicket(
    ticket: string,
    session: HttpOperationSessionRecord
  ): { sessionId: string; sequence: bigint } {
    const sequence = this.authority.parseOperationTicketSequence(
      ticket,
      session.id
    );
    if (sequence === null) {
      throw new ServiceError(400, "Malformed HTTP operation ticket", "invalid_request");
    }
    const operation = this.operations.get(httpOperationKey(session.id, sequence));
    const valid = operation === undefined
      ? this.authority.parseOperationTicket(ticket, session) !== null
      : this.authority.matchesStoredValue(ticket, operation.ticket);
    if (!valid) {
      throw new ServiceError(403, "HTTP operation ticket is invalid", "forbidden");
    }
    return { sessionId: session.id, sequence };
  }

  private requireOperation(
    sessionId: string,
    sequence: bigint
  ): HttpOperationRecord {
    const operation = this.operations.get(httpOperationKey(sessionId, sequence));
    if (operation !== undefined) return operation;
    throw new ServiceError(404, "HTTP operation is unknown", "operation_unknown");
  }

  private finishRecord(
    operation: HttpOperationRecord,
    requestedState: "completed" | "canceled" | "failed",
    now: number
  ): void {
    if (isTerminalHttpOperationState(operation.state)) return;
    if (operation.timer !== null) clearTimeout(operation.timer);
    if (operation.hardTimer !== null) clearTimeout(operation.hardTimer);
    operation.timer = null;
    operation.hardTimer = null;
    operation.state = requestedState;
    operation.terminalAt = now;
    if (this.lifecycle.kind === "supervised") {
      this.lifecycle.terminal({
        listenerInstanceId: this.listenerInstanceId,
        sessionId: operation.sessionId,
        sequence: operation.sequence.toString(),
        scope: operation.scope,
        operation: operation.operation,
        mutationId: operation.mutationId,
        lifetime: operation.lifetime,
        deadlineDelayMs: operation.lifetimeMs
      });
    }
    const session = this.sessions.get(operation.sessionId);
    if (session !== undefined) {
      if (session.active > 0) session.active -= 1;
      this.removeClosedSessionWhenIdle(session);
    }
  }

  private removeClosedSessionWhenIdle(session: HttpOperationSessionRecord): void {
    if (!session.closed || session.active !== 0) return;
    this.sessions.delete(session.id);
    for (const resolve of session.closeWaiters.splice(0)) resolve();
  }

  private requestCancellation(
    operation: HttpOperationRecord,
    reason: Error
  ): void {
    if (isTerminalHttpOperationState(operation.state)) return;
    operation.cancelRequested = true;
    operation.abort.abort(reason);
    if (operation.state !== "running" || operation.hardTimer !== null) return;
    operation.hardTimer = setTimeout(() => {
      operation.hardTimer = null;
      if (operation.state === "running") {
        if (this.lifecycle.kind === "supervised") {
          this.lifecycle.hardDeadline({
            sessionId: operation.sessionId,
            sequence: operation.sequence,
            mutationId: operation.mutationId
          });
        }
      }
    }, HTTP_OPERATION_CANCEL_GRACE_MS);
  }

  private sweep(now: number): void {
    for (const operation of this.operations.values()) {
      if (operation.state === "reserved" && now >= operation.startDeadline) {
        operation.cancelRequested = true;
        this.finishRecord(operation, "canceled", now);
      }
    }
    const retentionCutoff = now - this.terminalRetentionMs;
    for (const [key, operation] of this.operations) {
      if (operation.terminalAt !== null
        && operation.terminalAt <= retentionCutoff) {
        this.operations.delete(key);
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (!session.closed && session.active === 0
        && session.lastActivityAt <= now - HTTP_OPERATION_SESSION_IDLE_MS) {
        session.closed = true;
      }
      this.removeClosedSessionWhenIdle(session);
    }
  }

  private async withGlobalReservationTurn<T>(
    work: () => Promise<T>
  ): Promise<T> {
    const previous = this.globalReservationTail;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    this.globalReservationTail = previous.then(() => hold);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
