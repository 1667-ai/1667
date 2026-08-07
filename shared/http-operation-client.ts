import type { HttpCapabilityScope } from "./http-auth.js";
import { createDurableMutationId } from "./durable-mutation-id.js";
import {
  callerCancellationForLifetime,
  resolveHttpApiRoute
} from "./http-operation-policy.js";
import {
  HTTP_OPERATION_RESERVATION_PATH,
  type HttpOperationSessionEnvelope
} from "./http-operation-protocol.js";
import type { StoryAggregateVersion } from "./story-aggregate-version.js";
import { isWorkerMutationMethod } from "./worker-protocol.js";
import type {
  HttpListenerAuthority,
  HttpListenerBinding
} from "./http-listener-authority.js";
export type {
  HttpListenerBinding,
  HttpListenerReplacementOutcome,
  OperationFetch
} from "./http-listener-authority.js";
import {
  createHttpOperationLease,
  type HttpOperationLease,
  type HttpOperationSettlement
} from "./http-operation-lease.js";
export type {
  HttpOperationLease,
  HttpOperationSettlement
} from "./http-operation-lease.js";
import {
  controlHeaders,
  decodeReservation,
  jsonRecord
} from "./http-operation-client-codec.js";
import {
  HttpOperationError,
  httpOperationResponseError
} from "./http-operation-error.js";
export { HttpOperationError } from "./http-operation-error.js";
import {
  HttpOperationSessionPool
} from "./http-operation-session-pool.js";

export interface HttpOperationRunOptions<T> {
  readonly method: string;
  readonly path: string;
  /** Exact listener binding that passed the first preflight. */
  readonly binding: HttpListenerBinding;
  /** Caller-owned durable identity, retained independently of this transport. */
  readonly mutationId?: string;
  readonly requestedLifetimeMs?: number;
  readonly expectedAggregateVersion?: StoryAggregateVersion;
  readonly callerSignal?: AbortSignal;
  /** Last application guard before the reserved operation may be sent. */
  readonly beforeSend?: (lease: HttpOperationLease) => void | Promise<void>;
  /** Owns the complete response body/stream before returning. */
  readonly execute: (lease: HttpOperationLease) => Promise<T>;
  /** Transport-only retry policy. Durable mutations reuse the same identity. */
  readonly shouldRetry?: (error: unknown) => boolean;
}

export interface HttpOperationReserveOptions {
  readonly method: string;
  readonly path: string;
  readonly binding: HttpListenerBinding;
  readonly requestedLifetimeMs?: number;
  readonly callerSignal?: AbortSignal;
  readonly mutationId?: string;
  readonly expectedAggregateVersion?: StoryAggregateVersion;
}

type HttpOperationAttemptOutcome<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "admission-failure"; readonly error: unknown }
  | { readonly kind: "unsent-failure"; readonly error: unknown }
  | { readonly kind: "sent-failure"; readonly error: unknown }
  | { readonly kind: "replaced"; readonly error: unknown }
  | {
      readonly kind: "uncertain";
      readonly error: unknown;
      readonly mutationId: string;
    };

export interface HttpOperationClientOptions {
  readonly authority: HttpListenerAuthority;
  readonly onSession?: (
    scope: HttpCapabilityScope,
    payload: HttpOperationSessionEnvelope
  ) => void;
}

/** Client-side owner for ephemeral scope sessions and per-request leases. */
export class HttpOperationClient {
  private readonly shutdown = new AbortController();
  private readonly sessions: HttpOperationSessionPool;
  private readonly onExternalShutdown = () => this.dispose();
  private readonly stopAuthoritySubscription: () => void;

  constructor(private readonly options: HttpOperationClientOptions) {
    this.sessions = new HttpOperationSessionPool({
      authority: options.authority,
      shutdownSignal: this.shutdown.signal,
      ...(options.onSession === undefined
        ? {}
        : { onSession: options.onSession })
    });
    this.stopAuthoritySubscription = options.authority.subscribe(
      (binding) => this.sessions.discardExcept(binding.authRecord.instanceId)
    );
    if (options.authority.shutdownSignal.aborted) {
      this.dispose();
    } else {
      options.authority.shutdownSignal.addEventListener(
        "abort",
        this.onExternalShutdown,
        { once: true }
      );
    }
  }

