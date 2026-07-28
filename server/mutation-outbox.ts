import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { exactStringPattern } from "./story-wire-patterns.js";
import {
  MUTATION_INPUT_PROTOCOL_VERSION,
  LEGACY_WORKER_PROTOCOL_VERSION,
  isMutatingWorkerMethod,
  isWorkerMethod,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import {
  decodeFailureEnvelope,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { ServiceError } from "./errors.js";
import {
  mkdirDurable,
  requireDurableCommit,
  unlinkDurable,
  writeDurableAtomic
} from "./story-lifecycle.js";

const LEGACY_MUTATION_ID_PATTERN = exactStringPattern("m1-[0-9a-z]+-[0-9a-f]{32}");
const DURABLE_MUTATION_ID_PATTERN = exactStringPattern("m1\\.[0-9]{13}\\.[0-9a-f]{32}");
const CANCELLATION_MARKER_SUFFIX = ".cancelled.json";

export interface MutationOutboxRecord {
  format: "1667-mutation-outbox";
  schemaVersion: 1;
  mutationId: string;
  /** Monotonic main-thread admission order; absent only on pre-sequence records. */
  sequence?: number;
  /** Worker input schema; absent only on protocol-v3 records. */
  protocolVersion?: number;
  method: WorkerMethod;
  input: unknown;
  expectedAggregateVersion?: StoryAggregateVersion;
  createdAt: string;
  cancelledAt?: string;
}

export type MutationOutboxResolution = FailureEnvelope;

export interface ArchivedMutationOutboxRecord {
  format: "1667-mutation-outbox-archive";
  schemaVersion: 1;
  intent: MutationOutboxRecord;
  resolution: MutationOutboxResolution;
  resolvedAt: string;
}

interface MutationOutboxCancellationMarker {
  format: "1667-mutation-outbox-cancellation";
  schemaVersion: 1;
  mutationId: string;
  cancelledAt: string;
}

export function storyIdFromMutationIntent(
  record: Pick<MutationOutboxRecord, "input"> | null
): string | null {
  if (record === null || record.input === null
    || typeof record.input !== "object" || Array.isArray(record.input)) {
    return null;
  }
  const input = record.input as Record<string, unknown>;
  if (typeof input.storyId === "string") return input.storyId;
  return typeof input.id === "string" ? input.id : null;
}

/** Main-thread durable intent. A replacement worker reuses the exact ID/input. */
export class MutationOutbox {
  private admissionQueue: Promise<void> = Promise.resolve();
  private nextSequence: number | null = null;

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdirDurable(this.dir);
    if (this.nextSequence === null) {
      const records = await this.list();
      this.nextSequence = records.reduce((maximum, record) =>
        Math.max(maximum, record.sequence ?? 0), 0) + 1;
    }
  }

  async enqueue(
    mutationId: string,
    method: WorkerMethod,
    input: unknown,
    expectedAggregateVersion?: StoryAggregateVersion
  ): Promise<void> {
    await this.serializeAdmission(async () => {
      validateMutationId(mutationId);
      if (this.nextSequence === null) await this.init();
      const sequence = this.nextSequence!;
      if (!Number.isSafeInteger(sequence)) throw new ServiceError(500, "Mutation outbox sequence is exhausted");
      this.nextSequence = sequence + 1;
      const record: MutationOutboxRecord = {
        format: "1667-mutation-outbox",
        schemaVersion: 1,
        mutationId,
        sequence,
        protocolVersion: MUTATION_INPUT_PROTOCOL_VERSION,
        method,
        input,
        ...(expectedAggregateVersion === undefined ? {} : {
          expectedAggregateVersion: structuredClone(expectedAggregateVersion)
        }),
        createdAt: new Date().toISOString()
      };
      requireDurableCommit(
        await writeDurableAtomic(this.file(mutationId), `${JSON.stringify(record)}\n`),
        `Saving mutation outbox intent ${mutationId}`
      );
    });
  }

  async remove(mutationId: string): Promise<void> {
    validateMutationId(mutationId);
    await removeDurablyIfPresent(
      this.file(mutationId),
      `Clearing mutation outbox intent ${mutationId}`
    );
    await removeDurablyIfPresent(
      this.cancellationFile(mutationId),
      `Clearing mutation outbox cancellation ${mutationId}`
    );
  }

  /** Persist user cancellation before notifying the worker. A replacement
   * process clears this intent without replaying its provider operation. */
  async cancel(mutationId: string): Promise<void> {
    validateMutationId(mutationId);
    const cancelledAt = new Date().toISOString();
    const marker: MutationOutboxCancellationMarker = {
      format: "1667-mutation-outbox-cancellation",
      schemaVersion: 1,
      mutationId,
      cancelledAt
    };
    // This separate marker can commit while an intent publication is stuck
    // after its rename. Its .json name makes older readers fail closed instead
    // of replaying a cancellation state they do not understand.
    requireDurableCommit(
      await writeDurableAtomic(
        this.cancellationFile(mutationId),
        `${JSON.stringify(marker)}\n`
      ),
      `Saving mutation outbox cancellation ${mutationId}`
    );
    let intent: MutationOutboxRecord;
    try {
      intent = parseRecord(
        JSON.parse(await readFile(this.file(mutationId), "utf8")) as unknown,
        mutationId
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (intent.cancelledAt !== undefined) return;
    intent.cancelledAt = cancelledAt;
    requireDurableCommit(
      await writeDurableAtomic(this.file(mutationId), `${JSON.stringify(intent)}\n`),
      `Cancelling mutation outbox intent ${mutationId}`
    );
  }

  /** Preserve an ambiguous intent as a durable startup warning, then remove
   * it from the active replay fence. Its mutation receipt remains
   * authoritative, so the old ID can never re-enter provider execution. */
  async archive(
    mutationId: string,
    resolution: MutationOutboxResolution
  ): Promise<ArchivedMutationOutboxRecord> {
    validateMutationId(mutationId);
    const intent = parseRecord(
      JSON.parse(await readFile(this.file(mutationId), "utf8")) as unknown,
      mutationId
    );
    const archiveDir = this.archiveDir();
    await mkdirDurable(archiveDir);
    const archived: ArchivedMutationOutboxRecord = {
      format: "1667-mutation-outbox-archive",
      schemaVersion: 1,
      intent,
      resolution,
      resolvedAt: new Date().toISOString()
    };
    requireDurableCommit(
      await writeDurableAtomic(path.join(archiveDir, `${mutationId}.json`), `${JSON.stringify(archived)}\n`),
      `Archiving ambiguous mutation outbox intent ${mutationId}`
    );
    await this.remove(mutationId);
    return archived;
  }

  async list(): Promise<MutationOutboxRecord[]> {
    const names = (await readdir(this.dir))
      .filter((name) => name.endsWith(".json") && !name.endsWith(CANCELLATION_MARKER_SUFFIX))
      .sort();
    const records: MutationOutboxRecord[] = [];
    for (const name of names) {
      const mutationId = name.slice(0, -5);
      validateMutationId(mutationId);
      const value: unknown = JSON.parse(await readFile(path.join(this.dir, name), "utf8"));
      records.push(parseRecord(value, mutationId));
    }
    const seenSequences = new Set<number>();
    for (const record of records) {
      if (record.sequence === undefined) continue;
      if (seenSequences.has(record.sequence)) throw corruptOutbox(record.mutationId);
      seenSequences.add(record.sequence);
    }
    return records.sort(compareAdmissionOrder);
  }

  async listCancellationMarkers(): Promise<string[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir))
        .filter((name) => name.endsWith(CANCELLATION_MARKER_SUFFIX))
        .sort();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return await Promise.all(names.map(async (name) => {
      const mutationId = name.slice(0, -CANCELLATION_MARKER_SUFFIX.length);
      validateMutationId(mutationId);
      const value: unknown = JSON.parse(
        await readFile(path.join(this.dir, name), "utf8")
      );
      return parseCancellationMarker(value, mutationId).mutationId;
    }));
  }

  /** Archived ambiguities do not replay or fence writes, but remain visible
   * on every startup so a crash between archival and UI rendering cannot
   * hide duplicate-provider risk. */
  async listArchived(): Promise<ArchivedMutationOutboxRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.archiveDir())).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const records: ArchivedMutationOutboxRecord[] = [];
    for (const name of names) {
      const mutationId = name.slice(0, -5);
      validateMutationId(mutationId);
      const value: unknown = JSON.parse(await readFile(path.join(this.archiveDir(), name), "utf8"));
      records.push(parseArchivedRecord(value, mutationId));
    }
    return records;
  }

  /** Retire the actionable warning after aggregate acknowledgement or status
   * reconciliation proves the archived provider fence is no longer pending. */
  async dismissArchived(mutationId: string): Promise<void> {
    validateMutationId(mutationId);
    try {
      requireDurableCommit(
        await unlinkDurable(
          path.join(this.archiveDir(), `${mutationId}.json`)
        ),
        `Dismissing archived mutation warning ${mutationId}`
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private file(mutationId: string): string {
    return path.join(this.dir, `${mutationId}.json`);
  }

  private cancellationFile(mutationId: string): string {
    return path.join(this.dir, `${mutationId}${CANCELLATION_MARKER_SUFFIX}`);
  }

  private archiveDir(): string {
    return path.join(path.dirname(this.dir), `${path.basename(this.dir)}-archive`);
  }

  private async serializeAdmission(work: () => Promise<void>): Promise<void> {
    const operation = this.admissionQueue.then(work, work);
    this.admissionQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

/** Every lock-owning writer must call this before opening StoryStore. Deferred
 * worker intents are older than any maintenance action and must replay first.
 * Only full-tier mutations (provider-backed and lifecycle methods) publish
 * intents; local-durability-tier mutations commit or vanish atomically, so
 * their absence here proves nothing is pending for them. Local-method intents
 * retained by an older build still replay through this fence. */
export async function assertNoPendingMutationIntents(dataDir: string): Promise<ArchivedMutationOutboxRecord[]> {
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  await outbox.init();
  if ((await outbox.list()).length > 0) {
    throw new ServiceError(
      409,
      "Retained embedded mutations require recovery; start the TUI with --embedded before opening another writer.",
      "mutation_outcome_unknown"
    );
  }
  return await outbox.listArchived();
}

function parseRecord(value: unknown, mutationId: string): MutationOutboxRecord {
  if (value === null || typeof value !== "object") throw corruptOutbox(mutationId);
  const record = value as Partial<MutationOutboxRecord>;
  if (record.format !== "1667-mutation-outbox" || record.schemaVersion !== 1
    || record.mutationId !== mutationId || !isWorkerMethod(record.method)
    || !isRetainedOutboxMutation(record.method, record.protocolVersion)
    || (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || record.sequence < 1))
    || (record.protocolVersion !== undefined
      && (!Number.isSafeInteger(record.protocolVersion) || record.protocolVersion < 1))
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || !("input" in record)
    || (record.cancelledAt !== undefined
      && (typeof record.cancelledAt !== "string" || !Number.isFinite(Date.parse(record.cancelledAt))))) {
    throw corruptOutbox(mutationId);
  }
  return record as MutationOutboxRecord;
}

function isRetainedOutboxMutation(method: WorkerMethod, protocolVersion: number | undefined): boolean {
  if (isMutatingWorkerMethod(method)) return true;
  // Protocol v3 briefly wrapped flat settings writes in the caller outbox.
  // Retain only to send it through the worker's explicit no-mutation rejection
  // and archive the ambiguity; it must never enter the v4 settings service.
  return method === "saveSettings"
    && (protocolVersion ?? LEGACY_WORKER_PROTOCOL_VERSION) === LEGACY_WORKER_PROTOCOL_VERSION;
}

function compareAdmissionOrder(left: MutationOutboxRecord, right: MutationOutboxRecord): number {
  if (left.sequence !== undefined && right.sequence !== undefined) return left.sequence - right.sequence;
  if (left.sequence !== undefined) return 1;
  if (right.sequence !== undefined) return -1;
  return left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId);
}

function parseArchivedRecord(value: unknown, mutationId: string): ArchivedMutationOutboxRecord {
  if (value === null || typeof value !== "object") throw corruptOutbox(mutationId);
  const archived = value as Partial<ArchivedMutationOutboxRecord>;
  const resolution = decodeFailureEnvelope(archived.resolution);
  if (archived.format !== "1667-mutation-outbox-archive" || archived.schemaVersion !== 1
    || archived.intent === undefined || parseRecord(archived.intent, mutationId).mutationId !== mutationId
    || typeof archived.resolvedAt !== "string" || !Number.isFinite(Date.parse(archived.resolvedAt))
    || resolution === null) {
    throw corruptOutbox(mutationId);
  }
  return {
    ...(archived as ArchivedMutationOutboxRecord),
    resolution
  };
}

function parseCancellationMarker(
  value: unknown,
  mutationId: string
): MutationOutboxCancellationMarker {
  if (value === null || typeof value !== "object") throw corruptOutbox(mutationId);
  const marker = value as Partial<MutationOutboxCancellationMarker>;
  if (marker.format !== "1667-mutation-outbox-cancellation"
    || marker.schemaVersion !== 1
    || marker.mutationId !== mutationId
    || typeof marker.cancelledAt !== "string"
    || !Number.isFinite(Date.parse(marker.cancelledAt))) {
    throw corruptOutbox(mutationId);
  }
  return marker as MutationOutboxCancellationMarker;
}

async function removeDurablyIfPresent(file: string, message: string): Promise<void> {
  try {
    requireDurableCommit(await unlinkDurable(file), message);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function validateMutationId(value: string): void {
  if (!LEGACY_MUTATION_ID_PATTERN.test(value) && !DURABLE_MUTATION_ID_PATTERN.test(value)) {
    throw new ServiceError(500, "Mutation outbox contains an invalid ID");
  }
}

function corruptOutbox(mutationId: string): ServiceError {
  return new ServiceError(500, `Mutation outbox record is corrupt: ${mutationId}`);
}
