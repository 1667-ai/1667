import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STORY_INSTRUCTION_CHARS,
  MAX_STORY_MANIFEST_BYTES
} from "../server/story-v5-strict.js";
import { askAsideSession, retakeAsideSession } from "../server/aside-session-http.js";
import { formatV12, formatV14, storySummaryV6FromContent } from "../server/story-v6-codec.js";
import type { LiveStoryManifestV12 } from "../server/story-v12-types.js";
import type { LiveStoryManifestV14 } from "../server/story-v14-types.js";
import type { StoryManifestV11, StoryManifestV13 } from "../server/story-format.js";
import type { Story } from "../shared/types.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import type { PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { ServiceError } from "../server/errors.js";
import {
  appendAsideTurn,
  emptyAsideSessionDocument,
  MAX_ASIDE_DOCUMENT_BYTES,
  serializeAsideSessionDocument
} from "../shared/aside.js";

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);
const MUTATION_ID = "m1.1767225600000.0123456789abcdef0123456789abcdef";

function v14FactManifest(
  asideSessionRefs: StoryManifestV13["asideSessionRefs"] = []
): LiveStoryManifestV14 {
  const content: StoryManifestV13 = {
    format: "1667-story",
    schemaVersion: 13,
    id: "story-one",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [{
      id: "fact-one",
      name: "Named lore",
      tag: null,
      states: [{
        id: "fact-state-one",
        revisionId: HASH,
        createdAt: NOW,
        updatedAt: NOW
      }],
      createdAt: NOW,
      updatedAt: NOW
    }],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: [],
    asideDocumentId: null,
    asideSessionRefs,
    asideUnanchoredSessionRefs: []
  };
  return {
    format: "1667-story",
    schemaVersion: 14,
    kind: "live",
    id: content.id,
    revision: "00000000000000000001",
    previousManifestHash: null,
    content,
    summary: storySummaryV6FromContent(content),
    unresolvedProvider: null,
    lastTransaction: null
  };
}

function v14FactStory(asideSessionRefs: Story["asideSessionRefs"] = []): Story {
  return {
    id: "story-one",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [{
      id: "fact-one",
      name: "Named lore",
      tag: null,
      states: [{
        id: "fact-state-one",
        text: "Canonical fact text.",
        createdAt: NOW,
        updatedAt: NOW
      }],
      activation: "always",
      keys: [],
      createdAt: NOW,
      updatedAt: NOW
    }],
    chapterBreaks: [],
    asideSessionRefs,
    asideUnanchoredSessionRefs: []
  };
}

test("retake rejects a maximum answer that cannot fit after old Thoughts are removed", async () => {
  const anchor = { partId: "take-1", takeId: "take-1" };
  let document = emptyAsideSessionDocument(anchor);
  for (let index = 0; index < 99; index += 1) {
    document = appendAsideTurn(
      document,
      `Earlier question ${index}`,
      "a".repeat(8_600)
    );
  }
  document = appendAsideTurn(
    document,
    "Last question",
    "small",
    "t".repeat(20_000)
  );
  assert.ok(Buffer.byteLength(serializeAsideSessionDocument(document), "utf8") < MAX_ASIDE_DOCUMENT_BYTES);

  const story: Story = {
    id: "story-one",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [{
      id: "take-1",
      parentId: null,
      instruction: "",
      text: "Story text.",
      model: "model",
      createdAt: NOW,
      activeChildId: null
    }],
    activeRootId: "take-1",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideSessionRefs: [{
      id: "retake",
      documentId: HASH,
      anchor,
      turnCount: document.turns.length
    }],
    asideUnanchoredSessionRefs: []
  };
  let settingsEntered = false;
  let providerEntered = false;
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => undefined,
    commitProviderEffect: async () => {
      throw new Error("provider effect must not run");
    }
  } as unknown as ProviderStoryRuntime<"retakeAside">;
  const settings = {
    loadGeneration: async () => {
      settingsEntered = true;
      throw new Error("provider settings must not load");
    }
  } as never;

  await assert.rejects(
    retakeAsideSession(
      story.id,
      { sessionId: "retake", turnIndex: 99, anchor },
      stories,
      settings,
      {} as PromptCacheRuntime,
      async () => { providerEntered = true; },
      new AbortController().signal,
      {
        entryPointsOpen: true,
        loadSession: async () => document,
        commitSession: async () => {}
      }
    ),
    (error: unknown) => error instanceof ServiceError && error.code === "content_too_large"
  );
  assert.equal(settingsEntered, false);
  assert.equal(providerEntered, false);
});

