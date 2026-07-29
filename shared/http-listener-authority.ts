import type { HttpAuthRecord } from "./http-auth.js";
import { withCallerCancellation } from "./promise-cancellation.js";

export type OperationFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface HttpListenerBinding {
  readonly authRecord: HttpAuthRecord;
  readonly fetch: OperationFetch;
}

export type HttpListenerReplacementOutcome =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "rebound";
      readonly binding: HttpListenerBinding;
    }
  | { readonly kind: "replaced" };

export interface HttpListenerAuthorityOptions {
  readonly root: string;
  readonly binding: HttpListenerBinding;
  readonly confirmReplacement?: (
    previousInstanceId: string,
    shutdownSignal: AbortSignal
  ) => Promise<HttpListenerReplacementOutcome>;
}

/** Owns one listener binding and installs serialized replacement proofs. */
export class HttpListenerAuthority {
  private binding: HttpListenerBinding;
  private readonly shutdown = new AbortController();
  private readonly listeners = new Set<(binding: HttpListenerBinding) => void>();
  private replacementTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: HttpListenerAuthorityOptions) {
    if (options.binding.authRecord.origin !== options.root) {
      throw new Error("1667 listener authority origin does not match its root");
    }
    this.binding = options.binding;
  }

  get root(): string {
    return this.options.root;
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdown.signal;
  }

  snapshot(): HttpListenerBinding {
    return this.binding;
  }

  subscribe(listener: (binding: HttpListenerBinding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readonly confirmListenerReplacement = (
    previousInstanceId: string,
    observedReplacement = false,
    callerSignal?: AbortSignal
  ): Promise<HttpListenerReplacementOutcome> => {
    const result = this.replacementTail.then(
      async () => await this.confirmAndInstall(
        previousInstanceId,
        observedReplacement,
        callerSignal
      )
    );
    this.replacementTail = result.then(
      () => undefined,
      () => undefined
    );
    return callerSignal === undefined
      ? result
      : withCallerCancellation(result, callerSignal);
  };

  dispose(reason?: unknown): void {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort(
      reason
        ?? new DOMException("1667 HTTP client shut down", "AbortError")
    );
    this.listeners.clear();
  }

  private async confirmAndInstall(
    previousInstanceId: string,
    observedReplacement: boolean,
    callerSignal: AbortSignal | undefined
  ): Promise<HttpListenerReplacementOutcome> {
    callerSignal?.throwIfAborted();
    if (this.shutdown.signal.aborted) {
      return { kind: "unchanged" };
    }
    if (this.options.confirmReplacement === undefined) {
      return observedReplacement
        ? { kind: "replaced" }
        : { kind: "unchanged" };
    }
    const confirmationSignal = callerSignal === undefined
      ? this.shutdown.signal
      : AbortSignal.any([callerSignal, this.shutdown.signal]);
    const outcome = await this.options.confirmReplacement(
      previousInstanceId,
      confirmationSignal
    );
    callerSignal?.throwIfAborted();
    if (outcome.kind !== "rebound") return outcome;
    const next = outcome.binding;
    if (next.authRecord.origin !== this.options.root
      || next.authRecord.instanceId === previousInstanceId) {
      throw new Error("1667 listener rebound returned invalid authority");
    }
    if (this.binding.authRecord.instanceId !== next.authRecord.instanceId) {
      this.binding = next;
      for (const listener of this.listeners) listener(next);
    }
    return { kind: "rebound", binding: this.binding };
  }
}