  dispose(): void {
    if (this.shutdown.signal.aborted) return;
    this.options.authority.shutdownSignal.removeEventListener(
      "abort",
      this.onExternalShutdown
    );
    this.stopAuthoritySubscription();
    this.shutdown.abort(
      this.options.authority.shutdownSignal.reason
        ?? new DOMException("1667 HTTP operation client shut down", "AbortError")
    );
    this.sessions.dispose(this.shutdown.signal.reason);
  }

  /**
   * Single owner for reserve -> last guard -> send -> durable retry -> settle.
   * Callers must consume the complete response inside execute.
   */
  async run<T>(options: HttpOperationRunOptions<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    const first = await this.runAttempt(
      options,
      options.binding,
      options.mutationId,
      true
    );
    if (first.kind === "completed") return first.value;
    if (first.kind === "admission-failure") {
      const rebound = await this.reboundAfterAdmissionFailure(
        options.binding,
        options.callerSignal
      );
      if (rebound === null) throw first.error;
      const retry = await this.runAttempt(
        options,
        rebound,
        options.mutationId,
        false
      );
      if (retry.kind === "completed") return retry.value;
      throw retry.error;
    }
    if (first.kind !== "uncertain") throw first.error;

    const replay = await this.runAttempt(
      options,
      this.currentBinding(),
      first.mutationId,
      false
    );
    if (replay.kind === "completed") return replay.value;
    if (replay.kind === "admission-failure"
      || replay.kind === "unsent-failure") {
      throw first.error;
    }
    throw replay.error;
  }

  private async runAttempt<T>(
    options: HttpOperationRunOptions<T>,
    binding: HttpListenerBinding,
    mutationId: string | undefined,
    allowRetry: boolean
  ): Promise<HttpOperationAttemptOutcome<T>> {
    let lease: HttpOperationLease;
    try {
      lease = await this.reserve({
        method: options.method,
        path: options.path,
        binding,
        ...(options.requestedLifetimeMs === undefined
          ? {}
          : { requestedLifetimeMs: options.requestedLifetimeMs }),
        ...(options.callerSignal === undefined
          ? {}
          : { callerSignal: options.callerSignal }),
        ...(mutationId === undefined ? {} : { mutationId }),
        ...(options.expectedAggregateVersion === undefined
          ? {}
          : {
              expectedAggregateVersion:
                options.expectedAggregateVersion
            })
      });
    } catch (error) {
      return { kind: "admission-failure", error };
    }

    let execution:
      | { readonly kind: "completed"; readonly value: T }
      | { readonly kind: "failure"; readonly error: unknown };
    let sent = false;
    try {
      options.callerSignal?.throwIfAborted();
      await options.beforeSend?.(lease);
      sent = true;
      execution = {
        kind: "completed",
        value: await options.execute(lease)
      };
    } catch (error) {
      execution = { kind: "failure", error };
    }

    const settlement = await this.settleRunLease(
      lease,
      !sent || options.callerSignal?.aborted === true
    );
    if (execution.kind === "completed") return execution;
    if (settlement.kind === "failed") {
      return {
        kind: "sent-failure",
        error: new HttpOperationError(settlement.failure)
      };
    }
    if (!sent) {
      return { kind: "unsent-failure", error: execution.error };
    }
    const durableMutationId = lease.mutationId;
    if (!allowRetry
      || durableMutationId === null
      || this.shutdown.signal.aborted
      || options.callerSignal?.aborted === true
      || options.shouldRetry?.(execution.error) !== true) {
      return { kind: "sent-failure", error: execution.error };
    }
    return settlement.kind === "replaced"
      ? { kind: "replaced", error: execution.error }
      : {
          kind: "uncertain",
          error: execution.error,
          mutationId: durableMutationId
        };
  }

