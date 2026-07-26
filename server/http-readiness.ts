import type { HttpCleanupFailure } from "./http-listener-lifecycle.js";

/** Observes one readiness publication without retaining listener resources. */
export class HttpReadiness {
  private accepting = true;
  private completion: Promise<HttpCleanupFailure> | null = null;
  private outcome: HttpCleanupFailure = { kind: "none" };

  track(readiness: Promise<void>, signal: AbortSignal): void {
    if (!this.accepting || this.completion !== null) {
      throw new Error("1667 listener readiness is already tracked or closing");
    }
    this.completion = readiness.then(
      () => this.outcome,
      (error: unknown) => {
        if (!expectedAbort(error, signal)) {
          this.outcome = { kind: "failure", error };
        }
        return this.outcome;
      }
    );
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  currentFailure(): HttpCleanupFailure {
    return this.outcome;
  }

  pendingFailure(): Promise<HttpCleanupFailure> | null {
    return this.completion;
  }
}

function expectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    && (error === signal.reason
      || (error instanceof Error && error.name === "AbortError"));
}
