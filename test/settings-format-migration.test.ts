import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT,
  SETTINGS_STATE_V2_FILE,
  dataDirectoryOwnerMarkerText,
  readDataDirectoryFormat
} from "../server/data-directory-format.js";
import { ServiceError } from "../server/errors.js";
import { hashPreparedMutationRecord } from "../server/mutation-ledger-codec.js";
import { MUTATION_LEDGER_DIRECTORY } from "../server/mutation-ledger-paths.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import {
  settingsFormatMigrationV1Identity
} from "../server/settings-format-migration-identity.js";
import type {
  SettingsFormatMigrationV1Hooks
} from "../server/settings-format-migration.js";
import {
  ABSENT_SETTINGS_V1,
  formatGenerationSettingsV1
} from "../server/settings-v1-codec.js";
import {
  loadGenerationSettingsV1Source
} from "../server/settings-v1-store.js";
import { StoryService } from "../server/story-service.js";
import {
  hashSettingsStateV2
} from "../server/settings-v2-codec.js";
import {
  convertGenerationSettingsV1
} from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import { readSettingsState } from "../server/settings-state-file.js";
import type { GenerationSettings } from "../shared/types.js";

const FILE_SETTINGS: GenerationSettings = {
  provider: "openai-compatible",
  baseUrl: "https://example.test/v1",
  model: "fiction-model",
  apiKeyEnv: "AI_1667_TEST_KEY",
  temperature: 0.65,
  maxTokens: 2048,
  systemPrompt: "Continue in the established voice.",
  contextWindow: 32768
};
const CHANGED_SETTINGS: GenerationSettings = {
  ...FILE_SETTINGS,
  model: "changed-model",
  systemPrompt: "This source changed after preparation."
};
const FIXED_TIME = new Date("2026-07-23T12:00:00.000Z");
const CRASH_HOOKS = [
  "afterSourceRecovery",
  "afterStateStaged",
  "afterPreparedReceipt",
  "afterStatePublished",
  "afterCompletedReceipt",
  "afterMarkerStaged",
  "afterMarkerPublished"
] as const satisfies readonly (keyof SettingsFormatMigrationV1Hooks)[];

test("Release B migrates a canonical file-present format-1 directory exactly once", async (t) => {
  const dataDir = await format1Directory(t, "1667-settings-migrate-file-", FILE_SETTINGS);
  const originalBytes = await readFile(path.join(dataDir, "settings.json"));
  const lock = new DataDirectoryLock(dataDir);

  await lock.acquire();
  assert.equal(lock.dataFormat, 1);
  assert.equal(await lock.migrateSettingsFormat({ now: () => FIXED_TIME }), 2);
  assert.equal(await lock.migrateSettingsFormat({ now: () => FIXED_TIME }), 2);
  await lock.release();

  await assertConvergedMigration(dataDir, FILE_SETTINGS, "file");
  assert.deepEqual(
    await readFile(path.join(dataDir, "settings.json")),
    originalBytes,
    "the v1 rollback source remains byte-for-byte intact"
  );
});

test("Release B materializes the frozen absent-default vector without a v1 file", async (t) => {
  const dataDir = await format1Directory(t, "1667-settings-migrate-absent-");
  const lock = new DataDirectoryLock(dataDir);

  await lock.acquire();
  assert.equal(await lock.migrateSettingsFormat({ now: () => FIXED_TIME }), 2);
  await lock.release();

  await assertConvergedMigration(dataDir, ABSENT_SETTINGS_V1, "absent-default");
  await assertMissing(path.join(dataDir, "settings.json"));
  await assertMissing(path.join(dataDir, "settings.json.next"));
});

test("malformed v1 fails closed before state, receipt, or marker activation", async (t) => {
  const dataDir = await format1Directory(t, "1667-settings-migrate-malformed-");
  await privateWrite(path.join(dataDir, "settings.json"), "{\"provider\":\"dry-run\"");
  const lock = new DataDirectoryLock(dataDir);

  await lock.acquire();
  try {
    await assert.rejects(lock.migrateSettingsFormat(), /malformed or unsafe/);
  } finally {
    await lock.release();
  }

  assert.equal(await readDataDirectoryFormat(dataDir), 1);
  assert.equal(
    await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
    dataDirectoryOwnerMarkerText(1)
  );
  await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_FILE));
  await assertMissing(path.join(dataDir, MUTATION_LEDGER_DIRECTORY));
});

