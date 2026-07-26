import { rm } from "node:fs/promises";
import path from "node:path";
import {
  hashPreparedMutationRecord,
  hashStartedMutationRecord,
  parseMutationLedgerRecordBytes
} from "./mutation-ledger-codec.js";
import {
  formatMigrationLedgerSegments,
  MUTATION_LEDGER_DIRECTORY,
  userMutationLedgerSegments
} from "./mutation-ledger-paths.js";
import type {
  AcknowledgedMutationRecord,
  CompletedMutationRecord,
  Fm1Key,
  FormatMigrationReceiptRecord,
  Hash256,
  LogicalAggregateKey,
  MutationId,
  MutationLedgerRecord,
  PreparedInternalMutationRecord,
  PreparedRecord,
  StartedMutationRecord
} from "./mutation-ledger-types.js";
import { canonicalFormatMigrationReceiptRecord } from "./settings-format-migration-receipt.js";
import {
  readOptionalPrivateFiles,
} from "./private-file-publication.js";
import {
  LEDGER_RECORD_POLICY,
  RECORD_FILES,
  boundedReceiptEntries,
  canonicalStoryRecord,
  canonicalUserRecord,
  corruptReceipt,
  ensurePrivateDirectory,
  hash256Value,
  inspectPrivateDirectory,
  invalidUserRecord,
  isErrorCode,
  laterTimestamp,
  receiptExpired,
  receiptUnavailable,
  requireOnlyFormatMigrationEntry,
  requirePreparedStartedRelation,
  storyReceiptEntries,
  storyRecordKey,
  syncPrivateDirectory,
  writeImmutableRecord,
  type UserPreparedRecord,
  type UserReceiptRecord
} from "./mutation-ledger-store-support.js";

export interface UserMutationReceipt {
  readonly prepared: UserPreparedRecord | null;
  readonly completed: CompletedMutationRecord | null;
}
const EMPTY_RECEIPT: UserMutationReceipt = Object.freeze({ prepared: null, completed: null });

export interface StoryMutationReceipt extends UserMutationReceipt {
  readonly started: StartedMutationRecord | null;
  readonly acknowledged: AcknowledgedMutationRecord | null;
}
const EMPTY_STORY_RECEIPT: StoryMutationReceipt = Object.freeze({
  started: null,
  prepared: null,
  completed: null,
  acknowledged: null
});

export interface FormatMigrationReceipt {
  readonly prepared: PreparedInternalMutationRecord | null;
  readonly completed: CompletedMutationRecord | null;
}
const EMPTY_MIGRATION_RECEIPT: FormatMigrationReceipt = Object.freeze({
  prepared: null,
  completed: null
});

/**
 * Durable, direct-lookup storage for the ADR006 common receipt ledger.
 *
 * Release A uses only settings user receipts. The physical and record contract
 * remains aggregate-neutral so Q can add story records without a second store.
 */
export class MutationLedgerStore {
  private readonly root: string;

  constructor(private readonly dataDir: string) {
    this.root = path.join(dataDir, MUTATION_LEDGER_DIRECTORY);
  }

  async init(): Promise<void> {
    await ensurePrivateDirectory(this.dataDir, MUTATION_LEDGER_DIRECTORY);
  }

