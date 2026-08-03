import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../server/project-discovery.js";
import { StoryService } from "../../server/story-service.js";
import { runLorebookImport } from "../src/lorebook-import-cli.js";
import { runStoryImport } from "../src/import-cli.js";
import { runStoryExport } from "../src/export-cli.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lorebook import round-trip from 1667 export --format lorebook", async () => {
  const { root, stories } = await projectWithStories(["Source Story", "Target Story"]);
  const sourceId = stories[0]!.id;
  const targetId = stories[1]!.id;

  const backend = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    // Add Facts to source story
    await backend.api.createFact(sourceId, {
      tag: "Character",
      text: "Maren is a scholar.",
      activation: "keyed",
      keys: ["Maren", "scholar"]
    });
    await backend.api.createFact(sourceId, {
      tag: null,
      text: "The compass points north.",
      activation: "always",
      keys: []
    });
  } finally {
    await backend.dispose();
  }

  await runStoryExport(
    ["--story", sourceId, "--format", "lorebook", "--force", "--data", root],
    sink(),
    sink()
  );

  const exportPath = path.join(root, "Source Story.lorebook");

  const importOut = collector();
  const importErr = collector();
  await runLorebookImport(
    ["--story", "Target Story", "--data", root, exportPath],
    importOut.stream,
    importErr.stream
  );

  expect(importOut.text()).toContain('imported 2 facts into "Target Story"');

  const service = StoryService.withoutDiagnostics({ dataDir: path.join(root, ".1667") });
  await service.init();
  const targetStory = await service.loadStory(targetId);
  await service.dispose();

  expect(targetStory.facts).toHaveLength(2);
  const fact1 = targetStory.facts.find((f) => f.activation === "keyed");
  const fact2 = targetStory.facts.find((f) => f.activation === "always");

  expect(fact1).toBeDefined();
  expect(fact1?.tag).toBe("Character");
  expect(fact1?.text).toBe("Maren is a scholar.");
  expect(fact1?.keys).toEqual(["Maren", "scholar"]);

  expect(fact2).toBeDefined();
  expect(fact2?.text).toBe("The compass points north.");
});

test("lorebook import from a PNG-embedded Lorebook", async () => {
  const { root, stories } = await projectWithStories(["PNG Target"]);
  const targetId = stories[0]!.id;

  const lorebookJson = JSON.stringify({
    lorebookVersion: 6,
    entries: [
      { enabled: true, text: "PNG Fact text", displayName: "PNG Tag", forceActivation: true }
    ]
  });

  const pngFile = path.join(root, "lorebook.png");
  await writeFile(pngFile, buildPngLorebook(lorebookJson));

  const importOut = collector();
  const importErr = collector();
  await runLorebookImport(
    ["--story", targetId, "--data", root, pngFile],
    importOut.stream,
    importErr.stream
  );

  expect(importOut.text()).toContain('imported 1 fact into "PNG Target"');

  const service = StoryService.withoutDiagnostics({ dataDir: path.join(root, ".1667") });
  await service.init();
  const targetStory = await service.loadStory(targetId);
  await service.dispose();

  expect(targetStory.facts).toHaveLength(1);
  expect(targetStory.facts[0]?.tag).toBe("PNG Tag");
  expect(targetStory.facts[0]?.text).toBe("PNG Fact text");
});

test("200-entry Lorebook imports 128 Facts and reports remainder", async () => {
  const { root, stories } = await projectWithStories(["Ceiling Target"]);
  const targetId = stories[0]!.id;

  const entries = [];
  for (let i = 0; i < 200; i++) {
    entries.push({ enabled: true, text: `Fact content ${i}`, forceActivation: true });
  }

  const lorebookFile = path.join(root, "huge.lorebook");
  await writeFile(lorebookFile, JSON.stringify({ lorebookVersion: 6, entries }), "utf8");

  const importOut = collector();
  const importErr = collector();
  await runLorebookImport(
    ["--story", targetId, "--data", root, lorebookFile],
    importOut.stream,
    importErr.stream
  );

  expect(importOut.text()).toContain('imported 128 facts into "Ceiling Target"');
  expect(importErr.text()).toContain("72 entries did not fit the 128-fact limit");

  const service = StoryService.withoutDiagnostics({ dataDir: path.join(root, ".1667") });
  await service.init();
  const targetStory = await service.loadStory(targetId);
  await service.dispose();

  expect(targetStory.facts).toHaveLength(128);
});

