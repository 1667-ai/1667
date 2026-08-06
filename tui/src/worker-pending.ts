import {
  WORKER_MAX_OPERATION_SEQUENCE,
  isWorkerInstanceId,
  workerOperationKey,
  type WorkerMethod,
  type WorkerOperationId
} from "../../shared/worker-protocol.js";

export interface PendingCall {
  readonly id: WorkerOperationId;
  readonly method: WorkerMethod;
  readonly replay: boolean;
  readonly stream: boolean;
  readonly mutationId?: string;
  /** True when a durable outbox intent was published for this mutation.
   * Local-durability-tier mutations carry a mutation ID without an intent,
   * so cancellation and terminal settlement skip outbox transitions. */
  readonly durableIntent: boolean;
  cancelled: boolean;
  settling: boolean;
  expectedSequence: number;
  /** Stream text that arrived after this call's signal aborted. The
   * transport never calls `onDelta` past that point; it collects the text
   * here and hands the whole tail to `onStopped` at terminal settlement,
   * so a Stop save still receives every byte the server delivered. */
  stoppedTail: string;
  onDelta?: (text: string) => void;
  onStopped?: (text: string) => void;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  startCancellationGrace(timeoutMs: number, onTimeout: () => void): void;
  cleanup(): void;
}

interface OpenPendingCall {
  method: WorkerMethod;
  replay: boolean;
  stream: boolean;
  mutationId?: string;
  /** Required so no call site can imply a durable intent it never wrote. */
  durableIntent: boolean;
  onDelta?: (text: string) => void;
  onStopped?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs: number;
  onAbort?(id: WorkerOperationId): void;
  onTimeout(id: WorkerOperationId): void;
}

export interface RegisteredCall<T> {
  readonly id: WorkerOperationId;
  readonly promise: Promise<T>;
}

/** Shared allocation, cancellation, and timer lifecycle for live and replay calls. */
export class PendingRequestRegistry {
  private readonly calls = new Map<string, PendingCall>();
  private workerInstanceId: string | null = null;

  constructor(private nextSequence = 0n) {
    if (nextSequence < 0n || nextSequence > WORKER_MAX_OPERATION_SEQUENCE) {
      throw new RangeError("Worker operation sequence must be a uint64");
    }
  }

  bindWorkerInstance(workerInstanceId: string): void {
    if (!isWorkerInstanceId(workerInstanceId)) {
      throw new Error("Embedded backend supplied an invalid worker incarnation");
    }
    if (this.workerInstanceId !== null && this.workerInstanceId !== workerInstanceId) {
      throw new Error("Embedded backend changed worker incarnation");
    }
    this.workerInstanceId = workerInstanceId;
  }

  open<T>(options: OpenPendingCall): RegisteredCall<T> {
    if (this.workerInstanceId === null) {
      throw new Error("Embedded backend worker incarnation is unavailable");
    }
    if (this.nextSequence === WORKER_MAX_OPERATION_SEQUENCE) {
      throw new Error("Embedded backend worker operation sequence is exhausted");
    }
    const id = Object.freeze({
      workerInstanceId: this.workerInstanceId,
      sequence: ++this.nextSequence
    });
    const key = workerOperationKey(id);
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const abort = () => {
      const pending = this.calls.get(key);
      if (pending !== undefined) pending.cancelled = true;
      options.onAbort?.(id);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const replaceTimeout = (timeoutMs: number, onTimeout: () => void) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    let cancellationGraceStarted = false;
    const startCancellationGrace = (timeoutMs: number, onTimeout: () => void) => {
      if (cancellationGraceStarted) return;
      cancellationGraceStarted = true;
      replaceTimeout(timeoutMs, onTimeout);
    };
    replaceTimeout(options.timeoutMs, () => options.onTimeout(id));
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      options.signal?.removeEventListener("abort", abort);
    };
    const call: PendingCall = {
      id,
      method: options.method,
      replay: options.replay,
      stream: options.stream,
      durableIntent: options.durableIntent,
      cancelled: false,
      settling: false,
      expectedSequence: 0,
      stoppedTail: "",
      ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
      ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
      ...(options.onStopped === undefined ? {} : { onStopped: options.onStopped }),
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
      startCancellationGrace,
      cleanup
    };
    this.calls.set(key, call);
    options.signal?.addEventListener("abort", abort, { once: true });
    return { id, promise };
  }

  get(id: WorkerOperationId): PendingCall | undefined {
    return this.calls.get(workerOperationKey(id));
  }

  isCurrent(call: PendingCall): boolean {
    return this.get(call.id) === call;
  }

  *ids(): IterableIterator<WorkerOperationId> {
    for (const call of this.calls.values()) yield call.id;
  }

  discard(id: WorkerOperationId): PendingCall | undefined {
    const key = workerOperationKey(id);
    const call = this.calls.get(key);
    if (call === undefined) return undefined;
    this.calls.delete(key);
    call.cleanup();
    return call;
  }

  reject(id: WorkerOperationId, error: unknown): void {
    const call = this.discard(id);
    call?.reject(error);
  }

  close(error: unknown): void {
    for (const call of this.calls.values()) {
      call.cleanup();
      call.reject(error);
    }
    this.calls.clear();
  }
}
