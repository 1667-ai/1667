import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initializeProject } from "../server/project-discovery.js";
import { StoryService } from "../server/story-service.js";
import { parseWorkerMutation } from "../server/worker-mutations.js";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { makeSyntheticNovelAiV2Base64 } from "./novelai-fixture.js";
import { testApp } from "./story-server-fixture.js";

const execFileAsync = promisify(execFile);
const linuxTest = process.platform === "linux" ? test : test.skip;

test("StoryService.importNovelAI creates and persists one story", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-import-test-"));
  try {
    const service = StoryService.withoutDiagnostics({ dataDir: dir });
    await service.init();
    try {
      const document = makeSyntheticNovelAiV2Base64(new Map([
        [1, { type: 1, text: "Chapter one text." }],
        [2, { type: 1, text: "Chapter two text." }]
      ]), [1, 2]);
      const payload = await service.importNovelAI(JSON.stringify({
        storyContainerVersion: 1,
        metadata: { title: "Persisted Story" },
        content: { document }
      }));

      assert.equal(payload.title, "Persisted Story");
      assert.deepEqual(payload.path.map(({ text }) => text), [
        "Chapter one text.",
        "Chapter two text."
      ]);
      const loaded = await service.loadStory(payload.id);
      assert.equal(loaded.title, "Persisted Story");
      assert.equal(loaded.nodes.length, 2);
    } finally {
      await service.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker mutation parsing accepts the NovelAI container", () => {
  const storyContainerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Worker Import Test" },
    content: { story: { fragments: [{ data: "Prose." }] } }
  });
  const parsed = parseWorkerMutation("importNovelAI", { storyContainerJson });
  assert.equal(parsed.storyContainerJson, storyContainerJson);
});

test("1667 import routes a .story file to a project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "1667-tui-cli-nai-import-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const sampleStory = path.join(root, "sample.story");
  await copyFile(
    path.join(import.meta.dirname, "fixtures", "novelai-v2-editor-2024-sanitized.story"),
    sampleStory
  );

  const bun = process.execPath.includes("bun") ? process.execPath : "bun";
  const imported = await execFileAsync(
    bun,
    [path.resolve("tui/src/standalone.ts"), "import", "--data", project.root, sampleStory],
    { env: { ...process.env, AI_1667_STATE: path.join(root, "machine") } }
  );
  assert.match(imported.stdout, /imported "Sanitized NovelAI V2 export"/u);

  const service = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await service.init();
  const importedSummary = (await service.listStories()).find(
    ({ title }) => title === "Sanitized NovelAI V2 export"
  );
  assert.ok(importedSummary);
  const loaded = await service.loadStory(importedSummary.id);
  assert.equal(loaded.nodes.length, 101);
  assert.equal(loaded.path.reduce((sum, { text }) => sum + text.length, 0), 11_054);
  assert.ok(loaded.path.every(({ text }) => /^[x●é]+$/u.test(text)));
  await service.dispose();
});

linuxTest("HTTP POST /api/import/novelai accepts a NovelAI container", async (t) => {
  const base = await testApp(t, "1667-import-nai-http-");
  const document = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "HTTP imported NovelAI prose." }]]),
    [1]
  );
  const response = await fetchWithApiProtocol(`${base}/api/import/novelai`, {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "HTTP NovelAI Story" },
      content: { document }
    })
  });

  assert.equal(response.status, 201);
  const payload = await response.json() as StoryPayload;
  assert.equal(payload.title, "HTTP NovelAI Story");
  assert.equal(payload.path[0]?.text, "HTTP imported NovelAI prose.");
});
