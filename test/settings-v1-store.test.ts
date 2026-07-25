import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  ABSENT_SETTINGS_V1,
  ABSENT_SETTINGS_V1_TEXT,
  formatGenerationSettingsV1
} from "../server/settings-v1-codec.js";
import { loadGenerationSettingsV1 } from "../server/settings-v1-store.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { ServiceError } from "../server/errors.js";
import { SettingsStore } from "../server/settings.js";
import type { GenerationSettings } from "../shared/types.js";

const SAVED_SETTINGS: GenerationSettings = {
  provider: "openai-compatible",
  baseUrl: "https://example.test/v1",
  model: "fiction-model",
  apiKeyEnv: "AI_1667_TEST_KEY",
  temperature: 0.65,
  maxTokens: 2048,
  systemPrompt: "Continue in the established voice.",
  contextWindow: 32768
};

test("format-1 both-files-absent resolves the frozen virtual vector without writing", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-v1-absent-");

  const settings = await loadGenerationSettingsV1(dataDir);

  assert.deepEqual(settings, ABSENT_SETTINGS_V1);
  assert.equal(formatGenerationSettingsV1(settings), ABSENT_SETTINGS_V1_TEXT);
  await assert.rejects(access(path.join(dataDir, "settings.json")), hasFsCode("ENOENT"));
  await assert.rejects(access(path.join(dataDir, "settings.json.next")), hasFsCode("ENOENT"));
});

test("format-1 valid final is authoritative only after a valid leftover temp is removed", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-v1-final-");
  const nextSettings = { ...SAVED_SETTINGS, model: "uncommitted-model" };
  await privateWrite(path.join(dataDir, "settings.json"), formatGenerationSettingsV1(SAVED_SETTINGS));
  await privateWrite(path.join(dataDir, "settings.json.next"), formatGenerationSettingsV1(nextSettings));

  assert.deepEqual(await loadGenerationSettingsV1(dataDir), SAVED_SETTINGS);
  assert.equal(
    await readFile(path.join(dataDir, "settings.json"), "utf8"),
    formatGenerationSettingsV1(SAVED_SETTINGS)
  );
  await assert.rejects(access(path.join(dataDir, "settings.json.next")), hasFsCode("ENOENT"));
});

test("format-1 valid temp is promoted when final is absent", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-v1-promote-");
  const canonical = formatGenerationSettingsV1(SAVED_SETTINGS);
  await privateWrite(path.join(dataDir, "settings.json.next"), canonical);

  assert.deepEqual(await loadGenerationSettingsV1(dataDir), SAVED_SETTINGS);
  assert.equal(await readFile(path.join(dataDir, "settings.json"), "utf8"), canonical);
  await assert.rejects(access(path.join(dataDir, "settings.json.next")), hasFsCode("ENOENT"));
});

test("format-1 reads owner-owned modes produced by historical umasks", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes");
    return;
  }
  for (const mode of [0o644, 0o664, 0o666]) {
    await t.test(mode.toString(8), async (subtest) => {
      const dataDir = await temporaryDirectory(subtest, `1667-settings-v1-mode-${mode.toString(8)}-`);
      const file = path.join(dataDir, "settings.json");
      await privateWrite(file, formatGenerationSettingsV1(SAVED_SETTINGS));
      await chmod(file, mode);
      assert.deepEqual(await loadGenerationSettingsV1(dataDir), SAVED_SETTINGS);
    });
  }
});

test("format-1 malformed final never falls back to a valid temp", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-v1-bad-final-");
  await privateWrite(path.join(dataDir, "settings.json"), "{\"provider\":\"dry-run\"");
  await privateWrite(
    path.join(dataDir, "settings.json.next"),
    formatGenerationSettingsV1(SAVED_SETTINGS)
  );

  await assert.rejects(loadGenerationSettingsV1(dataDir), /malformed or unsafe/);
  assert.equal(await readFile(path.join(dataDir, "settings.json"), "utf8"), "{\"provider\":\"dry-run\"");
  assert.equal(
    await readFile(path.join(dataDir, "settings.json.next"), "utf8"),
    formatGenerationSettingsV1(SAVED_SETTINGS)
  );
});

test("format-1 malformed temp blocks cleanup even when final is valid", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-v1-bad-next-");
  await privateWrite(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1(SAVED_SETTINGS)
  );
  await privateWrite(path.join(dataDir, "settings.json.next"), "{\"schemaVersion\":2}");

  await assert.rejects(loadGenerationSettingsV1(dataDir), /malformed or unsafe/);
  assert.equal(
    await readFile(path.join(dataDir, "settings.json"), "utf8"),
    formatGenerationSettingsV1(SAVED_SETTINGS)
  );
  assert.equal(
    await readFile(path.join(dataDir, "settings.json.next"), "utf8"),
    "{\"schemaVersion\":2}"
  );
});

test("format-1 facade is read-only before command parsing or receipt allocation", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-v1-read-only-");
  await privateWrite(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1(SAVED_SETTINGS)
  );
  const store = new SettingsStore(dataDir);
  await store.init(1);
  const before = await readdir(dataDir);

  const view = await store.loadView();
  assert.equal(view.dataFormat, 1);
  assert.equal(view.editable, false);
  assert.equal(view.document, null);
  assert.deepEqual(view.effective, SAVED_SETTINGS);
  assert.doesNotThrow(() => store.assertProviderRequestSupported({
    ...SAVED_SETTINGS,
    baseUrl: "http://127.0.0.1:4567/v1",
    apiKeyEnv: null
  }));
  await assert.rejects(
    store.save({
      transportOperationId: "transport:format-one",
      mutationId: `m1.1767225600000.${"a".repeat(32)}`,
      expectedStateGeneration: 1,
      document: INITIAL_SETTINGS_DOCUMENT_V2
    }),
    hasServiceCode("settings_edit_requires_data_format_2")
  );
  await assert.rejects(
    store.discardPending({
      transportOperationId: "transport:format-one-discard",
      mutationId: `m1.1767225600001.${"b".repeat(32)}`,
      expectedStateGeneration: 1
    }),
    hasServiceCode("settings_edit_requires_data_format_2")
  );
  assert.deepEqual(await readdir(dataDir), before);
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function privateWrite(file: string, text: string): Promise<void> {
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

function hasServiceCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}