  async loadUserReceipt(
    aggregateKey: LogicalAggregateKey,
    mutationId: MutationId
  ): Promise<UserMutationReceipt> {
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) return EMPTY_RECEIPT;
    return await this.readUserReceipt(directory, aggregateKey, mutationId);
  }

  async loadFormatMigrationReceipt(key: Fm1Key): Promise<FormatMigrationReceipt> {
    const segments = formatMigrationLedgerSegments(key);
    const directory = await this.findLedgerDirectory(segments);
    if (directory === null) return EMPTY_MIGRATION_RECEIPT;
    const receipt = await this.readReceipt(directory, "settings", key);
    if (receipt.prepared !== null
      && receipt.prepared.method !== "migrateSettingsFormatV1") {
      throw corruptReceipt(key);
    }
    return receipt as FormatMigrationReceipt;
  }

  async loadStoryReceipt(
    aggregateKey: `story:${string}`,
    mutationId: MutationId
  ): Promise<StoryMutationReceipt> {
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) return EMPTY_STORY_RECEIPT;
    return await this.readStoryReceipt(directory, aggregateKey, mutationId);
  }

  async writeUserRecord(record: UserReceiptRecord): Promise<void> {
    const canonical = canonicalUserRecord(record);
    const { aggregateKey } = canonical.record;
    const mutationId = canonical.record.key as MutationId;
    const directory = this.userDirectory(aggregateKey, mutationId);
    if (canonical.record.kind === "completed") {
      if (await this.findUserDirectory(aggregateKey, mutationId) === null) {
        throw corruptReceipt(mutationId);
      }
      const existing = await this.readUserReceipt(directory, aggregateKey, mutationId);
      if (existing.prepared === null
        || hashPreparedMutationRecord(existing.prepared) !== canonical.record.preparedRecordHash) {
        throw corruptReceipt(mutationId);
      }
    } else {
      await this.ensureLedgerDirectory(userMutationLedgerSegments(aggregateKey, mutationId));
      await this.readUserReceipt(directory, aggregateKey, mutationId);
    }
    await writeImmutableRecord(directory, canonical.record, canonical.bytes);
  }

  async writeFormatMigrationRecord(record: FormatMigrationReceiptRecord): Promise<void> {
    let canonical: ReturnType<typeof canonicalFormatMigrationReceiptRecord>;
    try {
      canonical = canonicalFormatMigrationReceiptRecord(record);
    } catch (error) {
      throw invalidUserRecord(error);
    }
    const key = canonical.record.key;
    const segments = formatMigrationLedgerSegments(key);
    const directory = path.join(this.root, ...segments);
    if (canonical.record.kind === "completed") {
      const receipt = await this.loadFormatMigrationReceipt(key);
      if (receipt.prepared === null
        || hashPreparedMutationRecord(receipt.prepared) !== canonical.record.preparedRecordHash) {
        throw corruptReceipt(key);
      }
    } else {
      await this.ensureLedgerDirectory(segments);
      await this.readReceipt(directory, "settings", key);
    }
    await writeImmutableRecord(directory, canonical.record, canonical.bytes);
  }

  async writeStoryRecord(record: MutationLedgerRecord): Promise<void> {
    const canonical = canonicalStoryRecord(record);
    const aggregateKey = canonical.record.aggregateKey;
    const mutationId = storyRecordKey(canonical.record);
    const directory = this.userDirectory(aggregateKey, mutationId);

    if (canonical.record.kind === "completed") {
      const existing = await this.requireStoryReceipt(aggregateKey, mutationId);
      if (existing.prepared === null
        || hashPreparedMutationRecord(existing.prepared) !== canonical.record.preparedRecordHash) {
        throw corruptReceipt(mutationId);
      }
    } else if (canonical.record.kind === "acknowledged") {
      const existing = await this.requireStoryReceipt(aggregateKey, mutationId);
      if (existing.started === null
        || hashStartedMutationRecord(existing.started) !== canonical.record.startedRecordHash) {
        throw corruptReceipt(mutationId);
      }
      const acknowledgement = await this.requireStoryReceipt(
        aggregateKey,
        canonical.record.acknowledgementMutationId
      );
      if (acknowledgement.prepared?.purpose !== "provider-acknowledgement"
        || acknowledgement.prepared.originalProviderMutationId !== mutationId
        || hashPreparedMutationRecord(acknowledgement.prepared)
          !== canonical.record.acknowledgementPreparedHash) {
        throw corruptReceipt(mutationId);
      }
    } else {
      await this.ensureLedgerDirectory(userMutationLedgerSegments(aggregateKey, mutationId));
      const existing = await this.readStoryReceipt(directory, aggregateKey, mutationId);
      if (canonical.record.kind === "prepared") {
        requirePreparedStartedRelation(canonical.record, existing.started, mutationId);
      }
    }
    await writeImmutableRecord(directory, canonical.record, canonical.bytes);
    await this.readStoryReceipt(directory, aggregateKey, mutationId);
  }

  /**
   * Bounded recovery cleanup for an uncommitted prepared receipt. The exact
   * single-record directory and caller-provided prepared hash are revalidated;
   * terminal or additional evidence is never removed.
   */
  async removeOrphanPreparedUserReceipt(
    aggregateKey: LogicalAggregateKey,
    mutationId: MutationId,
    expectedPreparedHash: Hash256
  ): Promise<boolean> {
    const expectedHash = hash256Value(expectedPreparedHash);
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) return false;
    const receipt = await this.readUserReceipt(directory, aggregateKey, mutationId);
    if (receipt.prepared === null || receipt.completed !== null
      || hashPreparedMutationRecord(receipt.prepared) !== expectedHash) {
      throw corruptReceipt(mutationId);
    }
    const entries = await boundedReceiptEntries(directory, mutationId);
    if (entries.length !== 1 || entries[0] !== RECORD_FILES.prepared) {
      throw corruptReceipt(mutationId);
    }
    try {
      await inspectPrivateDirectory(directory);
      await rm(directory, { recursive: true, force: false, maxRetries: 0 });
      await syncPrivateDirectory(path.dirname(directory));
      return true;
    } catch (error) {
      throw receiptUnavailable(error);
    }
  }

  /** Recovery cleanup for a started receipt that was durably written but never
   * published into the aggregate. A started-only directory is the proof that
   * no prepared/completed/acknowledgement evidence can be lost. */
  async removeOrphanStartedStoryReceipt(
    aggregateKey: `story:${string}`,
    mutationId: MutationId,
    expectedStartedHash: Hash256
  ): Promise<boolean> {
    const expectedHash = hash256Value(expectedStartedHash);
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) return false;
    const receipt = await this.readStoryReceipt(directory, aggregateKey, mutationId);
    if (receipt.started === null || receipt.prepared !== null
      || receipt.completed !== null || receipt.acknowledged !== null
      || hashStartedMutationRecord(receipt.started) !== expectedHash) {
      throw corruptReceipt(mutationId);
    }
    const entries = await boundedReceiptEntries(directory, mutationId);
    if (entries.length !== 1 || entries[0] !== RECORD_FILES.started) {
      throw corruptReceipt(mutationId);
    }
    try {
      await inspectPrivateDirectory(directory);
      await rm(directory, { recursive: true, force: false, maxRetries: 0 });
      await syncPrivateDirectory(path.dirname(directory));
      return true;
    } catch (error) {
      throw receiptUnavailable(error);
    }
  }

  /**
   * Explicit direct collector for one completed settings/user receipt. Callers
   * must hold the aggregate scope; unseen or non-terminal evidence is retained.
   */
  async collectTerminalUserReceipt(
    aggregateKey: LogicalAggregateKey,
    mutationId: MutationId,
    nowMs: number,
    referencedMutationIds: ReadonlySet<MutationId>
  ): Promise<boolean> {
    if (referencedMutationIds.has(mutationId)) return false;
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) return false;
    const receipt = await this.readUserReceipt(
      directory,
      aggregateKey,
      mutationId
    );
    if (receipt.completed === null
      || !receiptExpired(receipt.completed.completedAt, nowMs)) {
      return false;
    }
    await this.removeCollectedReceipt(
      directory,
      mutationId,
      [RECORD_FILES.prepared, RECORD_FILES.completed]
    );
    return true;
  }

  /**
   * Explicit direct collector for one terminal story receipt. An ambiguous
   * provider start is never age-pruned. The original acknowledged provider
   * receipt is collected before its acknowledgement receipt so no retained
   * cross-record reference can dangle.
   */
  async collectTerminalStoryReceipt(
    aggregateKey: `story:${string}`,
    mutationId: MutationId,
    nowMs: number,
    referencedMutationIds: ReadonlySet<MutationId>
  ): Promise<boolean> {
    if (referencedMutationIds.has(mutationId)) return false;
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) return false;
    const receipt = await this.readStoryReceipt(
      directory,
      aggregateKey,
      mutationId
    );
    let terminalAt: string;
    if (receipt.acknowledged !== null) {
      const acknowledgement = await this.loadStoryReceipt(
        aggregateKey,
        receipt.acknowledged.acknowledgementMutationId
      );
      if (acknowledgement.prepared?.purpose !== "provider-acknowledgement"
        || acknowledgement.completed === null
        || acknowledgement.prepared.originalProviderMutationId !== mutationId
        || hashPreparedMutationRecord(acknowledgement.prepared)
          !== receipt.acknowledged.acknowledgementPreparedHash) {
        throw corruptReceipt(mutationId);
      }
      terminalAt = laterTimestamp(
        receipt.acknowledged.acknowledgedAt,
        acknowledgement.completed.completedAt
      );
    } else if (receipt.completed !== null) {
      if (receipt.prepared?.purpose === "provider-acknowledgement") {
        const original = await this.findUserDirectory(
          aggregateKey,
          receipt.prepared.originalProviderMutationId
        );
        if (original !== null) return false;
      }
      terminalAt = receipt.completed.completedAt;
    } else {
      return false;
    }
    if (!receiptExpired(terminalAt, nowMs)) return false;
    await this.removeCollectedReceipt(
      directory,
      mutationId,
      storyReceiptEntries(receipt)
    );
    return true;
  }

  private async readUserReceipt(
    directory: string,
    aggregateKey: LogicalAggregateKey,
    mutationId: MutationId
  ): Promise<UserMutationReceipt> {
    const receipt = await this.readReceipt(directory, aggregateKey, mutationId);
    if (receipt.prepared?.method === "migrateSettingsFormatV1") {
      throw corruptReceipt(mutationId);
    }
    return receipt as UserMutationReceipt;
  }

  private async readStoryReceipt(
    directory: string,
    aggregateKey: `story:${string}`,
    mutationId: MutationId
  ): Promise<StoryMutationReceipt> {
    const [started = null, prepared = null, completed = null, acknowledged = null] =
      await this.readOptionalRecords(
        directory,
        ["started", "prepared", "completed", "acknowledged"],
        aggregateKey,
        mutationId
      );
    if (started !== null && started.kind !== "started") throw corruptReceipt(mutationId);
    if (prepared !== null && prepared.kind !== "prepared") throw corruptReceipt(mutationId);
    if (completed !== null && completed.kind !== "completed") throw corruptReceipt(mutationId);
    if (acknowledged !== null && acknowledged.kind !== "acknowledged") {
      throw corruptReceipt(mutationId);
    }
    const parsedStarted = started as StartedMutationRecord | null;
    const parsedPrepared = prepared as UserPreparedRecord | null;
    const parsedCompleted = completed as CompletedMutationRecord | null;
    const parsedAcknowledged = acknowledged as AcknowledgedMutationRecord | null;
    if (parsedCompleted !== null && (parsedPrepared === null
      || hashPreparedMutationRecord(parsedPrepared) !== parsedCompleted.preparedRecordHash)) {
      throw corruptReceipt(mutationId);
    }
    if (parsedPrepared !== null) {
      requirePreparedStartedRelation(parsedPrepared, parsedStarted, mutationId);
    } else if (parsedStarted === null && parsedAcknowledged !== null) {
      throw corruptReceipt(mutationId);
    }
    if (parsedAcknowledged !== null && (parsedStarted === null
      || hashStartedMutationRecord(parsedStarted) !== parsedAcknowledged.startedRecordHash)) {
      throw corruptReceipt(mutationId);
    }
    return Object.freeze({
      started: parsedStarted,
      prepared: parsedPrepared,
      completed: parsedCompleted,
      acknowledged: parsedAcknowledged
    });
  }

  private async requireStoryReceipt(
    aggregateKey: `story:${string}`,
    mutationId: MutationId
  ): Promise<StoryMutationReceipt> {
    const directory = await this.findUserDirectory(aggregateKey, mutationId);
    if (directory === null) throw corruptReceipt(mutationId);
    return await this.readStoryReceipt(directory, aggregateKey, mutationId);
  }

  private async readReceipt(
    directory: string,
    aggregateKey: LogicalAggregateKey,
    expectedKey: string
  ): Promise<Readonly<{ prepared: PreparedRecord | null; completed: CompletedMutationRecord | null }>> {
    const [prepared = null, completed = null] = await this.readOptionalRecords(
      directory,
      ["prepared", "completed"],
      aggregateKey,
      expectedKey
    );
    if (prepared !== null && prepared.kind !== "prepared") {
      throw corruptReceipt(expectedKey);
    }
    if (completed !== null && completed.kind !== "completed") {
      throw corruptReceipt(expectedKey);
    }
    if (completed !== null && prepared === null) {
      throw corruptReceipt(expectedKey);
    }
    const parsedPrepared = prepared as PreparedRecord | null;
    const parsedCompleted = completed as CompletedMutationRecord | null;
    if (parsedPrepared !== null && parsedCompleted !== null
      && hashPreparedMutationRecord(parsedPrepared) !== parsedCompleted.preparedRecordHash) {
      throw corruptReceipt(expectedKey);
    }
    return Object.freeze({ prepared: parsedPrepared, completed: parsedCompleted });
  }

  private userDirectory(aggregateKey: LogicalAggregateKey, mutationId: MutationId): string {
    return path.join(this.root, ...userMutationLedgerSegments(aggregateKey, mutationId));
  }

  private async ensureLedgerDirectory(segments: readonly string[]): Promise<void> {
    await ensurePrivateDirectory(this.dataDir, MUTATION_LEDGER_DIRECTORY);
    let parent = this.root;
    for (const [index, segment] of segments.entries()) {
      const internalReceipt = segments.length === 3 && index === 2;
      if (internalReceipt) await requireOnlyFormatMigrationEntry(parent, segment, true);
      await ensurePrivateDirectory(parent, segment);
      if (internalReceipt) await requireOnlyFormatMigrationEntry(parent, segment, false);
      parent = path.join(parent, segment);
    }
  }

  private async findUserDirectory(
    aggregateKey: LogicalAggregateKey,
    mutationId: MutationId
  ): Promise<string | null> {
    return await this.findLedgerDirectory(userMutationLedgerSegments(aggregateKey, mutationId));
  }

  private async findLedgerDirectory(segments: readonly string[]): Promise<string | null> {
    const directories = [this.root];
    let directory = this.root;
    for (const segment of segments) {
      directory = path.join(directory, segment);
      directories.push(directory);
    }
    const inspected = await Promise.allSettled(
      directories.map(async (candidate) =>
        await inspectPrivateDirectory(candidate)
      )
    );
    let missing = false;
    for (const result of inspected) {
      if (result.status === "fulfilled") continue;
      if (isErrorCode(result.reason, "ENOENT")) {
        missing = true;
      } else {
        throw receiptUnavailable(result.reason);
      }
    }
    return missing ? null : directory;
  }

  private async readOptionalRecords(
    directory: string,
    kinds: readonly (keyof typeof RECORD_FILES)[],
    aggregateKey: LogicalAggregateKey,
    expectedKey: string
  ): Promise<readonly (MutationLedgerRecord | null)[]> {
    let records: readonly (Buffer | null)[];
    try {
      records = await readOptionalPrivateFiles(
        kinds.map((kind) => path.join(directory, RECORD_FILES[kind])),
        LEDGER_RECORD_POLICY
      );
    } catch (error) {
      throw corruptReceipt(expectedKey, error);
    }
    return records.map((bytes, index) => {
      if (bytes === null) return null;
      const kind = kinds[index]!;
      let record: MutationLedgerRecord;
      try {
        record = parseMutationLedgerRecordBytes(bytes);
      } catch (error) {
        throw corruptReceipt(expectedKey, error);
      }
      const key = "key" in record ? record.key : record.mutationId;
      if (record.kind !== kind
        || record.aggregateKey !== aggregateKey
        || key !== expectedKey) {
        throw corruptReceipt(expectedKey);
      }
      return record;
    });
  }

  private async removeCollectedReceipt(
    directory: string,
    mutationId: MutationId,
    expectedEntries: readonly string[]
  ): Promise<void> {
    const entries = await boundedReceiptEntries(directory, mutationId);
    const expected = [...expectedEntries].sort();
    if (entries.length !== expected.length
      || entries.some((entry, index) => entry !== expected[index])) {
      throw corruptReceipt(mutationId);
    }
    try {
      await inspectPrivateDirectory(directory);
      await rm(directory, { recursive: true, force: false, maxRetries: 0 });
      await syncPrivateDirectory(path.dirname(directory));
    } catch (error) {
      throw receiptUnavailable(error);
    }
  }
}
