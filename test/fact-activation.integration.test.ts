import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import {
  activeBudgetedFacts,
  activeBudgetedFactsForRewrite
} from "../shared/fact-selection.js";
import type { StoryNode } from "../shared/types.js";

test("fact activation metadata round-trips through create, patch, and reload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-activation-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  const created = await service.createStory("Fact metadata");
  const keyed = await service.createFact(created.id, {
    text: "The café keeps the brass key.",
    activation: "keyed",
    keys: ["Café"],
    secondaryKeys: ["/brass, key/i"],
    secondaryMode: "not",
    scanDepth: 4,
    recursion: "off"
  });
  const factId = keyed.facts[0]!.id;
  assert.deepEqual(keyed.facts[0], {
    id: factId,
    tag: null,
    text: "The café keeps the brass key.",
    activation: "keyed",
    keys: ["Café"],
    secondaryKeys: ["/brass, key/i"],
    secondaryMode: "not",
    scanDepth: 4,
    recursion: "off",
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
    activation: "always",
    secondaryKeys: [],
    secondaryMode: null,
    scanDepth: null,
    recursion: null
  });
  assert.equal(patched.facts[0]!.activation, "always");
  assert.deepEqual(patched.facts[0]!.keys, ["brass key", "Café"]);
  assert.equal(patched.facts[0]!.secondaryKeys, undefined);
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const reloaded = await service.loadStory(created.id);
    assert.equal(reloaded.facts[0]!.activation, "always");
    assert.deepEqual(reloaded.facts[0]!.keys, ["brass key", "Café"]);
    assert.equal(reloaded.facts[0]!.secondaryKeys, undefined);
    assert.equal(reloaded.facts[0]!.scanDepth, undefined);
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
      ["x".repeat(65)],
      ["/(capturing)/"],
      ["/(?:a(?:b(?:c(?:d(?:e)))))/"]
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

test("stored Fact activation fields control the Facts selected for a request", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-activation-request-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact request");
    await service.createFact(story.id, { text: "regex", activation: "keyed", keys: ["/brass/i"] });
    await service.createFact(story.id, { text: "gated", activation: "keyed", keys: ["brass"], secondaryKeys: ["permit"] });
    await service.createFact(story.id, { text: "depth", activation: "keyed", keys: ["deep"], scanDepth: 2 });
    await service.createFact(story.id, { text: "seed", activation: "always" });
    await service.createFact(story.id, { text: "chain", activation: "keyed", keys: ["seed"] });
    const loaded = await service.loadStory(story.id);
    const nodes: StoryNode[] = [
      { id: "older", parentId: null, instruction: "", text: "deep", model: "test", createdAt: "2026-01-01T00:00:00.000Z", activeChildId: null },
      { id: "part", parentId: "older", instruction: "", text: "BRASS permit", model: "test", createdAt: "2026-01-01T00:01:00.000Z", activeChildId: null }
    ];
    const selected = activeBudgetedFacts(loaded, { contextParts: nodes, chapterBreaks: [], nodes: [] });
    assert.deepEqual(selected.kept.map((fact) => fact.text), ["regex", "gated", "depth", "seed", "chain"]);
  } finally { await service.dispose(); }
});

test("stored keyed Facts keep depth, gates, and bounded chains at request boundaries", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-activation-matrix-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact activation matrix");
    const create = (text: string, keys: string[], extra = {}) => service.createFact(story.id, {
      text,
      activation: "keyed",
      keys,
      ...extra
    });

    await create("and hit", ["signal"], { secondaryKeys: ["permit"] });
    await create("and miss", ["signal"], { secondaryKeys: ["absent"] });
    await create("not suppressed", ["signal"], { secondaryKeys: ["forbid"], secondaryMode: "not" });
    for (let index = 0; index < 6; index += 1) {
      await create(`link ${index}`, [`link ${index}`], { text: `link ${index + 1}` });
    }
    await create("off link", ["off start"], { text: "off next", recursion: "off" });
    await create("off target", ["off next"]);
    await create("mutual first", ["mutual start"], { text: "mutual second" });
    await create("mutual second", ["mutual second"], { text: "mutual first" });
    await create("rewrite shallow", ["rewrite-only"], { scanDepth: 1 });
    await create("rewrite default", ["rewrite-only"]);
    await create("rewrite deep", ["rewrite-only"], { scanDepth: 2 });

    const loaded = await service.loadStory(story.id);
    const contextParts: StoryNode[] = [
      node("older", "rewrite-only"),
      node("newer", "signal permit forbid link 0 off start mutual start")
    ];
    const selected = activeBudgetedFacts(loaded, {
      contextParts,
      chapterBreaks: [],
      nodes: []
    });

    assert.deepEqual(selected.kept.filter((fact) => !fact.text.startsWith("rewrite")).map((fact) => fact.text), [
      "and hit",
      "link 1",
      "link 2",
      "link 3",
      "link 4",
      "off next",
      "mutual second",
      "mutual first"
    ]);
    assert.deepEqual(
      selected.activation.facts.filter((fact) => fact.text.startsWith("link ")).map((fact) => fact.text),
      ["link 1", "link 2", "link 3", "link 4"],
      "a six-link chain stops after the three recursive rounds"
    );
    assert.equal(selected.activation.traces.get(
      selected.activation.facts.find((fact) => fact.text === "mutual first")!.id
    )?.round, 1);

    const rewritePath = [
      { ...contextParts[0]!, activeChildId: "newer" },
      { ...contextParts[1]!, activeChildId: null }
    ];
    const rewriteStory = { ...loaded, nodes: rewritePath, activeRootId: "older" };
    const rewrite = activeBudgetedFactsForRewrite(
      rewriteStory,
      "newer",
      "",
      ""
    );
    assert.deepEqual(
      rewrite.kept.filter((fact) => fact.text.startsWith("rewrite")).map((fact) => fact.text),
      ["rewrite default", "rewrite deep"],
      "rewrite selection applies the same scan depth as continuation selection"
    );
  } finally {
    await service.dispose();
  }
});

function node(id: string, text: string): StoryNode {
  return {
    id,
    parentId: id === "older" ? null : "older",
    instruction: "",
    text,
    model: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };
}
