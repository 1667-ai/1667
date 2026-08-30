import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import { autonameStory } from "../server/generation-http.js";
import { PromptCacheRuntime } from "../server/provider-cache-policy.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import {
  activeBudgetedFacts,
  activeBudgetedFactsForRewrite
} from "../shared/fact-selection.js";
import { firstFactText, resolveFactState } from "../shared/fact-state.js";
import type { StoryNode } from "../shared/types.js";
import { dryRunSettings, stubSettingsStore } from "./configurable-prompt-test-helpers.js";

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
  const keyedFact = keyed.facts[0]!;
  assert.deepEqual(keyedFact, {
    id: factId,
    tag: null,
    states: [{
      id: factId,
      text: "The café keeps the brass key.",
      createdAt: keyedFact.states[0]!.createdAt,
      updatedAt: keyedFact.states[0]!.updatedAt
    }],
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
  const imported = withDefault.facts[1]!;
  assert.deepEqual(
    withDefault.facts.find((fact) => firstFactText(fact).startsWith("Imported")),
    {
      id: imported.id,
      tag: null,
      states: [{
        id: imported.id,
        text: "Imported keys stay available.",
        createdAt: imported.states[0]!.createdAt,
        updatedAt: imported.states[0]!.updatedAt
      }],
      activation: "always",
      keys: ["preserved key"],
      createdAt: imported.createdAt,
      updatedAt: imported.updatedAt
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

test("Fact Names normalize decomposed Unicode before store reload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-name-nfc-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  const story = await service.createStory("Fact Name NFC");
  const created = await service.createFact(story.id, {
    name: "Cafe\u0301",
    text: "Created with a decomposed name."
  });
  const createdFact = created.facts[0]!;
  assert.equal(createdFact.name, "Café");
  assert.equal(createdFact.name, createdFact.name!.normalize("NFC"));

  const patched = await service.patchFact(created.id, createdFact.id, {
    name: "The\u0301"
  });
  assert.equal(patched.facts[0]!.name, "Thé");
  assert.equal(patched.facts[0]!.name, patched.facts[0]!.name!.normalize("NFC"));
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const reloaded = await service.loadStory(created.id);
    assert.equal(reloaded.facts[0]!.name, "Thé");
    assert.equal(reloaded.facts[0]!.name, reloaded.facts[0]!.name!.normalize("NFC"));
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

test("ordinary Fact edits keep independent clocks after metadata leaves the legacy shape", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-state-clocks-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact clocks");
    const created = await service.createFact(story.id, { text: "Clocked fact" });
    const factId = created.facts[0]!.id;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const named = await service.patchFact(story.id, factId, { name: "Display name" });
    const namedFact = named.facts[0]!;
    assert.notEqual(namedFact.updatedAt, namedFact.states[0]!.updatedAt);

    const beforeNoOpVersion = (await service.stories.loadVersioned(story.id)).aggregateVersion;
    const noOp = await service.patchFact(story.id, factId, { name: "Display name" });
    assert.equal(noOp.facts[0]!.updatedAt, namedFact.updatedAt);
    assert.equal(noOp.facts[0]!.states[0]!.updatedAt, namedFact.states[0]!.updatedAt);
    assert.deepEqual(
      (await service.stories.loadVersioned(story.id)).aggregateVersion,
      beforeNoOpVersion,
      "a direct no-op patch must not advance the aggregate version"
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    const cleared = await service.patchFact(story.id, factId, { name: null });
    const clearedFact = cleared.facts[0]!;
    assert.equal(clearedFact.name, undefined);
    assert.notEqual(clearedFact.updatedAt, clearedFact.states[0]!.updatedAt);
    assert.equal(clearedFact.states[0]!.updatedAt, namedFact.states[0]!.updatedAt);
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

test("continuation and rewrite ignore whitespace-only story parts in scan windows", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-activation-whitespace-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact scan whitespace");
    await service.createFact(story.id, {
      text: "window hit",
      activation: "keyed",
      keys: ["signal"],
      scanDepth: 3
    });
    const contextParts: StoryNode[] = [
      { id: "first", parentId: null, instruction: "", text: "older", model: "test", createdAt: "2026-01-01T00:00:00.000Z", activeChildId: "signal" },
      { id: "signal", parentId: "first", instruction: "", text: "signal", model: "test", createdAt: "2026-01-01T00:01:00.000Z", activeChildId: "middle" },
      { id: "middle", parentId: "signal", instruction: "", text: "middle", model: "test", createdAt: "2026-01-01T00:02:00.000Z", activeChildId: "blank" },
      { id: "blank", parentId: "middle", instruction: "", text: "   ", model: "test", createdAt: "2026-01-01T00:03:00.000Z", activeChildId: "latest" },
      { id: "latest", parentId: "blank", instruction: "", text: "latest", model: "test", createdAt: "2026-01-01T00:04:00.000Z", activeChildId: null }
    ];
    const loaded = await service.loadStory(story.id);
    const continuation = activeBudgetedFacts(loaded, { contextParts, chapterBreaks: [], nodes: [] });
    const rewrite = activeBudgetedFactsForRewrite(
      { ...loaded, nodes: contextParts, activeRootId: "first" },
      "latest",
      "",
      ""
    );

    assert.deepEqual(continuation.kept.map((fact) => fact.text), ["window hit"]);
    assert.deepEqual(rewrite.kept.map((fact) => fact.text), ["window hit"]);
  } finally {
    await service.dispose();
  }
});

test("branch-scoped states resolve at the request path and preserve miss reasons", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-states-request-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact states");
    const root = (await service.createNode(story.id, { parentId: null, text: "root" })).path.at(-1)!;
    const leftPayload = await service.createNode(story.id, { parentId: root.id, text: "left" });
    const left = leftPayload.path.at(-1)!;
    const rightPayload = await service.createNode(story.id, { parentId: root.id, text: "right" });
    const right = rightPayload.path.at(-1)!;
    const rootResolution = resolveFactState({ states: [
      { id: "fallback", text: "fallback", createdAt: root.createdAt, updatedAt: root.createdAt },
      { id: "root-state", anchorPartId: root.id, text: "root revision", createdAt: root.createdAt, updatedAt: root.createdAt }
    ] }, leftPayload.path);
    assert.equal(rootResolution.kind, "active");
    if (rootResolution.kind !== "active") throw new Error("root state was not active");
    assert.equal(rootResolution.state.id, "root-state");

    const leftOnly = await service.createFact(story.id, {
      text: "left-only",
      anchorPartId: left.id
    });
    const leftOnlyId = leftOnly.facts.find((fact) => firstFactText(fact) === "left-only")!.id;
    const base = await service.createFact(story.id, { text: "base" });
    const baseId = base.facts.find((fact) => firstFactText(fact) === "base")!.id;
    const keyedMiss = await service.createFact(story.id, {
      text: "keyed miss",
      activation: "keyed",
      keys: ["not-present"]
    });
    const keyedMissId = keyedMiss.facts.find((fact) => firstFactText(fact) === "keyed miss")!.id;

    await service.createFactState(
      story.id,
      baseId,
      { text: "left revision", anchorPartId: left.id },
      "state-left"
    );
    const current = await service.loadStory(story.id);
    const leftSelection = activeBudgetedFacts({ ...current, path: leftPayload.path });
    assert.deepEqual(leftSelection.kept.map((fact) => fact.text), ["left-only", "left revision"]);
    assert.equal(leftSelection.activation.traces.get(baseId)?.stateId, "state-left");

    const rightSelection = activeBudgetedFacts(current);
    assert.deepEqual(rightSelection.kept.map((fact) => fact.text), ["base"]);
    assert.equal(rightSelection.activation.outOfScope.includes(leftOnlyId), true);
    assert.equal(rightSelection.activation.keyedMiss.includes(keyedMissId), true);
    assert.equal(rightSelection.activation.outOfScope.includes(keyedMissId), false);

    await service.createFactState(
      story.id,
      baseId,
      { ends: true, anchorPartId: right.id },
      "state-end"
    );
    const endedSelection = activeBudgetedFacts(await service.loadStory(story.id));
    assert.deepEqual(endedSelection.kept, []);
    assert.deepEqual(endedSelection.activation.ended, [baseId]);

    await service.deleteFactState(story.id, baseId, "state-end");
    const restoredSelection = activeBudgetedFacts(await service.loadStory(story.id));
    assert.deepEqual(restoredSelection.kept.map((fact) => fact.text), ["base"]);
  } finally {
    await service.dispose();
  }
});

test("autoname resolves active-line Fact states without scanning prose", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-autoname-selection-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact autoname selection");
    const root = (await service.createNode(story.id, {
      parentId: null,
      instruction: "Write.",
      text: "A quiet hall waited."
    })).path.at(-1)!;
    const base = await service.createFact(story.id, { text: "The base fact." });
    const baseId = base.facts[0]!.id;
    await service.createFactState(story.id, baseId, {
      text: "The active anchored fact.",
      anchorPartId: root.id
    }, "autoname-anchor");
    await service.createFact(story.id, {
      text: "The keyed fact.",
      activation: "keyed",
      keys: ["hall"]
    });

    const loaded = (await service.stories.loadVersioned(story.id)).story;
    const stories = {
      loadForMutation: async () => loaded
    } as unknown as ProviderStoryRuntime<"autonameStory">;
    const stop = new Error("stop after capturing the autoname prompt");
    let prompt = "";
    let providerStarted = false;
    await assert.rejects(
      autonameStory(
        story.id,
        stories,
        stubSettingsStore(dryRunSettings()),
        new PromptCacheRuntime(),
        new AbortController().signal,
        () => { providerStarted = true; },
        undefined,
        loaded.title,
        async (_settings, context) => {
          const captured = context as {
            readonly messages: readonly { readonly content: string }[];
          };
          prompt = captured.messages.map((message) => message.content).join("\n");
          throw stop;
        }
      ),
      (error: unknown) => error === stop
    );
    assert.match(prompt, /The active anchored fact\./);
    assert.doesNotMatch(prompt, /The keyed fact\./);
    assert.equal(providerStarted, false);
  } finally {
    await service.dispose();
  }
});

test("subtree deletion reports the anchored Fact State count", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-state-delete-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact state deletion");
    const root = (await service.createNode(story.id, { parentId: null, text: "root" })).path.at(-1)!;
    const child = (await service.createNode(story.id, { parentId: root.id, text: "child" })).path.at(-1)!;
    await service.createFact(story.id, { text: "anchored", anchorPartId: child.id });

    const deleted = await service.deleteNode(story.id, child.id, 1);
    assert.equal(deleted.factStatesRemoved, 1);
    assert.equal(deleted.facts.length, 0);
  } finally {
    await service.dispose();
  }
});

