import assert from "node:assert/strict";
import test from "node:test";
import { Unpackr } from "msgpackr/unpack";
import { partsFromNovelAiStory } from "../server/import-nai.js";
import {
  exportNovelAiArchive
} from "../server/novelai-export.js";
import type { StoryNode, StoryPayload } from "../shared/types.js";

test("NovelAI story export re-imports the selected prose line in order", () => {
  const result = exportNovelAiArchive(fixtureStory(), "A spare brief.", "story");
  assert.equal(result.extension, ".story");
  const archive = JSON.parse(result.text);
  assert.deepEqual(archive.metadata, {
    storyMetadataVersion: 1,
    id: "story-1",
    title: "Archive test",
    description: "",
    textPreview: "",
    isTA: false,
    favorite: false,
    tags: [],
    createdAt: 1_735_689_600_000,
    lastUpdatedAt: 1_735_776_000_000,
    isModified: false,
    hasDocument: true
  });
  assert.equal(archive.content.storyContentVersion, 6);
  assert.deepEqual(Object.keys(archive.content), [
    "storyContentVersion", "settings", "document", "context", "lorebook",
    "storyContextConfig", "ephemeralContext", "contextDefaults", "settingsDirty",
    "phraseBiasGroups", "bannedSequenceGroups", "messageSettings", "sideChats",
    "userScripts", "scriptStorage"
  ]);
  const documentBytes = Buffer.from(archive.content.document, "base64");
  const document = new Unpackr({
    bundleStrings: true,
    moreTypes: true,
    structuredClone: false,
    mapsAsObjects: false
  }).unpack(documentBytes);
  assert.deepEqual(document.order, [1, 2]);
  assert.deepEqual([...document.sections.keys()], [1, 2]);
  const sections = [...document.sections.values()];
  assert.deepEqual(sections.map((section) => section.text), [
    "First selected part.",
    "Second selected part."
  ]);
  for (const section of sections) {
    assert.equal(section.type, 1);
    assert.ok(section.meta instanceof Map);
    assert.equal(section.meta.size, 0);
    assert.equal(section.source, undefined);
    assert.deepEqual(section.origin, []);
    assert.deepEqual(section.formatting, []);
  }
  for (const omitted of [
    "A clear fact.", "An uncategorized fact.", "selected direction",
    "discarded branch direction", "Summary prose.", "summarize chapter"
  ]) assert.equal(documentBytes.includes(Buffer.from(omitted)), false);
  assert.ok(!result.text.includes("Keep the unresolved door closed."));
  const reimported = partsFromNovelAiStory(result.text);
  assert.equal(reimported.title, "Archive test");
  assert.deepEqual(reimported.parts.map((part) => part.text), [
    "First selected part.",
    "Second selected part."
  ], "the importer must keep the selected order");
  assert.ok(reimported.parts.every((part) => part.instruction === ""));
  assert.deepEqual(result.fidelity, [
    "2 active prose parts selected.",
    "2 facts omitted.",
    "1 alternate take omitted.",
    "1 story line tag omitted.",
    "3 directions omitted.",
    "1 summary part omitted.",
    "1 chapter break omitted.",
    "1 Author's Note omitted.",
    "NovelAI history omitted."
  ]);
});

test("NovelAI scenario export flattens prose and keeps facts in its lorebook", () => {
  const result = exportNovelAiArchive(fixtureStory(), "Keep the voice plain.", "scenario");
  const scenario = JSON.parse(result.text);
  assert.equal(result.extension, ".scenario");
  assert.equal(scenario.scenarioVersion, 3);
  assert.equal(scenario.title, "Archive test");
  assert.equal(scenario.prompt, "First selected part.\n\nSecond selected part.");
  assert.deepEqual(scenario.tags, []);
  assert.equal(scenario.context[1].text, "Keep the voice plain.");
  assert.deepEqual(scenario.placeholders, []);
  assert.deepEqual(scenario.settings, {});
  assert.deepEqual(scenario.contextDefaults, { ephemeralDefaults: [], loreDefaults: [] });
  assert.deepEqual(scenario.phraseBiasGroups, []);
  assert.deepEqual(scenario.bannedSequenceGroups, []);
  assert.deepEqual(scenario.messageSettings, {});
  assert.deepEqual(scenario.userScripts, []);
  assert.equal(scenario.lorebook.lorebookVersion, 6);
  assert.deepEqual(scenario.lorebook.entries.map((entry: { id: string }) => entry.id), ["fact-1", "fact-2"]);
  assert.deepEqual(result.fidelity, [
    "2 active prose parts flattened into one prompt.",
    "2 facts exported in the lorebook.",
    "1 alternate take omitted.",
    "1 story line tag omitted.",
    "3 directions omitted.",
    "1 summary part omitted.",
    "1 chapter break omitted.",
    "1 Author's Note omitted.",
    "NovelAI history omitted."
  ]);
  assert.ok(!result.text.includes("discarded branch direction"));
  assert.ok(!result.text.includes("summarize chapter"));
  assert.ok(!result.text.includes("selected direction"));
  assert.ok(!result.text.includes("Keep the unresolved door closed."));
});

