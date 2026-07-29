import type { HttpCapabilityScope } from "./http-auth.js";
import type {
  HttpListenerAuthority,
  HttpListenerBinding
} from "./http-listener-authority.js";
import {
  HTTP_OPERATION_LIFETIME_MS,
  HTTP_OPERATION_SESSION_PATH,
  type HttpOperationSessionEnvelope
} from "./http-operation-protocol.js";
import {
  controlHeaders,
  decodeSession,
  jsonRecord,
  unrefDeadlineOutsideWindowsBun
} from "./http-operation-client-codec.js";
import {
  httpOperationResponseError
} from "./http-operation-error.js";
import { withCallerCancellation } from "./promise-cancellation.js";

interface SessionAttempt {
  readonly value: Promise<HttpOperationSessionEnvelope>;
  readonly controller: AbortController;
  settled: boolean;
  waiters: number;
}

export interface HttpOperationSessionPoolOptions {
  readonly authority: HttpListenerAuthority;
  readonly shutdownSignal: AbortSignal;
  readonly onSession?: (
    scope: HttpCapabilityScope,
    payload: HttpOperationSessionEnvelope
  ) => void;
}

/** Owns shared operation-session creation for each listener and scope. */
export class HttpOperationSessionPool {
  private readonly attempts =
    new Map<HttpCapabilityScope, Map<string, SessionAttempt>>();

  constructor(private readonly options: HttpOperationSessionPoolOptions) {}

  async get(
    scope: HttpCapabilityScope,
    callerSignal: AbortSignal | undefined,
    binding: HttpListenerBinding
  ): Promise<HttpOperationSessionEnvelope> {
    this.options.shutdownSignal.throwIfAborted();
    const serverInstanceId = binding.authRecord.instanceId;
    if (this.options.authority.snapshot().authRecord.instanceId
      !== serverInstanceId) {
      throw new Error("1667 listener authority changed before session creation");
    }
    let scoped = this.attempts.get(scope);
    let current = scoped?.get(serverInstanceId);
    if (current === undefined) {
      if (scoped === undefined) {
        scoped = new Map();
        this.attempts.set(scope, scoped);
      }
      current = this.start(scope, binding);
      scoped.set(serverInstanceId, current);
    }

    current.waiters += 1;
    try {
      return await withCallerCancellation(current.value, callerSignal);
    } finally {
      current.waiters -= 1;
      if (!current.settled && current.waiters === 0) {
        current.controller.abort(
          callerSignal?.reason
            ?? new DOMException("Operation canceled", "AbortError")
        );
      }
    }
  }

  discardExcept(listenerInstanceId: string): void {
    for (const [scope, scoped] of this.attempts) {
      for (const [instanceId, attempt] of scoped) {
        if (instanceId === listenerInstanceId) continue;
        attempt.controller.abort(
          new Error("1667 listener instance changed")
        );
        scoped.delete(instanceId);
      }
      if (scoped.size === 0) this.attempts.delete(scope);
    }
  }

  invalidate(scope: HttpCapabilityScope, listenerInstanceId: string): void {
    this.delete(scope, listenerInstanceId);
  }

  dispose(reason: unknown): void {
    for (const scoped of this.attempts.values()) {
      for (const attempt of scoped.values()) {
        attempt.controller.abort(reason);
      }
    }
    this.attempts.clear();
  }

  private start(
    scope: HttpCapabilityScope,
    binding: HttpListenerBinding
  ): SessionAttempt {
    const serverInstanceId = binding.authRecord.instanceId;
    const controller = new AbortController();
    let attempt!: SessionAttempt;
    const timeout = setTimeout(
      () => controller.abort(
        new DOMException(
          "1667 operation-session creation timed out",
          "TimeoutError"
        )
      ),
      HTTP_OPERATION_LIFETIME_MS.control
    );
    unrefDeadlineOutsideWindowsBun(timeout);
    const value = this.create(
      scope,
      controller.signal,
      binding
    ).catch((error: unknown) => {
      this.delete(scope, serverInstanceId, attempt);
      throw error;
    }).finally(() => {
      attempt.settled = true;
      clearTimeout(timeout);
    });
    attempt = {
      value,
      controller,
      settled: false,
      waiters: 0
    };
    return attempt;
  }

  private async create(
    scope: HttpCapabilityScope,
    signal: AbortSignal,
    binding: HttpListenerBinding
  ): Promise<HttpOperationSessionEnvelope> {
    const { authRecord, fetch } = binding;
    const serverInstanceId = authRecord.instanceId;
    if (authRecord.origin !== this.options.authority.root
      || this.options.authority.snapshot().authRecord.instanceId
        !== serverInstanceId) {
      throw new Error("1667 listener authority changed before session creation");
    }
    const response = await fetch(
      `${this.options.authority.root}${HTTP_OPERATION_SESSION_PATH}`,
      {
        method: "POST",
        headers: controlHeaders(
          serverInstanceId,
          authRecord.capabilities[scope]
        ),
        redirect: "error",
        signal
      }
    );
    const payload = await jsonRecord(response);
    if (!response.ok) throw httpOperationResponseError(response, payload);
    const decoded = decodeSession(payload, scope, serverInstanceId);
    this.options.onSession?.(scope, decoded);
    return decoded;
  }

  private delete(
    scope: HttpCapabilityScope,
    listenerInstanceId: string,
    expected?: SessionAttempt
  ): void {
    const scoped = this.attempts.get(scope);
    if (scoped === undefined
      || (expected !== undefined
        && scoped.get(listenerInstanceId) !== expected)) {
      return;
    }
    scoped.delete(listenerInstanceId);
    if (scoped.size === 0) this.attempts.delete(scope);
  }
}
