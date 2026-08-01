import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";

test("fact activation metadata round-trips through create, patch, and reload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-activation-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  const created = await service.createStory("Fact metadata");
  const keyed = await service.createFact(created.id, {
    text: "The café keeps the brass key.",
    activation: "keyed",
    keys: ["Café"]
  });
  const factId = keyed.facts[0]!.id;
  assert.deepEqual(keyed.facts[0], {
    id: factId,
    tag: null,
    text: "The café keeps the brass key.",
    activation: "keyed",
    keys: ["Café"],
    createdAt: keyed.facts[0]!.createdAt,
    updatedAt: keyed.facts[0]!.updatedAt
  });
  keyed.facts[0]!.keys[0] = "changed outside the store";
  assert.deepEqual((await service.loadStory(created.id)).facts[0]!.keys, ["Café"]);

  const withDefault = await service.createFact(created.id, {
    text: "Imported keys stay available.",
    keys: ["preserved key"]
  });
  assert.deepEqual(
    withDefault.facts.find(({ text }) => text.startsWith("Imported")),
    {
      id: withDefault.facts[1]!.id,
      tag: null,
      text: "Imported keys stay available.",
      activation: "always",
      keys: ["preserved key"],
      createdAt: withDefault.facts[1]!.createdAt,
      updatedAt: withDefault.facts[1]!.updatedAt
    }
  );

  const patched = await service.patchFact(created.id, factId, {
    keys: ["brass key", "Café"],
    activation: "always"
  });
  assert.equal(patched.facts[0]!.activation, "always");
  assert.deepEqual(patched.facts[0]!.keys, ["brass key", "Café"]);
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const reloaded = await service.loadStory(created.id);
    assert.equal(reloaded.facts[0]!.activation, "always");
    assert.deepEqual(reloaded.facts[0]!.keys, ["brass key", "Café"]);
    assert.equal(reloaded.facts[1]!.activation, "always");
    assert.deepEqual(reloaded.facts[1]!.keys, ["preserved key"]);
  } finally {
    await service.dispose();
  }
});

test("fact mutation rejects malformed and duplicate keys", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-activation-validation-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact validation");
    for (const keys of [
      [""],
      ["one\ntwo"],
      ["red, blue"],
      ["Café", "CAFE\u0301"],
      ["x".repeat(65)]
    ]) {
      await assert.rejects(
        service.createFact(story.id, { text: "Invalid", activation: "keyed", keys }),
        /fact keys/i
      );
    }
    assert.equal((await service.loadStory(story.id)).facts.length, 0);
  } finally {
    await service.dispose();
  }
});
