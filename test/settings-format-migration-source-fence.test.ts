import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  dataDirectoryOwnerMarkerText,
  readDataDirectoryFormat
} from "../server/data-directory-format.js";
import { ServiceError } from "../server/errors.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import {
  settingsFormatMigrationV1Identity
} from "../server/settings-format-migration-identity.js";
import {
  ABSENT_SETTINGS_V1,
  formatGenerationSettingsV1
} from "../server/settings-v1-codec.js";
import {
  loadGenerationSettingsV1Source
} from "../server/settings-v1-store.js";
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
  model: "changed-before-activation"
};

test("source drift after marker staging blocks activation and remains retryable", async (t) => {
  for (const sourceKind of ["file", "absent-default"] as const) {
    await t.test(sourceKind, async (subtest) => {
      const dataDir = await format1Directory(
        subtest,
        `1667-settings-migration-source-fence-${sourceKind}-`,
        sourceKind === "file" ? FILE_SETTINGS : undefined
      );
      const originalSource = await loadGenerationSettingsV1Source(dataDir);
      const originalIdentity = settingsFormatMigrationV1Identity(
        originalSource.sourceTag,
        originalSource.canonicalV1Hash
      );
      const first = new DataDirectoryLock(dataDir);
      await first.acquire();
      try {
        await assert.rejects(
          first.migrateSettingsFormat({
            hooks: {
              afterMarkerStaged: () => changeSource(dataDir, sourceKind)
            }
          }),
          hasServiceCode("idempotency_conflict")
        );
      } finally {
        await first.release();
      }

      assert.equal(await readDataDirectoryFormat(dataDir), 1);
      assert.equal(
        await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
        dataDirectoryOwnerMarkerText(1)
      );
      if (sourceKind === "file") {
        assert.equal(
          await readFile(path.join(dataDir, "settings.json"), "utf8"),
          formatGenerationSettingsV1(CHANGED_SETTINGS),
          "late validation preserves the changed authoritative v1 file"
        );
      } else {
        assert.equal(
          await readFile(path.join(dataDir, "settings.json.next"), "utf8"),
          formatGenerationSettingsV1(CHANGED_SETTINGS),
          "late validation preserves the newly appeared temp without promoting it"
        );
        await assertMissing(path.join(dataDir, "settings.json"));
      }
      const receipt = await new MutationLedgerStore(dataDir)
        .loadFormatMigrationReceipt(originalIdentity.key);
      assert.notEqual(receipt.prepared, null);
      assert.notEqual(
        receipt.completed,
        null,
        "late conflict preserves the already-completed receipt"
      );

      await assertRetryBlocked(dataDir);
      if (sourceKind === "absent-default") {
        assert.equal(
          await readFile(path.join(dataDir, "settings.json.next"), "utf8"),
          formatGenerationSettingsV1(CHANGED_SETTINGS),
          "restart leaves the late temp untouched while migration evidence exists"
        );
        await assertMissing(path.join(dataDir, "settings.json"));
      }

      await restoreSource(dataDir, sourceKind);
      const retry = new DataDirectoryLock(dataDir);
      await retry.acquire();
      try {
        assert.equal(await retry.migrateSettingsFormat(), 4);
      } finally {
        await retry.release();
      }
      assert.equal(await readDataDirectoryFormat(dataDir), 4);
      const restored = await loadGenerationSettingsV1Source(dataDir);
      assert.equal(restored.sourceTag, originalSource.sourceTag);
      assert.equal(restored.canonicalV1Hash, originalSource.canonicalV1Hash);
    });
  }
});

test("a late temp beside the unchanged final cannot be cleaned into a lost update", async (t) => {
  const dataDir = await format1Directory(
    t,
    "1667-settings-migration-source-next-",
    FILE_SETTINGS
  );
  const finalPath = path.join(dataDir, "settings.json");
  const nextPath = path.join(dataDir, "settings.json.next");
  const changedBytes = formatGenerationSettingsV1(CHANGED_SETTINGS);

  await runDriftedMigration(dataDir, () => privateWrite(nextPath, changedBytes));
  assert.equal(await readFile(finalPath, "utf8"), formatGenerationSettingsV1(FILE_SETTINGS));
  assert.equal(await readFile(nextPath, "utf8"), changedBytes);

  await assertRetryBlocked(dataDir);
  assert.equal(await readFile(finalPath, "utf8"), formatGenerationSettingsV1(FILE_SETTINGS));
  assert.equal(await readFile(nextPath, "utf8"), changedBytes);

  await rm(nextPath);
  await assertRetryConverges(dataDir);
});

test("malformed late source bytes are a preserved idempotency conflict", async (t) => {
  const dataDir = await format1Directory(
    t,
    "1667-settings-migration-source-malformed-",
    FILE_SETTINGS
  );
  const finalPath = path.join(dataDir, "settings.json");
  const malformed = "{\"provider\":\"dry-run\"";

  await runDriftedMigration(dataDir, () => privateWrite(finalPath, malformed));
  assert.equal(await readFile(finalPath, "utf8"), malformed);

  await assertRetryBlocked(dataDir);
  assert.equal(await readFile(finalPath, "utf8"), malformed);

  await privateWrite(finalPath, formatGenerationSettingsV1(FILE_SETTINGS));
  await assertRetryConverges(dataDir);
});

async function changeSource(
  dataDir: string,
  sourceKind: "file" | "absent-default"
): Promise<void> {
  const file = sourceKind === "file" ? "settings.json" : "settings.json.next";
  await privateWrite(path.join(dataDir, file), formatGenerationSettingsV1(CHANGED_SETTINGS));
}

async function restoreSource(
  dataDir: string,
  sourceKind: "file" | "absent-default"
): Promise<void> {
  if (sourceKind === "file") {
    await privateWrite(
      path.join(dataDir, "settings.json"),
      formatGenerationSettingsV1(FILE_SETTINGS)
    );
    return;
  }
  await rm(path.join(dataDir, "settings.json"), { force: true });
  await rm(path.join(dataDir, "settings.json.next"), { force: true });
  const source = await loadGenerationSettingsV1Source(dataDir);
  assert.equal(source.sourceTag, "absent-default");
  assert.deepEqual(source.settings, ABSENT_SETTINGS_V1);
}

async function runDriftedMigration(
  dataDir: string,
  changeSource: () => Promise<void>
): Promise<void> {
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  try {
    await assert.rejects(
      lock.migrateSettingsFormat({
        hooks: { afterMarkerStaged: changeSource }
      }),
      hasServiceCode("idempotency_conflict")
    );
  } finally {
    await lock.release();
  }
  assert.equal(await readDataDirectoryFormat(dataDir), 1);
}

async function assertRetryBlocked(dataDir: string): Promise<void> {
  const retry = new DataDirectoryLock(dataDir);
  await retry.acquire();
  try {
    await assert.rejects(
      retry.migrateSettingsFormat(),
      hasServiceCode("idempotency_conflict")
    );
  } finally {
    await retry.release();
  }
  assert.equal(await readDataDirectoryFormat(dataDir), 1);
}

async function assertRetryConverges(dataDir: string): Promise<void> {
  const retry = new DataDirectoryLock(dataDir);
  await retry.acquire();
  try {
    assert.equal(await retry.migrateSettingsFormat(), 4);
  } finally {
    await retry.release();
  }
  assert.equal(await readDataDirectoryFormat(dataDir), 4);
}

async function format1Directory(
  t: TestContext,
  prefix: string,
  settings?: GenerationSettings
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
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

async function privateWrite(file: string, text: string): Promise<void> {
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT");
}

function hasServiceCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}
