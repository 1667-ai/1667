import assert from "node:assert/strict";
import test from "node:test";
import { continuationPlan } from "../shared/continuation-plan.js";
import { activeImageAttachments } from "../shared/prompt-plan.js";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import {
  loadActiveImageBytes,
  resolveContinueStoryImages,
  type ImageAttachmentStore
} from "../server/generation-image-attachments.js";
import { sha256 } from "../server/story-format.js";
import { opaquePng } from "./image-fixtures.js";
import type { SettingsStore } from "../server/settings.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { ChapterBreak, GenerationSettings, Story, StoryNode } from "../shared/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

function part(id: string, parentId: string | null, options: Partial<StoryNode> = {}): StoryNode {
  return {
    id,
    parentId,
    instruction: `Instruction ${id}`,
    text: `Text ${id}`,
    model: "test",
    createdAt: NOW,
    activeChildId: null,
    ...options
  };
}

function attachment(objectId: string, overrides: Partial<StoryImageAttachment> = {}): StoryImageAttachment {
  return { objectId, mediaType: "image/png", width: 4, height: 4, byteLength: 10, ...overrides };
}

function storyOf(nodes: readonly StoryNode[], activeRootId: string | null): Story {
  return {
    id: "story-1",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [...nodes],
    activeRootId,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

const OBJECT_A = "a".repeat(64);
const OBJECT_B = "b".repeat(64);
const LEASE_1 = "1".repeat(64);
const LEASE_2 = "2".repeat(64);

function refStore(byLease: ReadonlyMap<string, StoryImageAttachment>): ImageAttachmentStore {
  return {
    async resolveDraftImage(_storyId, reference) {
      const found = byLease.get(reference.leaseId);
      if (found === undefined || found.objectId !== reference.objectId) {
        const { ServiceError } = await import("../server/errors.js");
        throw new ServiceError(400, "expired", "image_attachment_expired");
      }
      return found;
    },
    async loadImage() {
      throw new Error("not needed for this test");
    }
  };
}

test("duplicate Draft Image object ids in one request fail before any object read", async () => {
  const store = refStore(new Map([
    [LEASE_1, attachment(OBJECT_A)],
    [LEASE_2, attachment(OBJECT_A)]
  ]));
  const story = storyOf([part("root", null)], "root");
  await assert.rejects(
    resolveContinueStoryImages(store, story.id, story, null, null, [
      { leaseId: LEASE_1, objectId: OBJECT_A },
      { leaseId: LEASE_2, objectId: OBJECT_A }
    ]),
    (error: unknown) => (error as { code?: string }).code === "image_attachment_duplicate"
  );
});

test("a Retake duplicate across inherited and drafted images also fails", async () => {
  const target = part("take", "root", { imageAttachments: [attachment(OBJECT_A)] });
  const root = part("root", null, { activeChildId: target.id });
  const story = storyOf([root, target], root.id);
  const store = refStore(new Map([[LEASE_1, attachment(OBJECT_A)]]));
  await assert.rejects(
    resolveContinueStoryImages(store, story.id, story, root.id, null, [
      { leaseId: LEASE_1, objectId: OBJECT_A }
    ]),
    (error: unknown) => (error as { code?: string }).code === "image_attachment_duplicate"
  );
});

test("plain Retake reuses every one of the target take's own attachments, with no Draft Lease consumed", async () => {
  const target = part("take", "root", { imageAttachments: [attachment(OBJECT_A), attachment(OBJECT_B)] });
  const root = part("root", null, { activeChildId: target.id });
  const story = storyOf([root, target], root.id);
  const store = refStore(new Map());
  const resolved = await resolveContinueStoryImages(store, story.id, story, root.id, null, []);
  assert.deepEqual(resolved.attachments, [attachment(OBJECT_A), attachment(OBJECT_B)]);
  assert.deepEqual(resolved.leaseIds, []);
});

test("Retake with a prompt combines the inherited attachments first, then new Draft Images", async () => {
  const target = part("take", "root", { imageAttachments: [attachment(OBJECT_A)] });
  const root = part("root", null, { activeChildId: target.id });
  const story = storyOf([root, target], root.id);
  const store = refStore(new Map([[LEASE_1, attachment(OBJECT_B)]]));
  const resolved = await resolveContinueStoryImages(store, story.id, story, root.id, null, [
    { leaseId: LEASE_1, objectId: OBJECT_B }
  ]);
  assert.deepEqual(resolved.attachments, [attachment(OBJECT_A), attachment(OBJECT_B)]);
  assert.deepEqual(resolved.leaseIds, [LEASE_1]);
});

test("a fresh child under a leaf with no existing take inherits nothing", async () => {
  const root = part("root", null);
  const story = storyOf([root], root.id);
  const store = refStore(new Map([[LEASE_1, attachment(OBJECT_A)]]));
  const resolved = await resolveContinueStoryImages(store, story.id, story, root.id, null, [
    { leaseId: LEASE_1, objectId: OBJECT_A }
  ]);
  assert.deepEqual(resolved.attachments, [attachment(OBJECT_A)]);
});

test("the same Image Object on two different story parts stays valid: each occurrence is counted and sent", () => {
  const first = part("p1", null, { imageAttachments: [attachment(OBJECT_A)] });
  const second = part("p2", "p1", { imageAttachments: [attachment(OBJECT_A)] });
  const plan = continuationPlan(
    "Voice.", null, null, [first, second], "Continue.", false, true, null, [], [first, second]
  ).prompt;
  const images = activeImageAttachments(plan);
  assert.equal(images.length, 2, "the same object attached to two different parts must appear twice");
  assert.deepEqual(images.map((image) => image.objectId), [OBJECT_A, OBJECT_A]);
});

test("a chapter summary removes the image blocks of the parts it covers", () => {
  const opening = part("opening", null, { imageAttachments: [attachment(OBJECT_A)], activeChildId: "middle" });
  const middle = part("middle", "opening", { imageAttachments: [attachment(OBJECT_B)], activeChildId: null });
  const chapterBreak: ChapterBreak = { id: "break-1", parentPartId: middle.id, title: "Chapter one", createdAt: NOW };
  const summary = part("summary-1", middle.id, {
    role: "summary",
    chapterBreakId: chapterBreak.id,
    coveredExtent: { fromPartId: opening.id, toPartId: middle.id },
    madeAt: NOW,
    text: "A brief summary."
  });
  const nodes = [opening, middle, summary];

  // Before the break exists, both the raw parts' images are active. Pass no
  // chapter breaks at all, matching the state the story was in before this
  // chapter was ever closed.
  const withoutSummary = continuationPlan(
    "Voice.", null, null, [opening, middle], "Continue.", false, true, null, [], nodes
  ).prompt;
  assert.equal(activeImageAttachments(withoutSummary).length, 2, "before the break closes, both images are active");

  const afterSummary = continuationPlan(
    "Voice.", null, null, [opening, middle], "Continue.", false, true, null, [chapterBreak], nodes
  ).prompt;
  // deriveChapters/assembleChapterContext substitute the summary for any
  // chapter break whose extent a summary already covers. The summary node
  // itself (nodes[2]) carries no imageAttachments, so both original blocks
  // disappear once the chapter closes.
  const images = activeImageAttachments(afterSummary);
  assert.equal(images.length, 0, "a chapter summary must remove every image block it covers");
});

test("a branch switch changes the active images: only the selected line's own attachments are sent", () => {
  const root = part("root", null, { imageAttachments: [attachment(OBJECT_A)] });
  const left = part("left", "root", { imageAttachments: [attachment(OBJECT_B)] });
  const right = part("right", "root");

  const onLeft = continuationPlan("Voice.", null, null, [root, left], "Continue.", false, true, null, [], [root, left]).prompt;
  const onRight = continuationPlan("Voice.", null, null, [root, right], "Continue.", false, true, null, [], [root, right]).prompt;

  assert.deepEqual(activeImageAttachments(onLeft).map((image) => image.objectId), [OBJECT_A, OBJECT_B]);
  assert.deepEqual(activeImageAttachments(onRight).map((image) => image.objectId), [OBJECT_A]);
});

test("loadActiveImageBytes refuses a stored object whose bytes disagree with its recorded metadata", async () => {
  const bytes = await opaquePng(4, 4);
  const wrongAttachment = attachment(OBJECT_A, { width: 999, height: 999, byteLength: bytes.byteLength });
  const store: ImageAttachmentStore = {
    async resolveDraftImage() {
      throw new Error("not needed");
    },
    async loadImage() {
      return Buffer.from(bytes);
    }
  };
  await assert.rejects(
    loadActiveImageBytes(store, "story-1", [wrongAttachment]),
    (error: unknown) => (error as { code?: string }).code === "image_invalid"
  );
});

test("loadActiveImageBytes accepts a stored object whose bytes match its recorded metadata", async () => {
  const bytes = await opaquePng(4, 4);
  const goodAttachment = attachment(OBJECT_A, { width: 4, height: 4, byteLength: bytes.byteLength });
  const store: ImageAttachmentStore = {
    async resolveDraftImage() {
      throw new Error("not needed");
    },
    async loadImage() {
      return Buffer.from(bytes);
    }
  };
  const loaded = await loadActiveImageBytes(store, "story-1", [goodAttachment]);
  assert.ok(Buffer.from(loaded.get(OBJECT_A) ?? new Uint8Array()).equals(Buffer.from(bytes)));
});

function anthropicSettings(): GenerationSettings {
  return {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "Voice.",
    contextWindow: null
  };
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("an append that carries a new image creates a child and leaves its parent unchanged", async () => {
  const root = part("root", null, { text: "The door creaked open." });
  const story = storyOf([root], root.id);
  const bytes = await opaquePng(4, 4);
  const draft = attachment(OBJECT_A, { byteLength: bytes.byteLength });

  let committedEffect: { parentId: string | null; appendTo: string | null; imageAttachments?: readonly StoryImageAttachment[] } | undefined;
  const stories: ProviderStoryRuntime<"continueStory"> = {
    loadForMutation: async () => story,
    hydratePath: async () => {},
    commitProviderEffect: async (_id, effect): Promise<never> => {
      committedEffect = effect as typeof committedEffect;
      throw new Error("stop before durable commit: this test only inspects the effect shape");
    }
  };
  const imageStore: ImageAttachmentStore = {
    resolveDraftImage: async (_id, reference) => {
      assert.equal(reference.objectId, OBJECT_A);
      return draft;
    },
    loadImage: async () => Buffer.from(bytes)
  };
  const settingsStore = {
    loadGeneration: async () => ({ settings: anthropicSettings(), promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;

  const fakeAnthropic = (async () => new Response(
    "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"More.\"}}\n\n"
    + "data: {\"type\":\"message_stop\"}\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;

  await assert.rejects(
    withFetch(fakeAnthropic, () => continueStory(
      story.id,
      {
        appendTo: root.id,
        expectedTextHash: sha256(root.text),
        instruction: "",
        genId: "gen-append-image",
        images: [{ leaseId: LEASE_1, objectId: OBJECT_A }]
      },
      stories,
      settingsStore,
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal,
      // Image input's entry points are closed by default in this release
      // (shared/image-input-release.ts); this test exercises the append-
      // plus-image downgrade rule itself, so it opens the gate explicitly.
      { imageStore, imageEntryPointsOpen: true }
    )),
    /stop before durable commit/
  );

  assert.ok(committedEffect !== undefined, "the effect must have been built and committed");
  assert.equal(committedEffect!.appendTo, null, "an image-bearing append must never literally append");
  assert.equal(committedEffect!.parentId, root.id, "the append target becomes the new child's parent");
  assert.deepEqual(
    committedEffect!.imageAttachments?.map((image) => image.objectId),
    [OBJECT_A]
  );
});

test("continueStory refuses a Draft Image reference while image input's entry points are closed, the release default", async () => {
  // The refusal fires before the story ever loads: a closed entry point
  // must not pay for work it will not do (image-input-release.ts).
  const stories: ProviderStoryRuntime<"continueStory"> = {
    loadForMutation: async () => { throw new Error("must not load the story before the entry-points gate refuses"); },
    hydratePath: async () => {},
    commitProviderEffect: async (): Promise<never> => { throw new Error("must not be reached"); }
  };
  const settingsStore = {
    loadGeneration: async () => ({ settings: anthropicSettings(), promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;

  await assert.rejects(
    continueStory(
      "story-1",
      {
        instruction: "",
        genId: "gen-closed",
        images: [{ leaseId: LEASE_1, objectId: OBJECT_A }]
      },
      stories,
      settingsStore,
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
      // No hooks: the production default, so the release constant governs
      // and the request is refused.
    ),
    (error: unknown) => (error as { code?: string }).code === "image_input_not_supported"
  );
});