test("legacy-preview ownership remains format 1 and never starts Release B", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-migrate-preview-");
  await privateWrite(
    path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER),
    LEGACY_PREVIEW_DATA_MARKER_TEXT
  );
  await privateWrite(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1(FILE_SETTINGS)
  );
  const lock = new DataDirectoryLock(dataDir);

  await lock.acquire();
  assert.equal(lock.dataFormatSource, "legacy-preview");
  assert.equal(await lock.migrateSettingsFormat(), 1);
  await lock.release();

  assert.equal(await readDataDirectoryFormat(dataDir), 1);
  await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER));
  await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_FILE));
  await assertMissing(path.join(dataDir, MUTATION_LEDGER_DIRECTORY));
});

test("every Release B crash boundary converges under a fresh lock", {
  timeout: 60_000
}, async (t) => {
  for (const hookName of CRASH_HOOKS) {
    await t.test(hookName, async (subtest) => {
      const dataDir = await format1Directory(
        subtest,
        `1667-settings-migrate-crash-${hookName}-`,
        FILE_SETTINGS
      );
      const injected = new Error(`injected crash at ${hookName}`);
      const first = new DataDirectoryLock(dataDir);
      await first.acquire();
      try {
        const hooks = {
          [hookName]: () => {
            throw injected;
          }
        } as SettingsFormatMigrationV1Hooks;
        await assert.rejects(
          first.migrateSettingsFormat({ hooks, now: () => FIXED_TIME }),
          (error: unknown) => error === injected
        );
      } finally {
        await first.release();
      }

      const recovery = new DataDirectoryLock(dataDir);
      await recovery.acquire();
      try {
        assert.equal(
          await recovery.migrateSettingsFormat({ now: () => FIXED_TIME }),
          2
        );
      } finally {
        await recovery.release();
      }
      await assertConvergedMigration(dataDir, FILE_SETTINGS, "file");
    });
  }
});

test("directory replacement during migration fails before writing the replacement", {
  skip: process.platform === "win32"
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-settings-migrate-retarget-");
  const dataDir = path.join(parent, "data");
  const displaced = path.join(parent, "displaced");
  const replacement = path.join(parent, "replacement");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(replacement, { mode: 0o700 });
  const initializer = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await initializer.acquire();
  await initializer.release();
  await privateWrite(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1(FILE_SETTINGS)
  );

  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  try {
    await assert.rejects(
      lock.migrateSettingsFormat({
        hooks: {
          afterStateStaged: async () => {
            await rename(dataDir, displaced);
            await rename(replacement, dataDir);
          }
        }
      }),
      /file identity changed/
    );
  } finally {
    await lock.release();
  }

  assert.equal(await readDataDirectoryFormat(displaced), 1);
  await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_FILE));
  await assertMissing(path.join(dataDir, MUTATION_LEDGER_DIRECTORY));
  await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER));
});

test("changed v1 input after preparation is an idempotency conflict", async (t) => {
  const dataDir = await format1Directory(
    t,
    "1667-settings-migrate-changed-",
    FILE_SETTINGS
  );
  const originalSource = await loadGenerationSettingsV1Source(dataDir);
  const originalIdentity = settingsFormatMigrationV1Identity(
    originalSource.sourceTag,
    originalSource.canonicalV1Hash
  );
  const injected = new Error("stop after preparation");
  const first = new DataDirectoryLock(dataDir);
  await first.acquire();
  try {
    await assert.rejects(
      first.migrateSettingsFormat({
        now: () => FIXED_TIME,
        hooks: {
          afterPreparedReceipt: () => {
            throw injected;
          }
        }
      }),
      (error: unknown) => error === injected
    );
  } finally {
    await first.release();
  }
  await privateWrite(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1(CHANGED_SETTINGS)
  );

  const recovery = new DataDirectoryLock(dataDir);
  await recovery.acquire();
  try {
    await assert.rejects(
      recovery.migrateSettingsFormat({ now: () => FIXED_TIME }),
      hasServiceCode("idempotency_conflict")
    );
  } finally {
    await recovery.release();
  }

  assert.equal(await readDataDirectoryFormat(dataDir), 1);
  const originalReceipt = await new MutationLedgerStore(dataDir)
    .loadFormatMigrationReceipt(originalIdentity.key);
  assert.notEqual(originalReceipt.prepared, null);
  assert.equal(originalReceipt.completed, null);
});