test("NovelAI lorebook export maps fact tags to categories", () => {
  const result = exportNovelAiArchive(fixtureStory(), "", "lorebook");
  const lorebook = JSON.parse(result.text);
  assert.equal(result.extension, ".lorebook");
  assert.equal(lorebook.lorebookVersion, 6);
  assert.deepEqual(lorebook.settings, { orderByKeyLocations: false });
  assert.deepEqual(lorebook.categories, [{
    name: "People",
    id: "category:People",
    enabled: true,
    createSubcontext: false,
    settings: {},
    order: [],
    open: true
  }]);
  assert.deepEqual(lorebook.entries.map((entry: Record<string, unknown>) => ({
    id: entry.id,
    text: entry.text,
    displayName: entry.displayName,
    category: entry.category,
    keys: entry.keys,
    enabled: entry.enabled,
    forceActivation: entry.forceActivation,
    lastUpdatedAt: entry.lastUpdatedAt
  })), [
    {
      id: "fact-1",
      text: "A clear fact.",
      displayName: "People",
      category: "category:People",
      keys: ["clear fact"],
      enabled: true,
      forceActivation: false,
      lastUpdatedAt: 1_735_689_600_000
    },
    {
      id: "fact-2",
      text: "An uncategorized fact.",
      displayName: "",
      category: "",
      keys: ["uncategorized"],
      enabled: true,
      forceActivation: true,
      lastUpdatedAt: 1_735_776_000_000
    }
  ]);
  assert.deepEqual(result.fidelity, [
    "2 facts exported with activation modes and keys.",
    "2 active prose parts omitted from the lorebook.",
    "1 alternate take omitted.",
    "1 story line tag omitted.",
    "3 directions omitted.",
    "1 summary part omitted.",
    "1 chapter break omitted.",
    "1 Author's Note omitted.",
    "NovelAI history omitted."
  ]);
  assert.ok(!result.text.includes("Keep the unresolved door closed."));
});

function fixtureStory(): StoryPayload {
  const first = node("part-1", null, "First selected part.", "selected direction", "part-2");
  const second = node("part-2", "part-1", "Second selected part.", "another direction", null);
  const alternate = node("alternate", "part-1", "Alternate prose.", "discarded branch direction", null);
  const summary = { ...node("summary", "part-2", "Summary prose.", "summarize chapter", null), role: "summary" as const };
  return {
    id: "story-1",
    title: "Archive test",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    authorsNote: "Keep the unresolved door closed.",
    nodes: [stub(first), stub(second), stub(alternate), stub(summary)],
    path: [first, second],
    activeRootId: first.id,
    tags: [{
      nodeId: second.id,
      name: "Draft ending",
      status: "Draft",
      color: "#334455",
      createdAt: "2025-01-02T00:00:00.000Z"
    }],
    recentNodeIds: [],
    facts: [
      {
        id: "fact-1",
        tag: "People",
        text: "A clear fact.",
        activation: "keyed",
        keys: ["clear fact"],
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z"
      },
      {
        id: "fact-2",
        tag: null,
        text: "An uncategorized fact.",
        activation: "always",
        keys: ["uncategorized"],
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z"
      }
    ],
    chapterBreaks: [{
      id: "break-1",
      parentPartId: first.id,
      title: "The middle",
      createdAt: "2025-01-01T00:00:00.000Z"
    }]
  };
}

function node(
  id: string,
  parentId: string | null,
  text: string,
  instruction: string,
  activeChildId: string | null
): StoryNode {
  return {
    id,
    parentId,
    text,
    instruction,
    model: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    activeChildId
  };
}

function stub(node: StoryNode) {
  return {
    id: node.id,
    parentId: node.parentId,
    preview: node.text,
    words: 1,
    tokens: 1,
    childCount: 0,
    leafCount: 1,
    lastTouched: node.createdAt,
    hasInstruction: node.instruction.length > 0,
    activeChildId: node.activeChildId,
    ...(node.role === undefined ? {} : { role: node.role })
  };
}
