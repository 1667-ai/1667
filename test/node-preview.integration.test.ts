import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StoryService } from "../server/story-service.js";

const SHORT_FIRST_LINE = "The door closed.";
const SECOND_LINE = "Rain still ran off the eaves, and the lamps stayed lit.";

test("a node preview holds the first line only, across a reload", async (t) => {
  const dataDir = await openDataDir(t);
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const created = await service.createStory("Preview");

  const written = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: `${SHORT_FIRST_LINE}\n\n${SECOND_LINE}`
  });
  assert.equal(written.nodes[0]!.preview, SHORT_FIRST_LINE);

  await service.dispose();
  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(() => service.dispose());

  const reloaded = await service.loadStory(created.id);
  assert.equal(reloaded.nodes[0]!.preview, SHORT_FIRST_LINE);
});

test("a node that opens with blank lines previews its text", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("Preview");

  const written = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: `\n\n  ${SHORT_FIRST_LINE}\n${SECOND_LINE}`
  });

  assert.equal(written.nodes[0]!.preview, SHORT_FIRST_LINE);
});

test("a preview stops at 100 code units when the first line is long", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("Preview");
  const long = "word ".repeat(60).trim();

  const written = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: `${long}\n${SECOND_LINE}`
  });

  assert.equal(written.nodes[0]!.preview.length, 100);
  assert.ok(long.startsWith(written.nodes[0]!.preview));
});

test("a bundle written before the first-line rule still loads and shows one line", async (t) => {
  const dataDir = await openDataDir(t);
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const created = await service.createStory("Preview");
  const text = `${SHORT_FIRST_LINE}\n\n${SECOND_LINE}`;
  await service.createNode(created.id, { parentId: null, instruction: "open the scene", text });
  await service.dispose();

  // Rewrite the stored preview the way the old projection wrote it: the whole
  // text up to 100 code units, blank line and all.
  const file = path.join(dataDir, "stories", created.id, "manifest.json");
  const stored = JSON.parse(await readFile(file, "utf8")) as { nodes: Array<{ preview: string }> };
  stored.nodes[0]!.preview = text.slice(0, 100);
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(() => service.dispose());

  const reloaded = await service.loadStory(created.id);
  assert.equal(reloaded.nodes[0]!.preview, SHORT_FIRST_LINE);
});

// Leading whitespace plus a first line past the bound is the shape that made
// an earlier form of this change write bundles it then refused to load: the
// stored preview kept the blank lead, so it held fewer prose units than the
// text projects to.
test("an indented long first line survives a save, a reload, and a second save", async (t) => {
  const dataDir = await openDataDir(t);
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const created = await service.createStory("Preview");
  const line = "x".repeat(200);
  const opening = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: `\n\n  ${line}\n${SECOND_LINE}`
  });
  const expected = "x".repeat(100);
  assert.equal(opening.nodes[0]!.preview, expected);

  // A second mutation re-encodes the bundle from the stored stub.
  await service.createNode(created.id, {
    parentId: opening.nodes[0]!.id,
    instruction: "keep going",
    text: SECOND_LINE
  });
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(() => service.dispose());

  const reloaded = await service.loadStory(created.id);
  assert.equal(reloaded.nodes[0]!.preview, expected);
});

test("a preview that grows under NFC does not shrink across save and reload", async (t) => {
  const dataDir = await openDataDir(t);
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const created = await service.createStory("Preview");
  // U+FA6C normalizes to U+242EE, one scalar that occupies two UTF-16 units.
  const line = "\u{FA6C}".repeat(120);
  const opening = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: `${line}\n${SECOND_LINE}`
  });
  const expected = opening.nodes[0]!.preview;
  assert.ok(expected.length <= 100, `preview is ${expected.length} UTF-16 units`);
  assert.ok(expected.startsWith("\u{242EE}"), "preview holds the normalized text");

  await service.createNode(created.id, {
    parentId: opening.nodes[0]!.id,
    instruction: "keep going",
    text: SECOND_LINE
  });
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(() => service.dispose());

  const reloaded = await service.loadStory(created.id);
  assert.equal(reloaded.nodes[0]!.preview, expected);
});

test("a Unicode line separator ends a preview", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("Preview");

  const written = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: `${SHORT_FIRST_LINE}\u2028${SECOND_LINE}`
  });

  assert.equal(written.nodes[0]!.preview, SHORT_FIRST_LINE);
});

async function openDataDir(t: TestContext): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-node-preview-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function openService(t: TestContext): Promise<StoryService> {
  const service = StoryService.withoutDiagnostics({ dataDir: await openDataDir(t) });
  await service.init();
  t.after(() => service.dispose());
  return service;
}