test("a wrong preexisting v2 state blocks migration without allocating a receipt", async (t) => {
  const dataDir = await format1Directory(
    t,
    "1667-settings-migrate-wrong-state-",
    FILE_SETTINGS
  );
  await privateWrite(path.join(dataDir, SETTINGS_STATE_V2_FILE), INITIAL_SETTINGS_STATE_V2_TEXT);
  const lock = new DataDirectoryLock(dataDir);

  await lock.acquire();
  try {
    await assert.rejects(
      lock.migrateSettingsFormat({ now: () => FIXED_TIME }),
      hasServiceCode("idempotency_conflict")
    );
  } finally {
    await lock.release();
  }

  assert.equal(await readDataDirectoryFormat(dataDir), 1);
  assert.equal(
    await readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "utf8"),
    INITIAL_SETTINGS_STATE_V2_TEXT
  );
  await assertMissing(path.join(dataDir, MUTATION_LEDGER_DIRECTORY));
});

test("StoryService startup automatically finishes Release B before opening stores", async (t) => {
  const dataDir = await format1Directory(
    t,
    "1667-settings-migrate-service-",
    FILE_SETTINGS
  );
  const service = new StoryService({ dataDir });
  try {
    await service.init();
    const view = await service.settings.loadView();
    assert.equal(view.dataFormat, 2);
    assert.equal(view.editable, true);
    assert.deepEqual(view.effective, FILE_SETTINGS);
  } finally {
    await service.dispose();
  }

  await assertConvergedMigration(dataDir, FILE_SETTINGS, "file");
});

async function assertConvergedMigration(
  dataDir: string,
  expectedSettings: GenerationSettings,
  sourceTag: "file" | "absent-default"
): Promise<void> {
  assert.equal(await readDataDirectoryFormat(dataDir), 2);
  assert.equal(
    await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
    dataDirectoryOwnerMarkerText(2)
  );
  const source = await loadGenerationSettingsV1Source(dataDir);
  assert.equal(source.sourceTag, sourceTag);
  assert.deepEqual(source.settings, expectedSettings);
  const identity = settingsFormatMigrationV1Identity(
    source.sourceTag,
    source.canonicalV1Hash
  );
  const state = await readSettingsState(dataDir);
  assert.deepEqual(state.documents["1"], convertGenerationSettingsV1(expectedSettings));
  assert.deepEqual(state.lastTransaction, {
    receiptKind: "format-migration-v1",
    key: identity.key,
    phase: "prepared"
  });

  const receipt = await new MutationLedgerStore(dataDir)
    .loadFormatMigrationReceipt(identity.key);
  if (receipt.prepared === null || receipt.completed === null) {
    throw new Error("migration receipt is not terminal");
  }
  assert.equal(receipt.prepared.key, identity.key);
  assert.equal(receipt.prepared.fingerprintHash, identity.fingerprintHash);
  assert.equal(receipt.prepared.oldStateHash, source.canonicalV1Hash);
  assert.equal(receipt.prepared.newStateHash, hashSettingsStateV2(state));
  assert.deepEqual(receipt.prepared.result, {
    kind: "format-migration-v1",
    sourceTag,
    canonicalV1Hash: source.canonicalV1Hash
  });
  assert.equal(
    receipt.completed.preparedRecordHash,
    hashPreparedMutationRecord(receipt.prepared)
  );
}

async function format1Directory(
  t: TestContext,
  prefix: string,
  settings?: GenerationSettings
): Promise<string> {
  const dataDir = await temporaryDirectory(t, prefix);
  const initializer = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await initializer.acquire();
  await initializer.release();
  if (settings !== undefined) {
    await privateWrite(
      path.join(dataDir, "settings.json"),
      formatGenerationSettingsV1(settings)
    );
  }
  return dataDir;
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function privateWrite(file: string, text: string): Promise<void> {
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file), hasFsCode("ENOENT"));
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

function hasServiceCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}
