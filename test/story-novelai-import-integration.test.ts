import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../server/project-discovery.js";
import { stripInheritedAcl } from "./state-root-fixture.js";
import { StoryService } from "../server/story-service.js";
import { parseWorkerMutation } from "../server/worker-mutations.js";
import { firstFactText } from "../shared/fact-state.js";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { makeSyntheticNovelAiV2Base64 } from "./novelai-fixture.js";
import {
  legacyNovelAiLorebook,
  legacyNovelAiScenario
} from "./novelai-legacy-fixture.js";
import { testApp } from "./story-server-fixture.js";
import { runBunCli } from "./bun-cli-test-process.js";

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

test("StoryService.importNovelAI imports a retry as a sibling take, off the active storyline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-import-history-test-"));
  try {
    const service = StoryService.withoutDiagnostics({ dataDir: dir });
    await service.init();
    try {
      const sections = new Map([
        [1, { type: 1, text: "The lantern keeper walked the cliff road." }],
        [2, { type: 1, text: "She chose the low path instead." }]
      ]);
      const history = {
        root: 100,
        current: 101,
        nodes: new Map([
          [100, { changes: new Map([
            [1, { type: 0, section: { type: 1, text: "The lantern keeper walked the cliff road." } }]
          ]) }],
          [101, { parent: 100, changes: new Map([
            [2, { type: 0, section: { type: 1, text: "She chose the low path instead." }, after: 1 }]
          ]) }],
          [102, { parent: 100, changes: new Map([
            [3, { type: 0, section: { type: 1, text: "Someone else took the cliff road that night." }, after: 1 }]
          ]) }]
        ])
      };
      const document = makeSyntheticNovelAiV2Base64(sections, [1, 2], undefined, history);
      const payload = await service.importNovelAI(JSON.stringify({
        storyContainerVersion: 1,
        metadata: { title: "Branching story" },
        content: { document }
      }));

      assert.deepEqual(payload.path.map(({ text }) => text), [
        "The lantern keeper walked the cliff road.",
        "She chose the low path instead."
      ]);

      assert.equal(payload.nodes.length, 3);
      const root = payload.nodes.find(({ parentId }) => parentId === null);
      assert.ok(root);
      assert.equal(root.preview, "The lantern keeper walked the cliff road.");
      assert.equal(payload.activeRootId, root.id);
      const children = payload.nodes.filter(({ parentId }) => parentId === root.id);
      assert.equal(children.length, 2);
      assert.deepEqual(
        children.map(({ preview }) => preview).sort(),
        ["She chose the low path instead.", "Someone else took the cliff road that night."].sort()
      );
      const active = children.find(({ preview }) => preview === "She chose the low path instead.")!;
      const alternate = children.find(({ preview }) => preview === "Someone else took the cliff road that night.")!;
      assert.equal(root.activeChildId, active.id);
      assert.notEqual(root.activeChildId, alternate.id);
    } finally {
      await service.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StoryService.importNovelAI imports a V1 legacy datablocks retry as a sibling take, off the active storyline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-import-legacy-history-test-"));
  try {
    const service = StoryService.withoutDiagnostics({ dataDir: dir });
    await service.init();
    try {
      const payload = await service.importNovelAI(JSON.stringify({
        storyContainerVersion: 1,
        metadata: { title: "Legacy branching story" },
        content: {
          storyContentVersion: 1,
          story: {
            fragments: [
              { data: "The lantern keeper walked the cliff road.\n", origin: "ai" },
              { data: "She chose the low path instead.", origin: "ai" }
            ],
            currentBlock: 1,
            datablocks: [
              {
                prevBlock: -1,
                nextBlock: [1, 2],
                startIndex: 0,
                dataFragment: { data: "The lantern keeper walked the cliff road.\n", origin: "ai" }
              },
              {
                prevBlock: 0,
                nextBlock: [],
                startIndex: 42,
                dataFragment: { data: "She chose the low path instead.", origin: "ai" }
              },
              {
                prevBlock: 0,
                nextBlock: [],
                startIndex: 42,
                dataFragment: { data: "Someone else took the cliff road that night.", origin: "ai" }
              }
            ]
          }
        }
      }));

      assert.deepEqual(payload.path.map(({ text }) => text), [
        "The lantern keeper walked the cliff road.",
        "She chose the low path instead."
      ]);

      assert.equal(payload.nodes.length, 3);
      const root = payload.nodes.find(({ parentId }) => parentId === null);
      assert.ok(root);
      assert.equal(root.preview, "The lantern keeper walked the cliff road.");
      assert.equal(payload.activeRootId, root.id);
      const children = payload.nodes.filter(({ parentId }) => parentId === root.id);
      assert.equal(children.length, 2);
      assert.deepEqual(
        children.map(({ preview }) => preview).sort(),
        ["She chose the low path instead.", "Someone else took the cliff road that night."].sort()
      );
      const active = children.find(({ preview }) => preview === "She chose the low path instead.")!;
      const alternate = children.find(({ preview }) => preview === "Someone else took the cliff road that night.")!;
      assert.equal(root.activeChildId, active.id);
      assert.notEqual(root.activeChildId, alternate.id);
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
  await stripInheritedAcl(root);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const sampleStory = path.join(root, "sample.story");
  await copyFile(
    path.join(import.meta.dirname, "fixtures", "novelai-v2-editor-2024-sanitized.story"),
    sampleStory
  );

  const imported = await runBunCli(
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

test("1667 import routes a real-shaped legacy .scenario through the service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "1667-tui-cli-nai-scenario-"));
  await stripInheritedAcl(root);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const scenarioFile = path.join(root, "legacy.scenario");
  await writeFile(scenarioFile, JSON.stringify(legacyNovelAiScenario(0)), "utf8");

  const imported = await runBunCli(
    [path.resolve("tui/src/standalone.ts"), "import", "--data", project.root, scenarioFile],
    { env: { ...process.env, AI_1667_STATE: path.join(root, "machine") } }
  );
  assert.match(imported.stdout, /imported "Legacy Scenario v0"/u);

  const service = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await service.init();
  const summary = (await service.listStories()).find(({ title }) => title === "Legacy Scenario v0");
  assert.ok(summary);
  const loaded = await service.loadStory(summary.id);
  await service.dispose();
  assert.deepEqual(loaded.path.map(({ text }) => text), [
    "Opening prompt.",
    "Continuation prompt."
  ]);
  assert.deepEqual(loaded.facts.map((fact) => ({ tag: fact.tag, text: firstFactText(fact) })), [
    { tag: "memory", text: "Persistent legacy memory." },
    { tag: "Legacy Entry", text: "A legacy entry keeps its core prose." }
  ]);
});

test("1667 import-lorebook routes a real-shaped legacy Lorebook through the service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "1667-tui-cli-nai-lorebook-"));
  await stripInheritedAcl(root);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const service = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await service.init();
  const story = await service.createStory("Legacy Lorebook target");
  await service.dispose();

  const lorebookFile = path.join(root, "legacy-v4.lorebook");
  await writeFile(lorebookFile, JSON.stringify(legacyNovelAiLorebook(4)), "utf8");
  const imported = await runBunCli(
    [
      path.resolve("tui/src/standalone.ts"),
      "import-lorebook",
      "--data", project.root,
      "--story", story.id,
      lorebookFile
    ],
    { env: { ...process.env, AI_1667_STATE: path.join(root, "machine") } }
  );
  assert.match(imported.stdout, /imported 1 fact into "Legacy Lorebook target"/u);
  assert.match(imported.stderr, /1 entry read; 1 fact imported/u);

  const verification = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await verification.init();
  const payload = await verification.loadStory(story.id);
  await verification.dispose();
  assert.deepEqual(payload.facts.map((fact) => ({ tag: fact.tag, text: firstFactText(fact) })), [
    { tag: "Legacy Entry", text: "A legacy entry keeps its core prose." }
  ]);
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
  const result = await response.json() as {
    payload: StoryPayload;
    fidelity: readonly string[];
  };
  assert.equal(result.payload.title, "HTTP NovelAI Story");
  assert.equal(result.payload.path[0]?.text, "HTTP imported NovelAI prose.");
});
