import type { Stats } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, decodeCanonicalUtf8, encodeUtf8Strict } from "./canonical-json.js";
import {
  hashPreparedMutationRecord,
  hashStartedMutationRecord,
  parseMutationLedgerRecordBytes
} from "./mutation-ledger-codec.js";
import {
  formatMigrationLedgerSegments,
  MUTATION_LEDGER_DIRECTORY,
  storyLedgerToken,
  userMutationLedgerSegments
} from "./mutation-ledger-paths.js";
import {
  requireMutationId,
  requireHash256,
  requireLogicalAggregateKey,
  storyIdFromAggregateKey
} from "./mutation-ledger-scalars.js";
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
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  readOptionalPrivateFiles,
  removePrivateFile,
  type PrivateFilePolicy
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

interface ClearRecoveryCandidate {
  readonly schema: 1;
  readonly kind: "clear-recovery-candidate";
  readonly aggregateKey: `story:${string}`;
  readonly mutationId: MutationId;
  readonly preparedRecordHash: Hash256;
}

const CLEAR_RECOVERY_CANDIDATE_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Aside Clear recovery candidate",
  maxBytes: 1024
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
 * Durable, direct-lookup storage for the common receipt ledger.
 *
 * Release A uses only settings user receipts. The physical and record contract
 * remains aggregate-neutral so Q can add story records without a second store.
 */
export class MutationLedgerStore {
  private readonly root: string;
  /** Non-leaf ledger directories this instance already proved durable, keyed
   * by pathname and holding the proven device/inode identity. The map elides
   * only the redundant parent durability flush, and only while the directory
   * at that pathname is the exact one proven earlier: the privacy and
   * identity inspections still run on every write, so a swapped ancestor
   * fails closed and a replaced directory — even a valid private one — is
   * flushed like a new one. Per-record leaf directories never enter the map:
   * recovery and collection remove them, and excluding them bounds the map
   * to the shared hierarchy instead of one retained path per mutation.
   *
   * Trust boundary: the identity-keyed proof assumes the single-writer
   * invariant of the locked data directory. It does not defend against an
   * external process re-binding pathnames between writes — for example
   * renaming a proven directory away and back around its own flush — which
   * is outside the ledger's threat model. */
  private readonly durableDirectories = new Map<string, Stats>();

  constructor(private readonly dataDir: string) {
    this.root = path.join(dataDir, MUTATION_LEDGER_DIRECTORY);
  }

