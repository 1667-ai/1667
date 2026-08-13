/**
 * Aside hard boundary: Side Note text never enters Write prompts.
 * Canary + byte-identity proofs required by the Story Aside plan.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendSideNote,
  emptyAsideDocument,
  serializeAsideDocument,
  parseAsideDocument,
  MAX_SIDE_NOTES,
  canAdmitAsidePair
} from "../shared/aside.js";
import { asidePlan, fitAsideHistory } from "../shared/aside-plan.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { continuationPlan, DEFAULT_INSTRUCTION } from "../shared/continuation-plan.js";
import type { Story, StoryNode } from "../shared/types.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { StoryService } from "../server/story-service.js";
import { StoryStore } from "../server/stories.js";
import {
  encodeStoryBundle,
  decodeStoryBundle
} from "../server/story-codec.js";
import { STORY_ASIDE_SCHEMA_VERSION } from "../server/story-format.js";
import {
  peekPendingAsideDocument,
  setPendingAsideDocument
} from "../server/story-aside-pending.js";
import { liveObjectIds } from "../server/story-format-nodes.js";

const CANARY = "ASIDE_CANARY_TOKEN_9f3c2b1a_NEVER_IN_WRITE";

class FlakyAsideObjectStore extends StoryObjectStore {
  private failNextAsideWrite = true;

  override async storeAsideDocument(
    ...args: Parameters<StoryObjectStore["storeAsideDocument"]>
  ): ReturnType<StoryObjectStore["storeAsideDocument"]> {
    if (this.failNextAsideWrite) {
      this.failNextAsideWrite = false;
      throw new Error("simulated Aside object write failure");
    }
    return await super.storeAsideDocument(...args);
  }
}

function makeNode(id: string, text: string, parentId: string | null = null): StoryNode {
  return {
    id,
    parentId,
    instruction: "",
    text,
    model: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };
}

function sampleStory(nodes: StoryNode[]): Story {
  return {
    id: `st1_${"a".repeat(51)}q`,
    title: "Isolation Story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes,
    activeRootId: nodes[0]?.id ?? null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

test("Write continuation prompt excludes Side Note canary (hard isolation)", () => {
  const node = makeNode("root", "The river froze overnight.");
  const story = sampleStory([node]);
  const document = appendSideNote(emptyAsideDocument(), "Why did the river freeze?", CANARY);
  assert.ok(document.notes[0]!.answer.includes(CANARY));

  const aside = asidePlan({
    facts: null,
    parts: story.nodes,
    chapterBreaks: [],
    nodes: story.nodes,
    history: document.notes,
    question: "What happens next in the plot?",
    usableTokens: 50_000
  });
  const asideText = renderPromptPlan(aside).map((m) => m.content).join("\n");
  assert.ok(asideText.includes(CANARY), "Aside prompt must see prior Side Notes");

  const cont = continuationPlan(
    "Write clear prose.",
    null,
    null,
    story.nodes,
    DEFAULT_INSTRUCTION,
    true,
    true,
    null,
    [],
    story.nodes,
    []
  );
  const contText = renderPromptPlan(cont.prompt).map((m) => m.content).join("\n");
  assert.equal(contText.includes(CANARY), false, "Write prompt must not contain Side Note canary");
});

test("Write prompt is byte-identical after a persisted Aside", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-write-bytes-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  try {
    const created = await service.createStory("Write bytes");
    await service.createNode(created.id, {
      parentId: null,
      instruction: "",
      text: "Prose bytes stay stable."
    });
    const stories = new StoryStore(path.join(dataDir, "stories"));
    await stories.init();
    const beforeStory = await stories.load(created.id);
    const renderWrite = (story: Story) => renderPromptPlan(continuationPlan(
      "Brief.", null, null, story.nodes, DEFAULT_INSTRUCTION,
      true, true, null, [], story.nodes, []
    ).prompt);
    const before = renderWrite(beforeStory);

    await service.askAside(
      created.id,
      { question: "Why is the prose stable?" },
      async () => {},
      new AbortController().signal
    );
    const afterStory = await stories.load(created.id);
    assert.equal(typeof afterStory.asideDocumentId, "string");
    const after = renderWrite(afterStory);
    assert.deepEqual(after, before);
    const hash = (messages: typeof before) =>
      createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    assert.equal(hash(after), hash(before));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("fitAsideHistory drops oldest complete pairs without splitting", () => {
  const history = [
    { question: "q1-long-enough", answer: "a1-long-enough" },
    { question: "q2-long-enough", answer: "a2-long-enough" },
    { question: "q3-long-enough", answer: "a3-long-enough" }
  ];
  // Tiny budget forces at least one drop; never splits a pair.
  const kept = fitAsideHistory(history, 12);
  assert.ok(kept.length < history.length);
  for (const note of kept) {
    assert.ok(note.question.length > 0 && note.answer.length > 0);
  }
  if (kept.length > 0) assert.equal(kept.at(-1)?.question, "q3-long-enough");
});

test("fitAsideHistory drops an over-budget newest pair rather than forcing it", () => {
  const huge = { question: "Q".repeat(400), answer: "A".repeat(400) };
  assert.deepEqual(fitAsideHistory([huge], 5), []);
});

test("admission refuses a pair that cannot fit before provider work", () => {
  let document = emptyAsideDocument();
  for (let index = 0; index < MAX_SIDE_NOTES; index += 1) {
    document = appendSideNote(document, `q${index}`, `a${index}`);
  }
  const bytes = Buffer.byteLength(serializeAsideDocument(document), "utf8");
  const result = canAdmitAsidePair(document, "one more question?", bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "count");
});

test("Aside document round-trips through the object store and V9 content encode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-obj-"));
  try {
    const objects = new StoryObjectStore(root);
    await objects.init();
    const document = appendSideNote(
      emptyAsideDocument(),
      "How could this conflict become personal?",
      CANARY
    );
    const hash = await objects.storeAsideDocument(document);
    await objects.flush();
    const loaded = await objects.readAsideDocument(hash);
    assert.equal(loaded.notes.length, 1);
    assert.equal(loaded.notes[0]!.answer, CANARY);

    const node = makeNode("root", "Story prose without the canary.");
    const story = sampleStory([node]);
    story.asideDocumentId = null;
    setPendingAsideDocument(story, document);
    const content = await encodeStoryBundle(
      story,
      objects,
      undefined,
      undefined,
      { asideActivation: true }
    );
    assert.equal(content.schemaVersion, STORY_ASIDE_SCHEMA_VERSION);
    assert.ok("asideDocumentId" in content);
    assert.equal(content.asideDocumentId, hash);
    const live = liveObjectIds(content);
    assert.deepEqual(live.leaves.aside, [hash]);

    await objects.verifyGraph(live);
    const decoded = await decodeStoryBundle(content, root);
    assert.equal(decoded.story.asideDocumentId, hash);
    // Side Note text is not on the Story object.
    const storyJson = JSON.stringify(decoded.story);
    assert.equal(storyJson.includes(CANARY), false);

    // Write plan still excludes the canary after encode/decode.
    const cont = continuationPlan(
      "Write clear prose.",
      null,
      null,
      decoded.story.nodes,
      DEFAULT_INSTRUCTION,
      true,
      true,
      null,
      [],
      decoded.story.nodes,
      []
    );
    const contText = renderPromptPlan(cont.prompt).map((m) => m.content).join("\n");
    assert.equal(contText.includes(CANARY), false);

    // Document parse is hash-stable.
    const raw = serializeAsideDocument(document);
    assert.equal(parseAsideDocument(raw, hash).notes[0]!.answer, CANARY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed Aside object write keeps pending bytes for the same-Story retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-write-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const document = appendSideNote(emptyAsideDocument(), "Retry?", "Keep these bytes.");
  const story = sampleStory([makeNode("root", "Opening.")]);
  story.asideDocumentId = createHash("sha256")
    .update(serializeAsideDocument(document))
    .digest("hex");
  setPendingAsideDocument(story, document);
  const objects = new FlakyAsideObjectStore(root);

  await assert.rejects(
    encodeStoryBundle(story, objects, undefined, undefined, { asideActivation: true }),
    /simulated Aside object write failure/u
  );
  assert.equal(peekPendingAsideDocument(story), document);

  const manifest = await encodeStoryBundle(
    story,
    objects,
    undefined,
    undefined,
    { asideActivation: true }
  );
  assert.equal(manifest.schemaVersion, STORY_ASIDE_SCHEMA_VERSION);
  assert.ok("asideDocumentId" in manifest);
  assert.equal(manifest.asideDocumentId, story.asideDocumentId);
  assert.equal(peekPendingAsideDocument(story), undefined);
  assert.equal(
    (await objects.readAsideDocument(story.asideDocumentId)).notes[0]?.answer,
    "Keep these bytes."
  );
});
