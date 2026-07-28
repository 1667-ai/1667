import type { WorkerMethod } from "../../shared/worker-protocol.js";
import type {
  ArchivedMutationOutboxRecord,
  MutationOutbox,
  MutationOutboxRecord
} from "../../server/mutation-outbox.js";
import type { SerializedWorkerOutbox } from "./worker-outbox.js";

export interface RecoveryWarning<E extends Error> {
  mutationId: string;
  method: WorkerMethod;
  storyId: string | null;
  resolution: "archived" | "cleared";
  error: E;
}

export async function loadWorkerRecoveryOutbox(
  outbox: SerializedWorkerOutbox,
  store: MutationOutbox
): Promise<{
  recoveryRecords: MutationOutboxRecord[];
  archivedRecords: ArchivedMutationOutboxRecord[];
}> {
  for (const mutationId of await outbox.run(() => store.listCancellationMarkers())) {
    await outbox.run(() => store.remove(mutationId));
  }
  const [records, archivedRecords] = await Promise.all([
    outbox.run(() => store.list()),
    outbox.run(() => store.listArchived())
  ]);
  const cancelledRecords = records.filter((record) => record.cancelledAt !== undefined);
  for (const record of cancelledRecords) {
    await outbox.run(() => store.remove(record.mutationId));
  }
  return {
    recoveryRecords: records.filter((record) => record.cancelledAt === undefined),
    archivedRecords
  };
}

/** Runs the immutable startup outbox snapshot without blocking worker readiness. */
export class OutboxRecoveryCoordinator<E extends Error> {
  readonly warnings: RecoveryWarning<E>[] = [];
  recovery: Promise<readonly RecoveryWarning<E>[]> = Promise.resolve(this.warnings);
  private active = false;
  private readonly records = new Map<string, MutationOutboxRecord>();

  constructor(
    private readonly replay: (record: MutationOutboxRecord) => Promise<void>,
    private readonly onWarning: (
      warnings: readonly RecoveryWarning<E>[]
    ) => void = () => undefined
  ) {}

  get blocksMutations(): boolean { return this.active; }

  start(records: readonly MutationOutboxRecord[]): void {
    if (records.length === 0) return;
    records.forEach((record) => this.records.set(record.mutationId, record));
    this.active = true;
    this.recovery = this.run(records)
      .then(() => {
        this.active = false;
        return this.warnings;
      });
    void this.recovery.catch(() => undefined);
  }

  warn(warning: RecoveryWarning<E>): void {
    this.warnings.push(warning);
    try {
      this.onWarning([warning]);
    } catch {
      // The warning remains available for the next recovery publication.
    }
  }

  dismissWarning(mutationId: string): void {
    const index = this.warnings.findIndex(
      (warning) => warning.mutationId === mutationId
    );
    if (index >= 0) this.warnings.splice(index, 1);
  }

  recordFor(mutationId: string): MutationOutboxRecord | null {
    return this.records.get(mutationId) ?? null;
  }

  private async run(records: readonly MutationOutboxRecord[]): Promise<void> {
    for (const record of records) await this.replay(record);
  }
}