test("existing summary-anchor writes reject terminal V12 overflow before provider work", async () => {
  const summaryAnchor = { partId: "summary-1", takeId: "summary-1" };
  const makeManifest = (instructionLength: number): LiveStoryManifestV12 => {
    const content: StoryManifestV11 = {
      format: "1667-story",
      schemaVersion: 11,
      id: "story-one",
      title: "Story",
      createdAt: NOW,
      updatedAt: NOW,
      activeWordCount: 0,
      nodes: Array.from({ length: 17 }, (_, index) => ({
        id: `take-${index}`,
        parentId: null,
        instruction: "x".repeat(instructionLength),
        model: "model",
        createdAt: NOW,
        revisionId: HASH,
        preview: "",
        words: 0,
        tokens: 0,
        activeChildId: null
      })),
      facts: [],
      activeRootId: "take-0",
      bookmarks: [],
      recentNodeIds: [],
      chapterBreaks: [],
      asideDocumentId: null,
      asideSessionRefs: [{
        id: "existing",
        documentId: HASH,
        anchor: summaryAnchor,
        turnCount: 1
      }],
      asideUnanchoredSessionRefs: []
    };
    return {
      format: "1667-story",
      schemaVersion: 12,
      kind: "live",
      id: content.id,
      revision: "00000000000000000001",
      previousManifestHash: null,
      content,
      summary: storySummaryV6FromContent(content),
      unresolvedProvider: null,
      lastTransaction: null
    };
  };
  const projectedTerminal = (instructionLength: number): number => {
    const manifest = makeManifest(instructionLength);
    const projected: StoryManifestV11 = {
      ...manifest.content,
      asideSessionRefs: [],
      asideUnanchoredSessionRefs: [{
        id: "existing",
        documentId: "0".repeat(64),
        anchor: null,
        originAnchor: summaryAnchor,
        turnCount: 2
      }]
    };
    return Buffer.byteLength(formatV12({
      ...manifest,
      revision: "00000000000000000002",
      previousManifestHash: "0".repeat(64),
      unresolvedProvider: null,
      lastTransaction: {
        receiptKind: "user",
        mutationId: MUTATION_ID,
        phase: "prepared"
      },
      content: projected
    }), "utf8");
  };

  let low = 0;
  let high = MAX_STORY_INSTRUCTION_CHARS;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    try {
      projectedTerminal(middle);
      if (projectedTerminal(middle) < MAX_STORY_MANIFEST_BYTES) low = middle;
      else high = middle - 1;
    } catch (error) {
      if (error instanceof Error && /manifest exceeds.*size limit/u.test(error.message)) {
        high = middle - 1;
      } else {
        throw error;
      }
    }
  }
  const instructionLength = low + 1;
  const manifest = makeManifest(instructionLength);
  assert.ok(Buffer.byteLength(formatV12(manifest), "utf8") < MAX_STORY_MANIFEST_BYTES);
  assert.throws(
    () => projectedTerminal(instructionLength),
    /manifest exceeds.*size limit/u
  );

  const story: Story = {
    id: manifest.id,
    title: manifest.content.title,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        id: "take-0",
        parentId: null,
        instruction: "",
        text: "Story text.",
        model: "model",
        createdAt: NOW,
        activeChildId: null
      },
      {
        id: "summary-1",
        parentId: null,
        instruction: "",
        text: "Summary.",
        model: "model",
        createdAt: NOW,
        chapterBreakId: "break-1",
        role: "summary",
        activeChildId: null
      }
    ],
    activeRootId: "take-0",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideSessionRefs: [{
      id: "existing",
      documentId: HASH,
      anchor: summaryAnchor,
      turnCount: 1
    }],
    asideUnanchoredSessionRefs: []
  };
  let settingsEntered = false;
  let providerEntered = false;
  const stories = {
    asideManifest: manifest,
    asideMutationId: MUTATION_ID,
    loadForMutation: async () => story,
    hydratePath: async () => undefined,
    commitProviderEffect: async () => {
      throw new Error("provider effect must not run");
    }
  } as unknown as ProviderStoryRuntime<"askAside">;
  const settings = {
    loadGeneration: async () => {
      settingsEntered = true;
      throw new Error("provider settings must not load");
    }
  } as never;
  await assert.rejects(
    askAsideSession(
      story.id,
      { sessionId: "existing", anchor: null, question: "Next?" },
      stories,
      settings,
      {} as PromptCacheRuntime,
      async () => { providerEntered = true; },
      new AbortController().signal,
      {
        entryPointsOpen: true,
        loadSession: async () => ({
          schemaVersion: 2,
          anchor: summaryAnchor,
          title: "Existing",
          turns: [{ q: "First?", a: "First answer." }]
        }),
        commitSession: async () => {}
      }
    ),
    (error: unknown) => error instanceof ServiceError && error.code === "content_too_large"
  );
  assert.equal(settingsEntered, false);
  assert.equal(providerEntered, false);
});