test("wrong verb errors for 1667 import and 1667 import-lorebook", async () => {
  const { root, stories } = await projectWithStories(["Wrong Verb Story"]);

  // 1. 1667 import x.lorebook
  expect(await failure(() => runStoryImport(["x.lorebook", "--data", root], sink(), sink())))
    .toContain("1667 import creates stories, not Lorebooks (.lorebook); use 1667 import-lorebook");

  // 2. 1667 import-lorebook --story s x.story
  expect(await failure(() => runLorebookImport(["--story", stories[0]!.id, "x.story", "--data", root], sink(), sink())))
    .toContain("1667 import-lorebook imports Lorebooks (.lorebook), not story archives (.story); use 1667 import");

  // 3. 1667 import-lorebook --story s x.scenario
  expect(await failure(() => runLorebookImport(["--story", stories[0]!.id, "x.scenario", "--data", root], sink(), sink())))
    .toContain("1667 import-lorebook imports Lorebooks (.lorebook), not scenarios (.scenario); use 1667 import");
});

test("import-lorebook without --story fails and says so", async () => {
  const { root } = await projectWithStories(["No Story Target"]);
  expect(await failure(() => runLorebookImport(["x.lorebook", "--data", root], sink(), sink())))
    .toContain("import-lorebook requires --story");
});

test("import-lorebook reads a SillyTavern World Info file", async () => {
  const { root, stories } = await projectWithStories(["World Info Target"]);
  const target = stories[0]!;
  const file = path.join(root, "world.json");
  await writeFile(file, JSON.stringify({
    entries: {
      "0": {
        uid: 0,
        comment: "Weather",
        content: "The pass closes in winter.",
        key: ["storm"],
        keysecondary: ["night"],
        constant: false,
        disable: false,
        position: 0,
        probability: 100,
        useProbability: true
      },
      "1": {
        uid: 1,
        comment: "Premise",
        content: "The keeper never leaves the light.",
        key: [],
        keysecondary: [],
        constant: true,
        disable: false
      }
    }
  }), "utf8");

  const out = recorder();
  const errors = recorder();
  await runLorebookImport(["--story", target.id, "--data", root, file], out, errors);

  expect(out.text).toContain("imported 2 facts");
  expect(errors.text).toContain("lost secondary keys");

  const backend = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    const payload = await backend.api.loadStory(target.id);
    expect(payload.facts.map((fact) => fact.tag)).toEqual(["Weather", "Premise"]);
    expect(payload.facts.map((fact) => fact.activation)).toEqual(["keyed", "always"]);
    expect(payload.facts[0]!.keys).toEqual(["storm"]);
  } finally {
    await backend.dispose();
  }
});

test("an archive with nothing to import reports zero rather than failing", async () => {
  // Every entry switched off is a valid file. The writer gets a report, and the
  // story is left as it was.
  const { root, stories } = await projectWithStories(["Empty Import Target"]);
  const target = stories[0]!;
  const file = path.join(root, "empty.json");
  await writeFile(file, JSON.stringify({
    entries: {
      "0": { uid: 0, comment: "Off", content: "Not in play.", key: ["k"], disable: true }
    }
  }), "utf8");

  const out = recorder();
  const errors = recorder();
  await runLorebookImport(["--story", target.id, "--data", root, file], out, errors);

  expect(out.text).toContain("imported 0 facts");
  expect(errors.text).toContain("1 disabled entry skipped");

  const backend = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    expect((await backend.api.loadStory(target.id)).facts).toEqual([]);
  } finally {
    await backend.dispose();
  }
});

function buildPngLorebook(jsonText: string): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const base64Payload = Buffer.from(jsonText, "utf8").toString("base64");
  const keyword = "naidata";
  const chunkData = Uint8Array.from(`${keyword}\0${base64Payload}`, (c) => c.charCodeAt(0));

  const textChunk = makeChunk("tEXt", chunkData);
  const endChunk = makeChunk("IEND", new Uint8Array(0));

  const totalLength = signature.length + textChunk.length + endChunk.length;
  const result = new Uint8Array(totalLength);
  result.set(signature, 0);
  result.set(textChunk, signature.length);
  result.set(endChunk, signature.length + textChunk.length);
  return result;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.length);
  new DataView(output.buffer).setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    output[4 + i] = type.charCodeAt(i);
  }
  output.set(data, 8);
  return output;
}

async function projectWithStories(titles: readonly string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "1667-lorebook-import-cli-"));
  created.push(root);
  await initializeProject(root);
  const seeded = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    for (const story of await seeded.api.listStories()) {
      await seeded.api.deleteStory(story.id);
    }
    const stories = [];
    for (const title of titles) {
      const story = await seeded.api.createStory(title);
      stories.push({ id: story.id, title: story.title });
    }
    return { root, stories };
  } finally {
    await seeded.dispose();
  }
}

function collector(): {
  readonly stream: { write: (text: string) => boolean };
  readonly text: () => string;
} {
  const parts: string[] = [];
  return {
    stream: { write: (text) => { parts.push(String(text)); return true; } },
    text: () => parts.join("")
  };
}

/** A sink that keeps what was written, for the lines a writer actually reads. */
function recorder(): { write: (text: string) => boolean; text: string } {
  const lines: string[] = [];
  return {
    write: (text: string) => { lines.push(text); return true; },
    get text() { return lines.join(""); }
  };
}

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "the call resolved instead of failing";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
