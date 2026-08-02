import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initializeProject } from "../server/project-discovery.js";
import { StoryService } from "../server/story-service.js";
import { planCardImport } from "../shared/card-import.js";

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();

test("a card whose whole value is its character_book still imports, empty core fields and all", () => {
  const plan = planCardImport(encoder.encode(JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Archive",
      description: "",
      personality: "",
      scenario: "",
      character_book: {
        entries: [
          { content: "The pass closes in winter.", name: "Weather", keys: ["storm"] },
          { content: "The keeper never leaves the light.", comment: "Premise", constant: true }
        ]
      }
    }
  })), 128);

  assert.deepEqual(plan.used, []);
  assert.deepEqual(plan.skipped, ["description", "personality", "scenario"]);
  assert.equal(plan.facts.length, 2, "no Character fact; both Facts come from the book");
  assert.equal(plan.facts[0]?.tag, "Weather");
  assert.equal(plan.facts[1]?.tag, "Premise");
});

test("E2E integration: import-card adds JSON and PNG card Facts, and a V3 card's Facts and book", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-card-import-e2e-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const service = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await service.init();
  const story = await service.createStory("Card target");
  await service.dispose();

  const jsonFile = path.join(root, "mira.json");
  const pngFile = path.join(root, "sable.png");
  const v3File = path.join(root, "v3.json");
  await writeFile(jsonFile, JSON.stringify(v2Card({
    name: "Mira",
    description: "A map of the glass coast.",
    personality: "Exacting.",
    scenario: ""
  })), "utf8");
  await writeFile(pngFile, png(textChunk("chara", Buffer.from(JSON.stringify(v2Card({
    name: "Sable",
    description: "A quiet harbor.",
    personality: "",
    scenario: "At the last tide."
  })), "utf8").toString("base64"))));
  await writeFile(v3File, JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Wren",
      description: "A lighthouse keeper.",
      personality: "Watchful.",
      scenario: "",
      tags: ["coastal"],
      creator: "someone",
      character_book: {
        entries: [
          { content: "The pass closes in winter.", name: "Weather", keys: ["storm", "snow"] },
          { content: "The light never goes dark.", comment: "Premise", constant: true }
        ]
      }
    }
  }), "utf8");

  const jsonResult = await runCardImport(root, story.id, jsonFile);
  assert.match(
    jsonResult.stdout,
    /imported 1 fact for "Mira" into "Card target" — used description, personality; skipped scenario/u
  );

  const pngResult = await runCardImport(root, story.id, pngFile);
  assert.match(
    pngResult.stdout,
    /imported 1 fact for "Sable" into "Card target" — used description, scenario; skipped personality/u
  );

  const v3Result = await runCardImport(root, story.id, v3File);
  assert.match(
    v3Result.stdout,
    /imported 3 facts for "Wren" into "Card target" — used description, personality; skipped scenario/u
  );
  // The Fidelity Report reaches standard error, the same as import-lorebook.
  assert.match(v3Result.stderr, /1 tag not imported/u);
  assert.match(v3Result.stderr, /creator not imported/u);

  const verification = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await verification.init();
  const payload = await verification.loadStory(story.id);
  await verification.dispose();
  assert.equal(payload.facts.length, 5);
  assert.match(payload.facts[0]!.text, /Mira/u);
  assert.match(payload.facts[1]!.text, /Sable/u);
  assert.match(payload.facts[2]!.text, /Wren/u);
  assert.equal(payload.facts[3]!.tag, "Weather");
  assert.equal(payload.facts[3]!.activation, "keyed");
  assert.deepEqual(payload.facts[3]!.keys, ["storm", "snow"]);
  assert.equal(payload.facts[4]!.tag, "Premise");
  assert.equal(payload.facts[4]!.activation, "always");
});

async function runCardImport(
  root: string,
  storyId: string,
  file: string
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const bun = process.execPath.includes("bun") ? process.execPath : "bun";
  const entrypoint = path.resolve("tui/src/standalone.ts");
  return await execFileAsync(
    bun,
    [entrypoint, "import-card", "--data", root, "--story", storyId, file],
    { env: { ...process.env, AI_1667_STATE: path.join(root, "machine") } }
  );
}

function v2Card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "A cartographer.",
      personality: "Exacting but kind.",
      scenario: "At the glass coast.",
      ...overrides
    }
  };
}

function textChunk(keyword: string, value: string): Uint8Array {
  return chunk("tEXt", asciiBytes(`${keyword}\0${value}`));
}

function png(...chunks: Uint8Array[]): Uint8Array {
  return concat(PNG_SIGNATURE, ...chunks, chunk("IEND", new Uint8Array()));
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.length);
  new DataView(output.buffer).setUint32(0, data.length, false);
  output.set(asciiBytes(type), 4);
  output.set(data, 8);
  return output;
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