  private async settleRunLease(
    lease: HttpOperationLease,
    cancel: boolean
  ): Promise<HttpOperationSettlement> {
    const settlement = lease.settle();
    if (!cancel) return await settlement;
    const [outcome] = await Promise.all([settlement, lease.cancel()]);
    return outcome;
  }

  private async reboundAfterAdmissionFailure(
    failedBinding: HttpListenerBinding,
    callerSignal: AbortSignal | undefined
  ): Promise<HttpListenerBinding | null> {
    this.shutdown.signal.throwIfAborted();
    callerSignal?.throwIfAborted();
    const previousInstanceId = failedBinding.authRecord.instanceId;
    const current = this.currentBinding();
    if (current.authRecord.instanceId !== previousInstanceId) return current;
    const cancellation = callerSignal === undefined
      ? this.shutdown.signal
      : AbortSignal.any([callerSignal, this.shutdown.signal]);
    const outcome = await this.options.authority.confirmListenerReplacement(
      previousInstanceId,
      false,
      cancellation
    );
    this.shutdown.signal.throwIfAborted();
    callerSignal?.throwIfAborted();
    return outcome.kind === "rebound" ? outcome.binding : null;
  }

  async reserve(
    options: HttpOperationReserveOptions
  ): Promise<HttpOperationLease> {
    this.shutdown.signal.throwIfAborted();
    const { binding } = options;
    const serverInstanceId = binding.authRecord.instanceId;
    const policy = resolveHttpApiRoute(options.method, options.path);
    const scope = policy.scope;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.sessions.get(
        scope,
        options.callerSignal,
        binding
      );
      const mutation = isWorkerMutationMethod(policy.method);
      if (!mutation && options.mutationId !== undefined) {
        throw new Error("Read-only HTTP operations cannot reuse mutation identity");
      }
      const mutationId = mutation
        ? options.mutationId ?? createDurableMutationId()
        : undefined;
      const response = await binding.fetch(
        `${this.options.authority.root}${HTTP_OPERATION_RESERVATION_PATH}`,
        {
          method: "POST",
          headers: {
            ...controlHeaders(serverInstanceId, session.capability),
            "content-type": "application/json"
          },
          body: JSON.stringify({
            method: options.method,
            path: options.path,
            operation: policy.method,
            ...(options.requestedLifetimeMs === undefined
              ? {}
              : { requestedLifetimeMs: options.requestedLifetimeMs }),
            ...(mutationId === undefined ? {} : { mutationId }),
            ...(options.expectedAggregateVersion === undefined
              ? {}
              : {
                  expectedAggregateVersion:
                    options.expectedAggregateVersion
                })
          }),
          redirect: "error",
          signal: options.callerSignal
        }
      );
      if (response.status === 410 && attempt === 0) {
        this.sessions.invalidate(scope, serverInstanceId);
        continue;
      }
      const payload = await jsonRecord(response);
      if (!response.ok) {
        throw httpOperationResponseError(response, payload);
      }
      const reservation = decodeReservation(payload, serverInstanceId, session);
      return createHttpOperationLease({
        fetch: binding.fetch,
        root: this.options.authority.root,
        serverInstanceId,
        capability: session.capability,
        ticket: reservation.ticket,
        sessionId: reservation.sessionId,
        sequence: reservation.sequence,
        mutationId: mutationId ?? null,
        deadlineEpochMs: reservation.deadlineEpochMs,
        callerSignal: options.callerSignal,
        shutdownSignal: this.shutdown.signal,
        confirmListenerReplacement:
          this.options.authority.confirmListenerReplacement,
        callerCancellation:
          callerCancellationForLifetime(policy.lifetime)
      });
    }
    throw new Error("1667 operation-session retry was exhausted");
  }

  private currentBinding(): HttpListenerBinding {
    return this.options.authority.snapshot();
  }
}
