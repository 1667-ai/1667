import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyBasicSettingsDraft, basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import { samplingLayerRowIndex } from "../src/sampling-model.js";
import { setComposerText } from "../src/composer-model.js";
import { createWorkerStoryApi, type WorkerStoryApi } from "../src/worker-api.js";
import { key, openSettings, selectRow, settingsHarness } from "./settings-test-harness.js";

const workers: WorkerStoryApi[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map(async (worker) => await worker.dispose()));
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("Sampling Settings through the embedded worker", () => {
  test("adds a banned string from the Sampling UI when numeric logit bias is empty", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "1667-sampling-ui-worker-"));
    directories.push(directory);
    const worker = await createWorkerStoryApi({ dataDir: directory });
    workers.push(worker);

    const { source, state, press } = settingsHarness();
    useOpenAiSettings(source);
    source.api.resolveSamplingBias = worker.api.resolveSamplingBias;

    await openSettings(press);
    await selectRow(press, state, "sampling");
    await press(key("return"));
    for (let index = 0; index < samplingLayerRowIndex("banned-strings"); index += 1) {
      await press(key("down"));
    }
    await press(key("return"));
    await press(key("n"));
    const edit = state.settings?.sampling?.edit;
    if (edit === null || edit === undefined) throw new Error("banned-string editor did not open");
    setComposerText(edit.composer, "hello");
    await press(key("return"));
    await waitForSamplingResolution(state);

    expect(state.settings?.sampling?.result).not.toContain("logitBias must be an object");
    expect(state.settings?.sampling?.biasResolution.kind).toBe("ready");
    expect(state.settings?.draft.sampling.bannedStrings).toEqual(["hello"]);
  });
});

function useOpenAiSettings(source: ReturnType<typeof settingsHarness>["source"]): void {
  const active = source.settingsView;
  if (!active.editable) throw new Error("settings must be editable");
  const generation = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKeyEnv: null
  };
  const document = applyBasicSettingsDraft(active.document, generation);
  source.settingsView = {
    ...active,
    document,
    effective: basicSettingsFromDocument(document)
  };
  source.api.getSettings = async () => source.settingsView;
}

async function waitForSamplingResolution(
  state: ReturnType<typeof settingsHarness>["state"]
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (state.settings?.sampling?.biasResolution.kind === "pending") {
    if (Date.now() >= deadline) throw new Error("sampling resolution did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
