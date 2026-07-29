type NpmChildCallbackPhase =
  | { readonly kind: "starting" }
  | { readonly kind: "starting-runner-error"; readonly runnerError: Error }
  | { readonly kind: "ready"; readonly pid: number }
  | { readonly kind: "ready-runner-error"; readonly pid: number;
    readonly runnerError: Error }
  | { readonly kind: "permitted"; readonly pid: number }
  | { readonly kind: "permitted-runner-error"; readonly pid: number;
    readonly runnerError: Error }
  | { readonly kind: "terminal-pending"; readonly pid: number }
  | { readonly kind: "terminal-pending-runner-error"; readonly pid: number;
    readonly runnerError: Error }
  | { readonly kind: "terminal-recorded"; readonly pid: number }
  | { readonly kind: "terminating"; readonly pid: number | null;
    readonly supervisor: "open" | "closed"; readonly error: Error }
  | { readonly kind: "settled" };

export class NpmChildStateUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NpmChildStateUncertainError";
  }
}

export interface NpmChildTerminalTransition {
  readonly pid: number;
  readonly runnerError: Error | undefined;
}

export interface NpmChildUncertaintyTransition {
  readonly pid: number | null;
  readonly error: Error;
}

export type NpmChildSupervisorErrorTransition =
  | { readonly kind: "ignored" }
  | { readonly kind: "reject-start"; readonly error: Error }
  | { readonly kind: "terminate";
    readonly uncertainty: NpmChildUncertaintyTransition };

export class NpmChildCallbackLifecycle {
  #phase: NpmChildCallbackPhase = Object.freeze({ kind: "starting" });

  ready(pid: unknown): number {
    if (!isStarting(this.#phase)
      || typeof pid !== "number"
      || !Number.isSafeInteger(pid)
      || pid <= 0) {
      throw new Error("npm child supervisor sent an invalid ready message");
    }
    this.#phase = runnerError(this.#phase) === undefined
      ? Object.freeze({ kind: "ready", pid })
      : Object.freeze({
          kind: "ready-runner-error",
          pid,
          runnerError: runnerError(this.#phase)!
        });
    return pid;
  }

  writeDeadlineStarted(): void {
    if (this.#phase.kind === "ready") {
      this.#phase = Object.freeze({
        kind: "permitted",
        pid: this.#phase.pid
      });
      return;
    }
    if (this.#phase.kind === "ready-runner-error") {
      this.#phase = Object.freeze({
        kind: "permitted-runner-error",
        pid: this.#phase.pid,
        runnerError: this.#phase.runnerError
      });
      return;
    }
    throw new Error("npm child write deadline started before durable ready");
  }

  runnerFailed(error: Error): void {
    switch (this.#phase.kind) {
      case "starting":
        this.#phase = Object.freeze({
          kind: "starting-runner-error",
          runnerError: error
        });
        break;
      case "starting-runner-error":
        this.#phase = Object.freeze({ ...this.#phase, runnerError: error });
        break;
      case "ready":
      case "permitted":
        this.#phase = Object.freeze({
          kind: `${this.#phase.kind}-runner-error`,
          pid: this.#phase.pid,
          runnerError: error
        });
        break;
      case "ready-runner-error":
      case "permitted-runner-error":
        this.#phase = Object.freeze({ ...this.#phase, runnerError: error });
        break;
      case "terminal-pending":
      case "terminal-pending-runner-error":
      case "terminal-recorded":
      case "terminating":
      case "settled":
        break;
    }
  }

  terminal(pid: unknown): NpmChildTerminalTransition {
    if (!isPermitted(this.#phase) || pid !== this.#phase.pid) {
      throw new Error("npm child supervisor exit identity changed");
    }
    const transition = Object.freeze({
      pid: this.#phase.pid,
      runnerError: runnerError(this.#phase)
    });
    this.#phase = transition.runnerError === undefined
      ? Object.freeze({ kind: "terminal-pending", pid: transition.pid })
      : Object.freeze({
          kind: "terminal-pending-runner-error",
          pid: transition.pid,
          runnerError: transition.runnerError
        });
    return transition;
  }

  terminalRecorded(): void {
    if (this.#phase.kind !== "terminal-pending"
      && this.#phase.kind !== "terminal-pending-runner-error") {
      throw new Error("npm child terminal record transition is invalid");
    }
    this.#phase = Object.freeze({
      kind: "terminal-recorded",
      pid: this.#phase.pid
    });
  }

  keeperSettled(pid: unknown): void {
    if (this.#phase.kind !== "terminal-recorded"
      || pid !== this.#phase.pid) {
      throw new Error("npm child keeper settlement identity changed");
    }
    this.#phase = Object.freeze({ kind: "settled" });
  }

  beginUncertainty(
    cause: unknown,
    supervisor: "open" | "closed" = "open"
  ): NpmChildUncertaintyTransition | null {
    if (this.#phase.kind === "terminating" || this.#phase.kind === "settled") {
      return null;
    }
    const transition = Object.freeze({
      pid: phasePid(this.#phase),
      error: new NpmChildStateUncertainError(
        "npm child state became uncertain; release writes must stop",
        { cause: asError(cause) }
      )
    });
    this.#phase = Object.freeze({
      kind: "terminating",
      pid: transition.pid,
      supervisor,
      error: transition.error
    });
    return transition;
  }

  supervisorFailed(error: Error): NpmChildSupervisorErrorTransition {
    if (isStarting(this.#phase)) {
      this.#phase = Object.freeze({ kind: "settled" });
      return Object.freeze({
        kind: "reject-start",
        error: new Error("npm child supervisor did not start", { cause: error })
      });
    }
    const uncertainty = this.beginUncertainty(error);
    return uncertainty === null
      ? Object.freeze({ kind: "ignored" })
      : Object.freeze({ kind: "terminate", uncertainty });
  }

  supervisorClosed(): NpmChildUncertaintyTransition | null {
    if (this.#phase.kind === "terminating") {
      this.#phase = Object.freeze({
        ...this.#phase,
        supervisor: "closed"
      });
      return null;
    }
    if (this.#phase.kind === "settled") return null;
    const cause = new Error(
      phasePid(this.#phase) === null
        ? "npm child runner did not reach its durable gate"
        : "npm child supervisor exited without a terminal record",
      { cause: runnerError(this.#phase) }
    );
    return this.beginUncertainty(cause, "closed");
  }

  terminationSettled(): void {
    if (this.#phase.kind !== "terminating") {
      throw new Error("npm child termination transition is invalid");
    }
    this.#phase = Object.freeze({ kind: "settled" });
  }

  startedPid(): number | null {
    return phasePid(this.#phase);
  }

  isSupervisorClosed(): boolean {
    return this.#phase.kind === "terminating"
      && this.#phase.supervisor === "closed";
  }

}

function isStarting(
  phase: NpmChildCallbackPhase
): phase is Extract<NpmChildCallbackPhase, {
  readonly kind: "starting" | "starting-runner-error";
}> {
  return phase.kind === "starting" || phase.kind === "starting-runner-error";
}

function isPermitted(
  phase: NpmChildCallbackPhase
): phase is Extract<NpmChildCallbackPhase, {
  readonly kind: "permitted" | "permitted-runner-error";
}> {
  return phase.kind === "permitted" || phase.kind === "permitted-runner-error";
}

function phasePid(phase: NpmChildCallbackPhase): number | null {
  return "pid" in phase ? phase.pid : null;
}

function runnerError(phase: NpmChildCallbackPhase): Error | undefined {
  return "runnerError" in phase ? phase.runnerError : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