  async init(): Promise<void> {
    await this.ensureDurableDirectory(this.dataDir, MUTATION_LEDGER_DIRECTORY);
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
      await this.ensureLedgerDirectory(userMutationLedgerSegments(aggregateKey, mutationId), "user");
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
      await this.ensureLedgerDirectory(segments, "format-migration");
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
      await this.ensureLedgerDirectory(userMutationLedgerSegments(aggregateKey, mutationId), "user");
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
   * prepared record and caller-provided hash are revalidated. A story receipt
   * may retain its related started record; terminal or unrelated evidence is
   * never removed.
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
    const hasOnlyPrepared = entries.length === 1 && entries[0] === RECORD_FILES.prepared;
    const hasPreparedAndStarted = aggregateKey.startsWith("story:")
      && entries.length === 2
      && entries.includes(RECORD_FILES.prepared)
      && entries.includes(RECORD_FILES.started);
    if (!hasOnlyPrepared && !hasPreparedAndStarted) {
      throw corruptReceipt(mutationId);
    }
    try {
      await inspectPrivateDirectory(directory);
      if (hasPreparedAndStarted) {
        await unlink(path.join(directory, RECORD_FILES.prepared));
        await syncPrivateDirectory(directory);
        return true;
      }
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
   * Recover the one indexed Clear candidate for this story. The caller holds
   * the story lock and supplies every aggregate or staged pointer that can
   * still own the candidate. No historical receipt directory is scanned.
   */
  async recoverIndexedClearPreparedStoryReceipt(
    aggregateKey: `story:${string}`,
    referencedMutationIds: ReadonlySet<MutationId>,
    stagedMutationId: MutationId | null = null,
    currentMutationId: MutationId | null = null
  ): Promise<MutationId | null> {
    const candidate = await this.readClearRecoveryCandidate(aggregateKey);
    if (candidate === null) return null;
    const receipt = await this.loadStoryReceipt(aggregateKey, candidate.mutationId);
    const hasReceiptEvidence = receipt.started !== null
      || receipt.prepared !== null
      || receipt.completed !== null
      || receipt.acknowledged !== null;
    const hasAggregateEvidence = referencedMutationIds.has(candidate.mutationId);
    const hasStageEvidence = stagedMutationId === candidate.mutationId;
    if (currentMutationId === candidate.mutationId
      && !hasReceiptEvidence && !hasAggregateEvidence && !hasStageEvidence) {
      // A process can die after the candidate index write and before the
      // prepared receipt write. The exact retry owns no durable evidence;
      // remove this unowned marker before the retry writes a new candidate.
      await this.removeClearRecoveryCandidate(
        aggregateKey,
        candidate.mutationId,
        candidate.preparedRecordHash
      );
      return null;
    }
    if (hasAggregateEvidence || hasStageEvidence) return null;
    const prepared = receipt.prepared;
    if (prepared === null) {
      await this.removeClearRecoveryCandidate(
        aggregateKey,
        candidate.mutationId,
        candidate.preparedRecordHash
      );
      return null;
    }
    if (receipt.completed !== null) {
      if (receipt.started !== null || receipt.acknowledged !== null
        || prepared.purpose !== "mutation"
        || prepared.method !== "clearAside"
        || prepared.aggregateKey !== aggregateKey
        || prepared.key !== candidate.mutationId
        || prepared.startedRecordHash !== null
        || hashPreparedMutationRecord(prepared) !== candidate.preparedRecordHash
        || receipt.completed.preparedRecordHash !== candidate.preparedRecordHash) {
        throw corruptReceipt(candidate.mutationId);
      }
      await this.removeClearRecoveryCandidate(
        aggregateKey,
        candidate.mutationId,
        candidate.preparedRecordHash
      );
      return null;
    }
    if (receipt.started !== null || receipt.completed !== null || receipt.acknowledged !== null
      || prepared.purpose !== "mutation"
      || prepared.method !== "clearAside"
      || prepared.aggregateKey !== aggregateKey
      || prepared.key !== candidate.mutationId
      || prepared.startedRecordHash !== null
      || hashPreparedMutationRecord(prepared) !== candidate.preparedRecordHash) {
      throw corruptReceipt(candidate.mutationId);
    }
    if (currentMutationId === candidate.mutationId) {
      // The exact retry removes its prepared-only orphan after this lookup.
      // Keep the candidate after this path revalidates the receipt hash.
      return null;
    }
    await this.removeOrphanPreparedUserReceipt(
      aggregateKey,
      candidate.mutationId,
      candidate.preparedRecordHash
    );
    await this.removeClearRecoveryCandidate(
      aggregateKey,
      candidate.mutationId,
      candidate.preparedRecordHash
    );
    return candidate.mutationId;
  }

  /** Durable index entry for the prepared-before-stage Clear window. */
  async writeClearRecoveryCandidate(
    aggregateKey: `story:${string}`,
    mutationId: MutationId,
    preparedRecordHash: Hash256
  ): Promise<void> {
    const candidate = this.clearRecoveryCandidate(
      aggregateKey,
      mutationId,
      preparedRecordHash
    );
    const directory = this.clearRecoveryDirectory(aggregateKey);
    const storyId = storyIdFromAggregateKey(aggregateKey);
    if (storyId === null) throw corruptReceipt("clear-recovery");
    await this.ensureLedgerDirectory(
      ["stories", storyLedgerToken(storyId), "clear-recovery"],
      "user"
    );
    const file = path.join(directory, "candidate.json");
    const existing = await readOptionalPrivateFile(file, CLEAR_RECOVERY_CANDIDATE_POLICY);
    if (existing !== null) {
      const current = this.parseClearRecoveryCandidate(existing, aggregateKey);
      if (current.mutationId === candidate.mutationId
        && current.preparedRecordHash === candidate.preparedRecordHash) {
        return;
      }
      throw corruptReceipt(current.mutationId);
    }
    await publishPrivateFileNoReplace(
      file,
      encodeUtf8Strict(canonicalJson(candidate), "Aside Clear recovery candidate"),
      CLEAR_RECOVERY_CANDIDATE_POLICY
    );
  }

  /** Remove an indexed candidate after its exact receipt is gone or terminal. */
  async removeClearRecoveryCandidate(
    aggregateKey: `story:${string}`,
    mutationId: MutationId,
    preparedRecordHash: Hash256
  ): Promise<boolean> {
    const candidate = await this.readClearRecoveryCandidate(aggregateKey);
    if (candidate === null) return false;
    if (candidate.mutationId !== mutationId
      || candidate.preparedRecordHash !== preparedRecordHash) {
      throw corruptReceipt(mutationId);
    }
    await removePrivateFile(
      path.join(this.clearRecoveryDirectory(aggregateKey), "candidate.json"),
      CLEAR_RECOVERY_CANDIDATE_POLICY
    );
    return true;
  }

  /** Remove a candidate only when it still belongs to this Clear.
   *
   * A receipt for an older Clear can be finalized after a later no-op Clear
   * has installed the one per-story candidate. The later candidate is valid
   * evidence and must remain available for its exact replay. */
  async removeClearRecoveryCandidateIfMatches(
    aggregateKey: `story:${string}`,
    mutationId: MutationId,
    preparedRecordHash: Hash256
  ): Promise<boolean> {
    const candidate = await this.readClearRecoveryCandidate(aggregateKey);
    if (candidate === null) return false;
    if (candidate.mutationId !== mutationId
      || candidate.preparedRecordHash !== preparedRecordHash) {
      return false;
    }
    return await this.removeClearRecoveryCandidate(
      aggregateKey,
      mutationId,
      preparedRecordHash
    );
  }

  /** Collect one expired completed settings/user receipt under the aggregate lock. */
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

  private clearRecoveryDirectory(aggregateKey: `story:${string}`): string {
    const storyId = storyIdFromAggregateKey(aggregateKey);
    if (storyId === null) throw corruptReceipt("clear-recovery");
    return path.join(this.root, "stories", storyLedgerToken(storyId), "clear-recovery");
  }

  private clearRecoveryCandidate(
    aggregateKey: `story:${string}`,
    mutationId: MutationId,
    preparedRecordHash: Hash256
  ): ClearRecoveryCandidate {
    requireMutationId(mutationId);
    requireHash256(preparedRecordHash, "preparedRecordHash");
    return {
      schema: 1,
      kind: "clear-recovery-candidate",
      aggregateKey,
      mutationId,
      preparedRecordHash
    };
  }

  private async readClearRecoveryCandidate(
    aggregateKey: `story:${string}`
  ): Promise<ClearRecoveryCandidate | null> {
    const directory = this.clearRecoveryDirectory(aggregateKey);
    const bytes = await readOptionalPrivateFile(
      path.join(directory, "candidate.json"),
      CLEAR_RECOVERY_CANDIDATE_POLICY
    );
    if (bytes !== null) {
      const entries = await boundedReceiptEntries(directory, "clear-recovery");
      if (entries.length !== 1 || entries[0] !== "candidate.json") {
        throw corruptReceipt("clear-recovery");
      }
    }
    return bytes === null ? null : this.parseClearRecoveryCandidate(bytes, aggregateKey);
  }

  private parseClearRecoveryCandidate(
    bytes: Uint8Array,
    aggregateKey: `story:${string}`
  ): ClearRecoveryCandidate {
    try {
      const text = decodeCanonicalUtf8(bytes, "Aside Clear recovery candidate");
      const value: unknown = JSON.parse(text);
      if (canonicalJson(value) !== text
        || value === null
        || typeof value !== "object"
        || Array.isArray(value)) {
        throw new Error("Aside Clear recovery candidate is not canonical JSON");
      }
      const root = value as Record<string, unknown>;
      const keys = Object.keys(root).sort();
      if (keys.length !== 5
        || keys.join("\0") !== ["aggregateKey", "kind", "mutationId", "preparedRecordHash", "schema"].join("\0")
        || root.schema !== 1
        || root.kind !== "clear-recovery-candidate") {
        throw new Error("Aside Clear recovery candidate shape is invalid");
      }
      const parsedAggregate = requireLogicalAggregateKey(root.aggregateKey);
      const parsedMutationId = requireMutationId(root.mutationId);
      const parsedHash = requireHash256(root.preparedRecordHash, "preparedRecordHash");
      if (parsedAggregate !== aggregateKey || !parsedAggregate.startsWith("story:")) {
        throw new Error("Aside Clear recovery candidate aggregate is invalid");
      }
      return {
        schema: 1,
        kind: "clear-recovery-candidate",
        aggregateKey: parsedAggregate,
        mutationId: parsedMutationId,
        preparedRecordHash: parsedHash
      };
    } catch (error) {
      throw corruptReceipt("clear-recovery", error);
    }
  }

  private userDirectory(aggregateKey: LogicalAggregateKey, mutationId: MutationId): string {
    return path.join(this.root, ...userMutationLedgerSegments(aggregateKey, mutationId));
  }

  private async ensureLedgerDirectory(
    segments: readonly string[],
    kind: "user" | "format-migration"
  ): Promise<void> {
    await this.ensureDurableDirectory(this.dataDir, MUTATION_LEDGER_DIRECTORY);
    let parent = this.root;
    for (const [index, segment] of segments.entries()) {
      if (index < segments.length - 1) {
        await this.ensureDurableDirectory(parent, segment);
      } else if (kind === "format-migration") {
        // The single-receipt fence must re-run on every write.
        await requireOnlyFormatMigrationEntry(parent, segment, true);
        await ensurePrivateDirectory(parent, segment);
        await requireOnlyFormatMigrationEntry(parent, segment, false);
      } else {
        await ensurePrivateDirectory(parent, segment);
      }
      parent = path.join(parent, segment);
    }
  }

  private async ensureDurableDirectory(parent: string, name: string): Promise<void> {
    const target = path.join(parent, name);
    const identity = await ensurePrivateDirectory(
      parent,
      name,
      this.durableDirectories.get(target)
    );
    this.durableDirectories.set(target, identity);
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
