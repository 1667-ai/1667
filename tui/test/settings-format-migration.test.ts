import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import {
  SETTINGS_STATE_V1_FILE,
  readDataDirectoryFormat
} from "../../server/data-directory-format.js";
import { formatGenerationSettingsV1 } from "../../server/settings-v1-codec.js";
import type { GenerationSettings } from "../../shared/types.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

const LEGACY_SETTINGS: GenerationSettings = {
  provider: "openai-compatible",
  baseUrl: "https://example.test/v1",
  model: "migration-model",
  apiKeyEnv: null,
  temperature: 0.7,
  maxTokens: 1536,
  systemPrompt: "Keep the narrative voice stable.",
  contextWindow: 32768
};

test("embedded startup migrates format-1 settings before worker readiness", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-settings-migration-"));
  const initializer = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await initializer.acquire();
  await initializer.release();
  const v1Bytes = formatGenerationSettingsV1(LEGACY_SETTINGS);
  await writeFile(path.join(dataDir, SETTINGS_STATE_V1_FILE), v1Bytes, { mode: 0o600 });

  let backend: Awaited<ReturnType<typeof createWorkerStoryApi>> | null = null;
  try {
    backend = await createWorkerStoryApi({ dataDir });
    const view = await backend.api.getSettings();
    // The settings representation is v2. The directory fence is 4.
    expect(view.dataFormat).toBe(2);
    expect(view.editable).toBe(true);
    expect(view.effective).toEqual(LEGACY_SETTINGS);
    expect(await readDataDirectoryFormat(dataDir)).toBe(4);
    expect(await readFile(path.join(dataDir, SETTINGS_STATE_V1_FILE), "utf8")).toBe(v1Bytes);
  } finally {
    await backend?.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);

test("embedded migration failure releases the parent-owned data lock", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-settings-failure-"));
  const initializer = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await initializer.acquire();
  await initializer.release();
  await writeFile(
    path.join(dataDir, SETTINGS_STATE_V1_FILE),
    "{\"provider\":\"dry-run\"",
    { mode: 0o600 }
  );

  try {
    const error = await rejection(createWorkerStoryApi({ dataDir }));
    expect(error.message).toContain("malformed or unsafe");
    const contender = new DataDirectoryLock(dataDir);
    await contender.acquire();
    await contender.release();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(String(error));
  }
  throw new Error("Expected rejection");
}
