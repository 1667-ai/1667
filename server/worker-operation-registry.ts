import {
  WORKER_MAX_OPERATION_SEQUENCE,
  WORKER_OPERATION_CAPACITY,
  WORKER_TERMINAL_RETENTION_MS,
  isWorkerOperationId,
  workerOperationKey,
  type WorkerOperationId,
  type WorkerOperationState
} from "../shared/worker-protocol.js";
import { performance } from "node:perf_hooks";
import { ServiceError } from "./errors.js";

interface OperationRecord {
  readonly id: WorkerOperationId;
  state: Exclude<WorkerOperationState, "unknown">;
  terminalAt: number | null;
}

export interface WorkerOperationRegistryOptions {
  capacity?: number;
  terminalRetentionMs?: number;
  now?: () => number;
}

/** Worker-incarnation high-water mark plus bounded live/terminal lifecycle. */
export class WorkerOperationRegistry {
  private readonly records = new Map<string, OperationRecord>();
  private readonly capacity: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => number;
  private lastAcceptedSequence = 0n;

  constructor(
    readonly workerInstanceId: string,
    options: WorkerOperationRegistryOptions = {}
  ) {
    this.capacity = options.capacity ?? WORKER_OPERATION_CAPACITY;
    this.terminalRetentionMs = options.terminalRetentionMs
      ?? WORKER_TERMINAL_RETENTION_MS;
    this.now = options.now ?? (() => performance.now());
  }

  /** Advances the high-water mark before capacity/admission checks. */
  accept(idValue: unknown): "accepted" | "capacity" {
    const id = this.requireCurrentId(idValue);
    this.lastAcceptedSequence = nextWorkerOperationSequence(
      this.lastAcceptedSequence,
      id.sequence
    );
    this.sweep();
    if (this.records.size >= this.capacity) return "capacity";
    this.records.set(workerOperationKey(id), {
      id,
      state: "running",
      terminalAt: null
    });
    return "accepted";
  }

  finish(
    id: WorkerOperationId,
    state: Exclude<WorkerOperationState, "running" | "unknown">
  ): void {
    const record = this.records.get(workerOperationKey(id));
    if (record === undefined || record.state !== "running") return;
    record.state = state;
    record.terminalAt = this.now();
  }

  state(idValue: unknown): WorkerOperationState {
    const id = this.requireKnownSequence(idValue);
    this.sweep();
    return this.records.get(workerOperationKey(id))?.state ?? "unknown";
  }

  acknowledgeTerminal(idValue: unknown): "acknowledged" | "running" {
    const id = this.requireKnownSequence(idValue);
    this.sweep();
    const key = workerOperationKey(id);
    const record = this.records.get(key);
    if (record === undefined) return "acknowledged";
    if (record.state === "running") return "running";
    this.records.delete(key);
    return "acknowledged";
  }

  get size(): number {
    this.sweep();
    return this.records.size;
  }

  private requireKnownSequence(value: unknown): WorkerOperationId {
    const id = this.requireCurrentId(value);
    if (id.sequence > this.lastAcceptedSequence) {
      throw invalidSequence("Worker operation sequence was never accepted");
    }
    return id;
  }

  private requireCurrentId(value: unknown): WorkerOperationId {
    if (!isWorkerOperationId(value)) {
      throw invalidSequence("Malformed worker operation ID");
    }
    if (value.workerInstanceId !== this.workerInstanceId) {
      throw invalidSequence("Worker operation belongs to a different incarnation");
    }
    return value;
  }

  private sweep(): void {
    const cutoff = this.now() - this.terminalRetentionMs;
    for (const [key, record] of this.records) {
      if (record.terminalAt !== null && record.terminalAt <= cutoff) {
        this.records.delete(key);
      }
    }
  }
}

export function nextWorkerOperationSequence(
  lastAccepted: bigint,
  received: bigint
): bigint {
  if (lastAccepted === WORKER_MAX_OPERATION_SEQUENCE) {
    throw invalidSequence("Worker operation sequence is exhausted");
  }
  const expected = lastAccepted + 1n;
  if (received !== expected) {
    throw invalidSequence(
      received < expected
        ? "Worker operation sequence was replayed"
        : "Worker operation sequence skipped a value"
    );
  }
  return received;
}

function invalidSequence(message: string): ServiceError {
  return new ServiceError(409, message, "invalid_request");
}