test("new V2 session rejects an exact V11/V12 overflow before provider work", async () => {
  const makeManifest = (instructionLength: number): LiveStoryManifestV12 => {
    const content: StoryManifestV11 = {
      format: "1667-story",
      schemaVersion: 11,
      id: "story-one",
      title: "Story",
      createdAt: NOW,
      updatedAt: NOW,
      activeWordCount: 0,
      nodes: Array.from({ length: 17 }, (_, index) => ({
        id: `take-${index}`,
        parentId: null,
        instruction: "x".repeat(instructionLength),
        model: "model",
        createdAt: NOW,
        revisionId: HASH,
        preview: "",
        words: 0,
        tokens: 0,
        activeChildId: null
      })),
      facts: [],
      activeRootId: "take-0",
      bookmarks: [],
      recentNodeIds: [],
      chapterBreaks: [],
      asideDocumentId: null,
      asideSessionRefs: [],
      asideUnanchoredSessionRefs: []
    };
    return {
      format: "1667-story",
      schemaVersion: 12,
      kind: "live",
      id: content.id,
      revision: "00000000000000000001",
      previousManifestHash: null,
      content,
      summary: storySummaryV6FromContent(content),
      unresolvedProvider: null,
      lastTransaction: null
    };
  };

  let low = 0;
  let high = MAX_STORY_INSTRUCTION_CHARS;
  const manifestBytes = (instructionLength: number): number => {
    try {
      return Buffer.byteLength(formatV12(makeManifest(instructionLength)), "utf8");
    } catch (error) {
      if (error instanceof Error && /manifest exceeds.*size limit/u.test(error.message)) {
        return MAX_STORY_MANIFEST_BYTES + 1;
      }
      throw error;
    }
  };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = manifestBytes(middle);
    if (bytes < MAX_STORY_MANIFEST_BYTES) low = middle;
    else high = middle - 1;
  }
  const manifest = makeManifest(low);
  assert.ok(Buffer.byteLength(formatV12(manifest), "utf8") < MAX_STORY_MANIFEST_BYTES);

  const story: Story = {
    id: manifest.id,
    title: manifest.content.title,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [{
      id: "take-0",
      parentId: null,
      instruction: "",
      text: "",
      model: "model",
      createdAt: NOW,
      activeChildId: null
    }],
    activeRootId: "take-0",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideSessionRefs: [],
    asideUnanchoredSessionRefs: []
  };
  let settingsEntered = false;
  const stories = {
    asideManifest: manifest,
    asideMutationId: MUTATION_ID,
    loadForMutation: async () => story,
    hydratePath: async () => undefined,
    commitProviderEffect: async () => {
      throw new Error("provider effect must not run");
    }
  } as unknown as ProviderStoryRuntime<"askAside">;
  const settings = {
    loadGeneration: async () => {
      settingsEntered = true;
      throw new Error("provider settings must not load");
    }
  } as never;

  await assert.rejects(
    askAsideSession(
      story.id,
      { question: "Can this fit?", anchor: null, sessionId: "new-session" },
      stories,
      settings,
      {} as PromptCacheRuntime,
      async () => {},
      new AbortController().signal,
      {
        entryPointsOpen: true,
        loadSession: async () => null,
        commitSession: async () => {}
      }
    ),
    (error: unknown) => error instanceof ServiceError && error.code === "content_too_large"
  );
  assert.equal(settingsEntered, false);
});

