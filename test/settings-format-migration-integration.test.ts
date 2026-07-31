import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  SETTINGS_STATE_V1_FILE,
  SETTINGS_STATE_V1_NEXT_FILE,
  SETTINGS_STATE_V2_FILE,
  dataDirectoryOwnerMarkerText,
  readDataDirectoryFormat
} from "../server/data-directory-format.js";
import { MUTATION_LEDGER_DIRECTORY } from "../server/mutation-ledger-paths.js";
import { SettingsStore } from "../server/settings.js";
import { formatGenerationSettingsV1 } from "../server/settings-v1-codec.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  saveCommand
} from "./settings-store-fixtures.js";

const LEGACY_SETTINGS: GenerationSettings = {
  provider: "openai-compatible",
  baseUrl: "https://example.test/v1",
  model: "migration-model",
  apiKeyEnv: null,
  temperature: 0.6,
  maxTokens: 2048,
  systemPrompt: "Preserve this recovered legacy prompt.",
  contextWindow: 32768
};

test("historical v1 next recovery feeds the same automatic migration", async (t) => {
  const dataDir = await format1Directory(t, "1667-settings-migrate-v1-next-");
  const canonicalV1 = formatGenerationSettingsV1(LEGACY_SETTINGS);
  await privateWrite(path.join(dataDir, SETTINGS_STATE_V1_NEXT_FILE), canonicalV1);

  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  try {
    assert.equal(await lock.migrateSettingsFormat(), 3);
  } finally {
    await lock.release();
  }

  assert.equal(await readDataDirectoryFormat(dataDir), 3);
  assert.equal(
    await readFile(path.join(dataDir, SETTINGS_STATE_V1_FILE), "utf8"),
    canonicalV1
  );
  await assertMissing(path.join(dataDir, SETTINGS_STATE_V1_NEXT_FILE));
  const store = new SettingsStore(dataDir);
  await store.init(2);
  assert.deepEqual((await store.loadView()).effective, LEGACY_SETTINGS);
});

test("migrated settings remain receipt-editable and restart cleanly", async (t) => {
  const dataDir = await format1Directory(t, "1667-settings-migrate-save-");
  const canonicalV1 = formatGenerationSettingsV1(LEGACY_SETTINGS);
  await privateWrite(path.join(dataDir, SETTINGS_STATE_V1_FILE), canonicalV1);
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.migrateSettingsFormat();
  await lock.release();

  const first = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await first.init(2);
  const view = await first.loadView();
  if (view.document === null || view.stateGeneration === null) {
    throw new Error("migrated format-2 settings are not editable");
  }
  const edited: SettingsDocumentV2 = {
    ...view.document,
    writing: { defaultAuthorBrief: "Edited after Release B migration." }
  };
  await first.save(saveCommand(MUTATION_A, view.stateGeneration, edited));

  const restarted = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await restarted.init(2);
  assert.equal(
    (await restarted.loadView()).effective.systemPrompt,
    "Edited after Release B migration."
  );
  assert.equal(
    await readFile(path.join(dataDir, SETTINGS_STATE_V1_FILE), "utf8"),
    canonicalV1
  );
});

test("v2-only validation failure reports the field and preserves v1 authority", async (t) => {
  const dataDir = await format1Directory(t, "1667-settings-migrate-invalid-v2-");
  const credentialedHttp: GenerationSettings = {
    ...LEGACY_SETTINGS,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "AI_1667_LOCAL_KEY"
  };
  const canonicalV1 = formatGenerationSettingsV1(credentialedHttp);
  await privateWrite(path.join(dataDir, SETTINGS_STATE_V1_FILE), canonicalV1);
  const lock = new DataDirectoryLock(dataDir);

  await lock.acquire();
  try {
    await assert.rejects(
      lock.migrateSettingsFormat(),
      /connection migrated:connection plain HTTP cannot carry authentication/
    );
  } finally {
    await lock.release();
  }

  assert.equal(await readDataDirectoryFormat(dataDir), 1);
  assert.equal(
    await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
    dataDirectoryOwnerMarkerText(1)
  );
  assert.equal(
    await readFile(path.join(dataDir, SETTINGS_STATE_V1_FILE), "utf8"),
    canonicalV1
  );
  await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_FILE));
  await assertMissing(path.join(dataDir, MUTATION_LEDGER_DIRECTORY));
});

async function format1Directory(t: TestContext, prefix: string): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const initializer = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await initializer.acquire();
  await initializer.release();
  return dataDir;
}

async function privateWrite(file: string, text: string): Promise<void> {
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}
