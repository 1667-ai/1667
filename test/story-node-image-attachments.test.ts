import assert from "node:assert/strict";
import test from "node:test";
import type { Story, StoryNode } from "../shared/types.js";
import { applyProviderStoryEffect, type ContinueStoryEffect } from "../server/story-provider-effect.js";
import { assertNoAppendImageAttachments, commitTake, type TakeCommit } from "../server/story-nodes.js";
import { sha256 } from "../server/story-format.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";

/**
 * Coverage for "attach on commit": copying the token-probabilities pattern
 * to Image Attachments. `StoryNode.imageAttachments` is a plain property.
 * Unlike `tokenProbabilityId`/`reasoningId`, the stored shape IS the ordered
 * attachment list itself, with no separate object hash to mint at encode
 * time, so this asserts against the property directly rather than a pending
 * side table (see server/story-nodes.ts's `attachTakeImageAttachments`).
 */

const AT = "2026-08-01T00:00:00.000Z";
const hydrate = async () => {};

function node(id: string, parentId: string | null, text: string, overrides: Partial<StoryNode> = {}): StoryNode {
  return { id, parentId, instruction: "", text, model: "m", createdAt: AT, activeChildId: null, ...overrides };
}

function story(nodes: StoryNode[], activeRootId: string | null): Story {
  return {
    id: "st1",
    title: "T",
    createdAt: AT,
    updatedAt: AT,
    nodes,
    activeRootId,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

function attachment(objectId: string): StoryImageAttachment {
  return { objectId, mediaType: "image/png", width: 4, height: 4, byteLength: 10 };
}

test("commitTake attaches Image Attachments to a freshly created take", () => {
  const root = node("root", null, "Root prose.");
  const s = story([root], root.id);
  const commit: TakeCommit = {
    parentId: root.id,
    appendTo: null,
    expectedTextHash: null,
    instruction: "Describe the image.",
    text: "A room, lit by one lantern.",
    model: "m",
    genId: "g1",
    imageAttachments: [attachment("a".repeat(64))]
  };
  commitTake(s, commit);
  const created = s.nodes.find((n) => n.genId === "g1");
  assert.deepEqual(created?.imageAttachments, [attachment("a".repeat(64))]);
});

test("commitTake never sets imageAttachments on an empty or absent list", () => {
  const root = node("root", null, "Root prose.");
  const s = story([root], root.id);
  commitTake(s, {
    parentId: root.id,
    appendTo: null,
    expectedTextHash: null,
    instruction: "Continue.",
    text: "More prose.",
    model: "m",
    genId: "g2",
    imageAttachments: []
  });
  const created = s.nodes.find((n) => n.genId === "g2");
  assert.equal(created?.imageAttachments, undefined);
});

test("commitTake refuses an append combined with a non-empty image list", () => {
  const root = node("root", null, "Root prose.");
  const s = story([root], root.id);
  assert.throws(
    () => commitTake(s, {
      parentId: null,
      appendTo: root.id,
      expectedTextHash: sha256(root.text),
      instruction: "",
      text: " continues",
      model: "m",
      genId: "g3",
      imageAttachments: [attachment("a".repeat(64))]
    }),
    /must never carry an Image Attachment/
  );
});

test("assertNoAppendImageAttachments is a no-op for a non-append commit or an append with no images", () => {
  assert.doesNotThrow(() => assertNoAppendImageAttachments({ appendTo: null, imageAttachments: [attachment("a".repeat(64))] }));
  assert.doesNotThrow(() => assertNoAppendImageAttachments({ appendTo: "root", imageAttachments: [] }));
  assert.doesNotThrow(() => assertNoAppendImageAttachments({ appendTo: "root", imageAttachments: undefined }));
});

test("applyProviderStoryEffect attaches images on the writer-moved new-take branch, and never mutates the append branch", async () => {
  const root = node("root", null, "Root prose.", { activeChildId: "away" });
  const away = node("away", "root", "A different branch.");
  const s = story([root, away], root.id);
  const effect: ContinueStoryEffect = {
    kind: "continue",
    parentId: root.id,
    appendTo: null,
    expectedTextHash: null,
    instruction: "Describe the image.",
    text: "A lantern-lit room.",
    model: "m",
    genId: "g4",
    // The writer switched away from `root`'s recorded active child, so this
    // takes the writerMoved branch (server/story-provider-effect.ts),
    // distinct from both commitTake's branches above.
    expectedParentActiveChildId: "someone-else",
    expectedAppendActiveChildId: null,
    expectedActiveRootId: root.id,
    expectedActiveLeafId: root.id,
    imageAttachments: [attachment("b".repeat(64))]
  };
  const applied = await applyProviderStoryEffect(s, effect, hydrate);
  assert.equal(applied.changed, true);
  const created = s.nodes.find((n) => n.genId === "g4");
  assert.deepEqual(created?.imageAttachments, [attachment("b".repeat(64))]);
  // The pre-existing nodes must be untouched.
  assert.equal(s.nodes.find((n) => n.id === "root")?.imageAttachments, undefined);
  assert.equal(s.nodes.find((n) => n.id === "away")?.imageAttachments, undefined);
});