test("virtual V1 materialization rejects an exact V11/V12 overflow before provider work", async () => {
  const makeManifest = (
    instructionLength: number,
    asideUnanchoredSessionRefs: StoryManifestV11["asideUnanchoredSessionRefs"] = []
  ): LiveStoryManifestV12 => {
    const content: StoryManifestV11 = {
      format: "1667-story",
      schemaVersion: 11,
      id: "story-one",
      title: "Story",
      createdAt: NOW,
      updatedAt: NOW,
      activeWordCount: 0,
      nodes: Array.from({ length: 17 }, (_, index) => ({
        id: `take-${index}`,
        parentId: null,
        instruction: "x".repeat(instructionLength),
        model: "model",
        createdAt: NOW,
        revisionId: HASH,
        preview: "",
        words: 0,
        tokens: 0,
        activeChildId: null
      })),
      facts: [],
      activeRootId: "take-0",
      bookmarks: [],
      recentNodeIds: [],
      chapterBreaks: [],
      asideDocumentId: HASH,
      asideSessionRefs: [],
      asideUnanchoredSessionRefs
    };
    return {
      format: "1667-story",
      schemaVersion: 12,
      kind: "live",
      id: content.id,
      revision: "00000000000000000001",
      previousManifestHash: null,
      content,
      summary: storySummaryV6FromContent(content),
      unresolvedProvider: null,
      lastTransaction: null
    };
  };
  const ordinaryRef = [{
    id: "legacy",
    documentId: "0".repeat(64),
    anchor: null,
    turnCount: 1
  }];
  const materializedRef = [{
    ...ordinaryRef[0]!,
    sourceAsideDocumentId: HASH,
    turnCount: 2
  }];
  const materializedRetakeRef = [{
    ...ordinaryRef[0]!,
    sourceAsideDocumentId: HASH,
    turnCount: 1
  }];
  const terminalProjectionBytes = (
    instructionLength: number,
    refs: StoryManifestV11["asideUnanchoredSessionRefs"]
  ): number => {
    const projected = makeManifest(instructionLength, refs);
    return Buffer.byteLength(formatV12({
      ...projected,
      revision: "00000000000000000002",
      previousManifestHash: "0".repeat(64),
      unresolvedProvider: null,
      lastTransaction: {
        receiptKind: "user",
        mutationId: MUTATION_ID,
        phase: "prepared"
      }
    }), "utf8");
  };
  const manifestBytes = (instructionLength: number): number => {
    try {
      return terminalProjectionBytes(instructionLength, ordinaryRef);
    } catch (error) {
      if (error instanceof Error && /manifest exceeds.*size limit/u.test(error.message)) {
        return MAX_STORY_MANIFEST_BYTES + 1;
      }
      throw error;
    }
  };

  let low = 0;
  let high = MAX_STORY_INSTRUCTION_CHARS;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (manifestBytes(middle) < MAX_STORY_MANIFEST_BYTES) low = middle;
    else high = middle - 1;
  }
  const manifest = makeManifest(low);
  const ordinaryProjectionBytes = terminalProjectionBytes(low, ordinaryRef);
  assert.ok(ordinaryProjectionBytes < MAX_STORY_MANIFEST_BYTES);
  assert.throws(
    () => terminalProjectionBytes(low, materializedRef),
    /manifest exceeds.*size limit/u
  );
  assert.throws(
    () => terminalProjectionBytes(low, materializedRetakeRef),
    /manifest exceeds.*size limit/u
  );

  const story: Story = {
    id: manifest.id,
    title: manifest.content.title,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [{
      id: "take-0",
      parentId: null,
      instruction: "",
      text: "",
      model: "model",
      createdAt: NOW,
      activeChildId: null
    }],
    activeRootId: "take-0",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideDocumentId: HASH,
    asideSessionRefs: [],
    asideUnanchoredSessionRefs: []
  };
  let settingsEntered = false;
  const stories = {
    asideManifest: manifest,
    asideMutationId: MUTATION_ID,
    loadForMutation: async () => story,
    hydratePath: async () => undefined,
    commitProviderEffect: async () => {
      throw new Error("provider effect must not run");
    }
  } as unknown as ProviderStoryRuntime<"askAside">;
  const settings = {
    loadGeneration: async () => {
      settingsEntered = true;
      throw new Error("provider settings must not load");
    }
  } as never;

  await assert.rejects(
    askAsideSession(
      story.id,
      { question: "Can this fit?", anchor: null, sessionId: "legacy" },
      stories,
      settings,
      {} as PromptCacheRuntime,
      async () => {},
      new AbortController().signal,
      {
        entryPointsOpen: true,
        loadSession: async () => ({
          schemaVersion: 2,
          anchor: null,
          title: "Legacy note",
          turns: [{ q: "Earlier question", a: "Earlier answer" }]
        }),
        commitSession: async () => {}
      }
    ),
    (error: unknown) => error instanceof ServiceError && error.code === "content_too_large"
  );
  assert.equal(settingsEntered, false);
});

