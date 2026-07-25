import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-format.js";
import { ServiceError } from "../server/errors.js";
import { MUTATION_LEDGER_DIRECTORY, userMutationLedgerSegments } from "../server/mutation-ledger-paths.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import type {
  LogicalAggregateKey,
  MutationId,
  PreparedUserMutationRecord
} from "../server/mutation-ledger-types.js";
import { hashSettingsStateV2 } from "../server/settings-v2-codec.js";
import {
  applyEffectiveGenerationSettings,
  effectiveGenerationSettings
} from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_STATE_V2
} from "../server/settings-v2-default.js";
import { reduceSettingsStateV2 } from "../server/settings-v2-reducer.js";
import type {
  SaveSettingsCommand,
  SettingsDocumentV2,
  SettingsStateV2
} from "../shared/settings-v2-types.js";

export const MUTATION_A = `m1.1767225600000.${"a".repeat(32)}` as MutationId;
export const MUTATION_B = `m1.1767225600001.${"b".repeat(32)}` as MutationId;
export const MUTATION_C = `m1.1767225600002.${"c".repeat(32)}` as MutationId;
export const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

export async function initializedFormat2Directory(
  t: TestContext,
  prefix: string
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  t.after(async () => {
    await lock.release();
    await rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

export function writingDocument(brief: string): SettingsDocumentV2 {
  return {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    writing: { defaultAuthorBrief: brief }
  };
}

export function credentialedDocument(environmentName: string): SettingsDocumentV2 {
  return applyEffectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...effectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "test-model",
    apiKeyEnv: environmentName
  });
}

export function saveCommand(
  mutationId: MutationId,
  expectedStateGeneration: number,
  document: SettingsDocumentV2,
  transportOperationId = `transport:${mutationId}`
): SaveSettingsCommand {
  return { transportOperationId, mutationId, expectedStateGeneration, document };
}

export function changedState(
  mutationId: MutationId,
  document: SettingsDocumentV2
): SettingsStateV2 {
  return reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
    kind: "save-document",
    document,
    lastTransaction: {
      receiptKind: "user",
      mutationId,
      phase: "prepared"
    }
  });
}

export function preparedFixture(
  mutationId: MutationId,
  current: SettingsStateV2,
  next: SettingsStateV2,
  fingerprintHash = "f".repeat(64)
): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key: mutationId,
    fingerprintHash,
    method: "saveSettings",
    oldStateHash: hashSettingsStateV2(current),
    newStateHash: hashSettingsStateV2(next),
    startedRecordHash: null,
    result: {
      kind: "settings",
      settingsStateGeneration: next.stateGeneration,
      activeSettingsRevision: next.activeRevision,
      pendingSettingsRevision: next.pendingRevision
    },
    preparedAt: FIXED_TIME.toISOString()
  };
}

export async function transactionBytes(
  dataDir: string,
  mutationId: MutationId
): Promise<readonly string[]> {
  const receiptDirectory = path.join(
    dataDir,
    MUTATION_LEDGER_DIRECTORY,
    ...userMutationLedgerSegments("settings", mutationId)
  );
  return await Promise.all([
    readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "utf8"),
    readFile(path.join(receiptDirectory, "prepared.json"), "utf8"),
    readFile(path.join(receiptDirectory, "completed.json"), "utf8")
  ]);
}

export class BlockingLookupLedger extends MutationLedgerStore {
  private blocked = false;
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  private readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });
  private readonly release = new Promise<void>((resolve) => { this.releaseResolve = resolve; });

  override async loadUserReceipt(
    aggregateKey: LogicalAggregateKey,
    mutationId: MutationId
  ) {
    if (!this.blocked) {
      this.blocked = true;
      this.enteredResolve();
      await this.release;
    }
    return await super.loadUserReceipt(aggregateKey, mutationId);
  }

  async waitUntilBlocked(): Promise<void> {
    await this.entered;
  }

  unblock(): void {
    this.releaseResolve();
  }
}

export function hasServiceCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

export function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}