test("Fact metadata and state changes fail atomically", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-state-atomic-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Atomic Fact State save");
    const root = (await service.createNode(story.id, { parentId: null, text: "root" })).path.at(-1)!;
    const created = await service.createFact(story.id, { text: "base" });
    const fact = created.facts[0]!;
    await service.createFactState(story.id, fact.id, {
      text: "root state",
      anchorPartId: root.id
    });

    await assert.rejects(
      service.createFactState(story.id, fact.id, {
        text: "duplicate root state",
        anchorPartId: root.id,
        metadata: { name: "Create leak" }
      }, "rejected-create-state"),
      /two states at the same Anchor/
    );
    const afterCreateReject = (await service.loadStory(story.id)).facts[0]!;
    assert.equal(afterCreateReject.name, undefined);
    assert.equal(afterCreateReject.states.length, 2);

    await assert.rejects(
      service.patchFactState(story.id, fact.id, fact.states[0]!.id, {
        anchorPartId: root.id,
        metadata: { name: "Must not persist" }
      }),
      /two states at the same Anchor/
    );
    await assert.rejects(
      service.patchFactState(story.id, fact.id, fact.states[0]!.id, {
        anchorPartId: "missing-anchor",
        metadata: { name: "Invalid anchor leak" }
      }),
      /Unknown anchor part/
    );
    const unchanged = (await service.loadStory(story.id)).facts[0]!;
    assert.equal(unchanged.name, undefined);
    assert.equal(unchanged.states[0]!.anchorPartId, undefined);
    assert.equal(unchanged.states[1]!.anchorPartId, root.id);
  } finally {
    await service.dispose();
  }
});

test("Fact State PATCH rejects metadata-only bodies", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-state-metadata-only-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact State metadata-only");
    const created = await service.createFact(story.id, { text: "base" });
    const fact = created.facts[0]!;

    await assert.rejects(
      service.patchFactState(story.id, fact.id, fact.states[0]!.id, {
        metadata: { name: "Must use Fact PATCH" }
      }),
      /Provide text, ends, or anchorPartId/
    );
    const unchanged = (await service.loadStory(story.id)).facts[0]!;
    assert.equal(unchanged.name, undefined);
    assert.equal(firstFactText(unchanged), "base");
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