test("V14 Fact State manifests use the V14 projection for Ask and retake admission", async () => {
  const settings = {
    loadGeneration: async () => {
      throw new Error("settings reached after admission");
    }
  } as never;
  const signal = new AbortController().signal;
  const askStory = v14FactStory();
  const askManifest = v14FactManifest();
  const askStories = {
    asideManifest: askManifest,
    asideMutationId: MUTATION_ID,
    loadForMutation: async () => askStory,
    hydratePath: async () => undefined,
    commitProviderEffect: async () => { throw new Error("provider must not run"); }
  } as unknown as ProviderStoryRuntime<"askAside">;
  await assert.rejects(
    askAsideSession(
      askStory.id,
      { sessionId: "ask-v14", anchor: null, question: "What matters?" },
      askStories,
      settings,
      {} as PromptCacheRuntime,
      async () => {},
      signal,
      { entryPointsOpen: true, loadSession: async () => null, commitSession: async () => {} }
    ),
    /settings reached after admission/
  );

  const existingRef = {
    id: "existing-v14",
    documentId: HASH,
    anchor: null,
    turnCount: 1
  };
  const retakeStory = v14FactStory([existingRef]);
  const retakeManifest = v14FactManifest([existingRef]);
  const retakeStories = {
    asideManifest: retakeManifest,
    asideMutationId: MUTATION_ID,
    loadForMutation: async () => retakeStory,
    hydratePath: async () => undefined,
    commitProviderEffect: async () => { throw new Error("provider must not run"); }
  } as unknown as ProviderStoryRuntime<"retakeAside">;
  await assert.rejects(
    retakeAsideSession(
      retakeStory.id,
      { sessionId: existingRef.id, turnIndex: 0, anchor: null },
      retakeStories,
      settings,
      {} as PromptCacheRuntime,
      async () => {},
      signal,
      {
        entryPointsOpen: true,
        loadSession: async () => ({
          schemaVersion: 2,
          anchor: null,
          title: "Existing",
          turns: [{ q: "Earlier?", a: "Earlier answer." }]
        }),
        commitSession: async () => {}
      }
    ),
    /settings reached after admission/
  );
});
