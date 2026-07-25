import {
  WORKER_STARTUP_LIVENESS_TIMEOUT_MS,
  WORKER_STARTUP_TIMEOUT_MS,
  WORKER_SHUTDOWN_GRACE_MS,
  WORKER_TERMINATION_CONFIRM_MS,
  type MainToWorkerMessage
} from "../../shared/worker-protocol.js";
import { WorkerExitUnconfirmedError } from "./worker-data-lock.js";
import { BackendRestartRequiredError } from "./worker-error.js";
import { isShutdownTerminalMessage } from "./worker-message.js";

export interface WorkerLike {
  postMessage(message: MainToWorkerMessage): void;
  terminate(): void | Promise<unknown>;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface WorkerLifecycleOptions {
  readyTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  terminationConfirmMs?: number;
}

type LifecycleState =
  | { phase: "starting"; worker: "running" | "exited" }
  | { phase: "ready"; worker: "running" | "exited" }
  | { phase: "disposing"; worker: "running" | "exited" }
  | { phase: "closed"; worker: "running" | "exited" };

/** Owns startup liveness, shutdown, and exit-confirmation state. */
export class WorkerLifecycle {
  readonly ready: Promise<void>;
  readonly failure: Promise<Error>;
  private state: LifecycleState = { phase: "starting", worker: "running" };
  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  private failureResolve!: (error: Error) => void;
  private readyDeadline: ReturnType<typeof setTimeout> | null = null;
  private startupDeadline: ReturnType<typeof setTimeout> | null = null;
  private termination: Promise<void> | null = null;
  private forcedTermination: Promise<void> | null = null;
  private workerTermination: Promise<void> | null = null;

  constructor(
    private readonly worker: WorkerLike,
    private readonly options: WorkerLifecycleOptions,
    private readonly onDeadline: (error: Error) => void
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.failure = new Promise((resolve) => { this.failureResolve = resolve; });
  }

  get acceptingRequests(): boolean {
    return this.state.phase === "ready" && this.state.worker === "running";
  }

  get unexpectedExitIsFailure(): boolean {
    return this.state.phase === "starting" || this.state.phase === "ready";
  }

  get hasReachedReady(): boolean {
    return this.state.phase !== "starting";
  }

  start(): void {
    this.armStartupDeadline();
    this.armReadyDeadline();
  }

  reportStarting(): boolean {
    if (this.state.phase !== "starting" || this.state.worker !== "running") return false;
    this.armReadyDeadline();
    return true;
  }

  reportReady(): boolean {
    if (this.state.phase === "ready" && this.state.worker === "running") return true;
    if (this.state.phase !== "starting" || this.state.worker !== "running") return false;
    this.state = { phase: "ready", worker: "running" };
    this.clearStartupDeadlines();
    this.readyResolve();
    return true;
  }

  markExited(): void {
    this.state = { phase: this.state.phase, worker: "exited" };
  }

  beginDispose(): boolean {
    if (this.state.phase === "closed" || this.state.phase === "disposing") return false;
    this.state = { phase: "disposing", worker: this.state.worker };
    return true;
  }

  close(error: Error): boolean {
    if (this.state.phase === "closed") return false;
    const worker = this.state.worker;
    this.state = { phase: "closed", worker };
    this.clearStartupDeadlines();
    this.readyReject(error);
    return true;
  }

  signalFailure(error: Error): void {
    this.failureResolve(error);
  }

  stop(graceful: boolean): Promise<void> {
    if (!graceful) {
      if (this.forcedTermination !== null) return this.forcedTermination;
      this.forcedTermination = this.terminateWorkerForRestart();
      this.termination = this.forcedTermination;
      return this.forcedTermination;
    }
    if (this.termination !== null) return this.termination;
    this.termination = this.shutdownWorker();
    return this.termination;
  }

  async awaitTermination(): Promise<void> {
    if (this.termination !== null) await this.termination;
  }

  private armReadyDeadline(): void {
    if (this.state.phase !== "starting") return;
    if (this.readyDeadline !== null) clearTimeout(this.readyDeadline);
    const timeoutMs = this.options.readyTimeoutMs ?? WORKER_STARTUP_LIVENESS_TIMEOUT_MS;
    this.readyDeadline = setTimeout(() => this.onDeadline(new Error(
      `Embedded backend stopped reporting startup progress for ${timeoutMs} ms`
    )), timeoutMs);
  }

  private armStartupDeadline(): void {
    const timeoutMs = this.options.startupTimeoutMs ?? WORKER_STARTUP_TIMEOUT_MS;
    this.startupDeadline = setTimeout(() => this.onDeadline(new Error(
      `Embedded backend did not become ready within ${timeoutMs} ms`
    )), timeoutMs);
  }

  private clearStartupDeadlines(): void {
    if (this.readyDeadline !== null) clearTimeout(this.readyDeadline);
    if (this.startupDeadline !== null) clearTimeout(this.startupDeadline);
    this.readyDeadline = null;
    this.startupDeadline = null;
  }

  private async shutdownWorker(): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (stopped: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.worker.removeEventListener("message", onMessage);
        this.worker.removeEventListener("error", onError);
        this.worker.removeEventListener("close", onClose);
        resolve(stopped);
      };
      const timer = setTimeout(
        () => finish(false),
        this.options.shutdownGraceMs ?? WORKER_SHUTDOWN_GRACE_MS
      );
      const onMessage = ((event: MessageEvent<unknown>) => {
        if (isShutdownTerminalMessage(event.data)) finish(true);
        else if (isProtocolErrorMessage(event.data)) finish(false);
      }) as EventListener;
      const onError = (() => finish(false)) as EventListener;
      const onClose = (() => {
        this.state = { phase: this.state.phase, worker: "exited" };
        finish(false);
      }) as EventListener;
      this.worker.addEventListener("message", onMessage);
      this.worker.addEventListener("error", onError);
      this.worker.addEventListener("close", onClose);
      try {
        this.worker.postMessage({ type: "shutdown" });
      } catch {
        finish(false);
      }
    });
    await this.terminateWorkerForRestart("embedded backend exit could not be confirmed after shutdown");
    if (!confirmed) {
      throw new BackendRestartRequiredError(
        "embedded backend did not confirm an exact stopped state"
      );
    }
  }

  private async terminateWorkerForRestart(
    message = "embedded backend exit could not be confirmed"
  ): Promise<void> {
    try {
      await this.terminateWorker();
    } catch (error) {
      throw new BackendRestartRequiredError(message, { cause: error });
    }
  }

  private terminateWorker(): Promise<void> {
    this.workerTermination ??= this.runWorkerTermination();
    return this.workerTermination;
  }

  private async runWorkerTermination(): Promise<void> {
    if (this.state.worker === "exited") return;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.worker.removeEventListener("close", onClose);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new WorkerExitUnconfirmedError()),
        this.options.terminationConfirmMs ?? WORKER_TERMINATION_CONFIRM_MS
      );
      const onClose = (() => {
        this.state = { phase: this.state.phase, worker: "exited" };
        finish();
      }) as EventListener;
      this.worker.addEventListener("close", onClose);
      try {
        const terminated = this.worker.terminate();
        if (terminated instanceof Promise) void terminated.catch(() => undefined);
      } catch {
        // Exit remains unconfirmed; the data-directory lock must stay retained.
      }
    });
  }
}

function isProtocolErrorMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && (value as { type?: unknown }).type === "protocolError";
}
