import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import { StoryAggregateSession } from "../server/story-aggregate-session.js";
import { createChapterBreak } from "../server/chapter-breaks.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import { mintStoryMutationRequest } from "../server/story-mutation-request.js";
import { pruneUnusedTakes as pruneUnusedStoryTakes } from "../server/story-nodes.js";
import { buildStoryPayload } from "../server/story-payload.js";
import { applyProviderStoryEffect } from "../server/story-provider-effect.js";
import { allAsideSessionRefs } from "../server/aside-session-store.js";
import { MAX_SESSION_REFS_PER_BUCKET } from "../server/story-v11-strict.js";
import { reduceStoryV6 } from "../server/story-v6-reducer.js";
import { unusedTakePruneSelection } from "../shared/story-tree.js";
import {
  FINGERPRINT,
  MUTATION_ID,
  providerOperation,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";
import { ensureRootPart, hasCode, openService } from "./aside-test-helpers.js";

test("new session admission checks the target bucket before provider work", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside session bucket admission");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A line for the anchored session."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const existing = await service.askAsideV2(
    created.id,
    { question: "Existing?", anchor: null, sessionId: "existing" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(existing !== null);
  const before = await service.stories.load(created.id);
  const existingRef = before.asideUnanchoredSessionRefs?.find((ref) => ref.id === existing.id);
  assert.ok(existingRef !== undefined);
  await service.stories.withAggregateSession(created.id, async (session) => {
    const story = await session.loadLive();
    story.asideUnanchoredSessionRefs = Array.from(
      { length: MAX_SESSION_REFS_PER_BUCKET },
      (_, index) => ({
        id: index === 0 ? existing.id : `full-${index}`,
        documentId: existingRef.documentId,
        anchor: null,
        turnCount: existingRef.turnCount
      })
    );
    const replacement = await session.prepareContent(story, {
      asideActivation: service.stories.asideActivation
    });
    const manifest = reduceStoryV6(
      {
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: session.snapshot.manifestHash
      },
      {
        kind: "local-committed",
        expectedManifestHash: session.snapshot.manifestHash,
        content: replacement.content,
        summary: replacement.summary
      }
    );
    assert.ok(manifest !== null);
    await session.stageManifest(manifest);
    await session.publishStagedManifest();
  });

  let providerEntered = false;
  await assert.rejects(
    service.askAsideV2(
      created.id,
      { question: "New session?", anchor: null, sessionId: "new-session" },
      async () => { providerEntered = true; },
      new AbortController().signal,
      { providerStarted: async () => { providerEntered = true; } }
    ),
    hasCode("content_too_large")
  );
  assert.equal(providerEntered, false);

  const appended = await service.askAsideV2(
    created.id,
    { question: "Existing append?", anchor: null, sessionId: existing.id },
    async () => {},
    new AbortController().signal
  );
  assert.ok(appended !== null);
  assert.equal(appended.turns.length, 2);

  const anchored = await service.askAsideV2(
    created.id,
    { question: "Anchored session?", anchor, sessionId: "anchored-session" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(anchored !== null);
  assert.deepEqual(anchored.anchor, anchor);
});

test("overflow session refs keep their stored bucket across provider and local writes", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside overflow replacement");
  const first = await service.askAsideV2(
    created.id,
    { question: "First?", anchor: null, sessionId: "overflow" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(first !== null);
  const before = await service.stories.load(created.id);
  const firstRef = before.asideUnanchoredSessionRefs?.find((ref) => ref.id === first.id);
  assert.ok(firstRef !== undefined);
  const missingAnchor = { partId: "pruned-part", takeId: "pruned-take" };
  await service.stories.withAggregateSession(created.id, async (session) => {
    const story = await session.loadLive();
    story.asideSessionRefs = [{
      ...firstRef,
      anchor: missingAnchor
    }];
    story.asideUnanchoredSessionRefs = Array.from(
      { length: MAX_SESSION_REFS_PER_BUCKET },
      (_, index) => ({
        id: `full-${index}`,
        documentId: firstRef.documentId,
        anchor: null,
        turnCount: firstRef.turnCount
      })
    );
    const replacement = await session.prepareContent(story, {
      asideActivation: service.stories.asideActivation
    });
    const manifest = reduceStoryV6(
      {
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: session.snapshot.manifestHash
      },
      {
        kind: "local-committed",
        expectedManifestHash: session.snapshot.manifestHash,
        content: replacement.content,
        summary: replacement.summary
      }
    );
    assert.ok(manifest !== null);
    await session.stageManifest(manifest);
    await session.publishStagedManifest();
  });

  const overflowAsk = await service.askAsideV2(
    created.id,
    { question: "Second?", anchor: null, sessionId: first.id },
    async () => {},
    new AbortController().signal
  );
  assert.ok(overflowAsk !== null);
  assert.equal(overflowAsk.anchor, null);
  assert.equal(overflowAsk.turns.length, 2);

  const overflowRetake = await service.retakeAside(
    created.id,
    { sessionId: first.id, anchor: null, turnIndex: 1 },
    async () => {},
    new AbortController().signal
  );
  assert.ok(overflowRetake !== null);
  assert.equal(overflowRetake.anchor, null);
  assert.equal(overflowRetake.turns.length, 2);

  const cleared = await service.asideSessionMutation(created.id, {
    operation: "clear",
    sessionId: first.id,
    anchor: null
  });
  assert.equal(cleared.anchor, null);
  assert.equal(cleared.turns.length, 0);

  const reloaded = await service.stories.load(created.id);
  assert.equal(reloaded.asideSessionRefs?.length, 1);
  assert.equal(reloaded.asideUnanchoredSessionRefs?.length, MAX_SESSION_REFS_PER_BUCKET);
  assert.deepEqual(reloaded.asideSessionRefs?.[0]?.anchor, missingAnchor);
  const effective = allAsideSessionRefs(reloaded).find((ref) => ref.id === first.id);
  assert.ok(effective !== undefined);
  assert.equal(effective.anchor, null);
  assert.deepEqual(effective.originAnchor, missingAnchor);
});

test("v2 delete, reset, and clear persist without changing the V1 object", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-v2-verbs-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const created = await service.createStory("v2 verbs");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The lantern burned."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const legacy = await service.askAside(
    created.id,
    { question: "Legacy?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(legacy !== null);

  const first = await service.askAsideV2(
    created.id,
    { question: "First?", anchor, sessionId: "session-a" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(first !== null);
  const second = await service.askAsideV2(
    created.id,
    { question: "Second?", anchor, sessionId: first.id },
    async () => {},
    new AbortController().signal
  );
  assert.ok(second !== null && second.turns.length === 2);

  const before = (await service.stories.loadVersioned(created.id)).story.asideDocumentId;
  const deleteBody = {
    operation: "delete-turn",
    sessionId: first.id,
    turnIndex: 0,
    anchor
  } as const;
  const deleteRequest = await mintStoryMutationRequest(
    service.stories,
    created.id,
    "asideSessionMutation",
    JSON.stringify(deleteBody)
  );
  const deleted = await service.asideSessionMutation(created.id, deleteBody, deleteRequest);
  assert.equal(deleted.turns.length, 1);
  assert.equal(deleted.turns[0]!.q, "Second?");
  assert.deepEqual(
    await service.asideSessionMutation(created.id, deleteBody, deleteRequest),
    deleted
  );
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  const receipt = await ledger.loadStoryReceipt(
    `story:${created.id}`,
    deleteRequest.mutationId
  );
  assert.equal(receipt.prepared?.method, "asideSessionMutation");
  assert.notEqual(receipt.completed, null);
  assert.equal((await service.stories.loadVersioned(created.id)).story.asideDocumentId, before);

  const third = await service.askAsideV2(
    created.id,
    { question: "Third?", anchor, sessionId: first.id },
    async () => {},
    new AbortController().signal
  );
  assert.ok(third !== null && third.turns.length === 2);
  const reset = await service.asideSessionMutation(created.id, {
    operation: "reset",
    sessionId: first.id,
    turnIndex: 0,
    anchor
  });
  assert.equal(reset.turns.length, 1);
  const cleared = await service.asideSessionMutation(created.id, {
    operation: "clear",
    sessionId: first.id,
    anchor
  });
  assert.equal(cleared.turns.length, 0);
  assert.deepEqual(await service.getAside(created.id), legacy);
  await service.dispose();

  const reloaded = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await reloaded.init();
  t.after(() => reloaded.dispose());
  const read = await reloaded.getAsideV2(created.id, anchor);
  assert.equal(read.sessions.find((session) => session.id === first.id)?.turns.length, 0);
  assert.deepEqual(await reloaded.getAside(created.id), legacy);
});

test("v2 clear is isolated and stale aggregate/session targets reject", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("v2 isolation");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A quiet room."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const one = await service.askAsideV2(
    created.id,
    { question: "One?", anchor, sessionId: "one" },
    async () => {},
    new AbortController().signal
  );
  const two = await service.askAsideV2(
    created.id,
    { question: "Two?", anchor, sessionId: "two" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(one !== null && two !== null);

  const cleared = await service.asideSessionMutation(created.id, {
    operation: "clear",
    sessionId: one.id,
    anchor
  });
  assert.equal(cleared.turns.length, 0);
  const sessions = (await service.getAsideV2(created.id, anchor)).sessions;
  assert.equal(sessions.find((session) => session.id === one.id)?.turns.length, 0);
  assert.equal(sessions.find((session) => session.id === two.id)?.turns.length, 1);

  const stale = await mintStoryMutationRequest(
    service.stories,
    created.id,
    "asideSessionMutation",
    JSON.stringify({ operation: "clear", sessionId: two.id, anchor })
  );
  await service.renameStory(created.id, "changed while the request waited");
  await assert.rejects(
    () => service.asideSessionMutation(
      created.id,
      { operation: "clear", sessionId: two.id, anchor },
      stale
    ),
    hasCode("revision_conflict")
  );
  await assert.rejects(
    () => service.asideSessionMutation(
      created.id,
      { operation: "clear", sessionId: two.id, anchor: null }
    ),
    hasCode("conflict")
  );
});

test("post-prune session writes return the effective unanchored anchor", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("v2 prune anchor response");
  const anchoredRoot = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "An inactive branch."
  });
  const anchorId = anchoredRoot.path.at(-1)!.id;
  const anchor = { partId: anchorId, takeId: anchorId };
  const firstBody = { question: "Before prune?", anchor, sessionId: "pruned-session" };
  const firstRequest = await mintStoryMutationRequest(
    service.stories,
    created.id,
    "askAside",
    JSON.stringify(firstBody)
  );
  const first = await service.askAsideV2(
    created.id,
    firstBody,
    async () => {},
    new AbortController().signal,
    { mutationRequest: firstRequest }
  );
  assert.ok(first !== null);

  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The active branch."
  });
  const current = await service.loadStory(created.id);
  const selection = unusedTakePruneSelection(current);
  assert.ok(selection.takeIds.includes(anchorId));
  await service.pruneUnusedTakes(created.id, {
    expectedStoryRevision: current.updatedAt,
    expectedTakeCount: selection.takeIds.length,
    expectedPartCount: selection.nodeIds.length
  });

  const replayedPruned = await service.askAsideV2(
    created.id,
    firstBody,
    async () => {},
    new AbortController().signal,
    { mutationRequest: firstRequest }
  );
  assert.ok(replayedPruned !== null);
  assert.equal(replayedPruned.id, first.id);
  assert.equal(replayedPruned.anchor, null);
  assert.deepEqual(replayedPruned.turns, first.turns);

  const appended = await service.askAsideV2(
    created.id,
    { question: "After prune?", anchor: null, sessionId: first.id },
    async () => {},
    new AbortController().signal
  );
  assert.ok(appended !== null);
  assert.equal(appended.anchor, null);

  const deleted = await service.asideSessionMutation(created.id, {
    operation: "delete-turn",
    sessionId: first.id,
    turnIndex: 0,
    anchor: appended.anchor
  });
  assert.equal(deleted.anchor, null);
  const cleared = await service.asideSessionMutation(created.id, {
    operation: "clear",
    sessionId: first.id,
    anchor: deleted.anchor
  });
  assert.equal(cleared.anchor, null);

  await service.createNode(
    created.id,
    { parentId: null, instruction: "", text: "The restored branch." },
    anchorId
  );
  const replayedRestored = await service.askAsideV2(
    created.id,
    firstBody,
    async () => {},
    new AbortController().signal,
    { mutationRequest: firstRequest }
  );
  assert.ok(replayedRestored !== null);
  assert.deepEqual(replayedRestored.anchor, anchor);
  assert.deepEqual(replayedRestored.turns, cleared.turns);
});

test("ordinary V2 ask ignores an unrelated V1 change before provider start", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("V2 CAS isolation");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A quiet room."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const legacy = await service.askAside(
    created.id,
    { question: "Legacy?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(legacy !== null);

  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  let bound!: () => void;
  const boundP = new Promise<void>((resolve) => { bound = resolve; });
  const ask = service.askAsideV2(
    created.id,
    { question: "V2?", anchor, sessionId: "ordinary-v2" },
    async () => {},
    new AbortController().signal,
    {
      bindIntent: async () => {
        bound();
        await bindGate;
      }
    }
  );
  await boundP;
  await service.clearAside(created.id);
  releaseBind();

  const answer = await ask;
  assert.ok(answer !== null);
  assert.equal((await service.getAside(created.id)).notes.length, 0);
  assert.equal((await service.getAsideV2(created.id, anchor)).sessions[0]?.id, "ordinary-v2");
});

test("a new anchored V2 ask rejects when its take is deleted before provider start", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("V2 deleted anchor");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "This take will be deleted."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };

  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  let bound!: () => void;
  const boundP = new Promise<void>((resolve) => { bound = resolve; });
  const ask = service.askAsideV2(
    created.id,
    { question: "Can this take answer?", anchor, sessionId: "deleted-anchor" },
    async () => {},
    new AbortController().signal,
    {
      bindIntent: async () => {
        bound();
        await bindGate;
      }
    }
  );
  t.after(() => releaseBind());
  await boundP;

  await service.deleteNode(created.id, takeId, 1);
  releaseBind();

  await assert.rejects(ask, hasCode("conflict"));
  assert.equal((await service.getAsideV2(created.id, null)).sessions.length, 0);
});

test("a new anchored V2 ask rejects when its take is pruned after provider start", async (t) => {
  const fixture = await setup(t, "1667-aside-terminal-anchor-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  await fixture.stories.mutate(STORY_ID, (story) => {
    const activeRoot = story.nodes[0]!;
    story.nodes.push({
      ...activeRoot,
      id: "unused-anchor",
      text: "This take is pruned before terminal CAS.",
      activeChildId: null
    });
  });
  const before = await fixture.stories.load(STORY_ID);
  const takeId = "unused-anchor";
  const anchor = { partId: takeId, takeId };
  const selection = unusedTakePruneSelection(before);
  assert.ok(selection.takeIds.includes(takeId));
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 2 as const,
    anchor,
    title: "Terminal anchor race",
    turns: [{ q: "Can this pruned take answer?", a: "unexpected" }]
  };
  const provider = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    providerOperation(
      async (stories, start) => {
        await start();
        // The provider-started manifest is durable now. A concurrent prune is
        // represented by the current aggregate changing before terminal CAS.
        // Successor protection blocks a second public mutation in this
        // process, so the cloned current aggregate models that other writer.
        const current = structuredClone(await stories.loadForMutation(STORY_ID));
        const currentSelection = unusedTakePruneSelection(current);
        pruneUnusedStoryTakes(current, {
          expectedStoryRevision: current.updatedAt,
          expectedTakeCount: currentSelection.takeIds.length,
          expectedPartCount: currentSelection.nodeIds.length
        });
        await applyProviderStoryEffect(current, {
          kind: "aside",
          sessionId: "pruned-anchor",
          expectedAsideSessionDocumentId: null,
          expectedAsideSessionAnchor: anchor,
          sessionDocument: document
        }, async () => {});
        return document;
      },
      () => document
    )
  );

  await assert.rejects(provider, hasCode("conflict"));
  const after = await fixture.stories.load(STORY_ID);
  assert.ok(after.nodes.some((node) => node.id === takeId));
  assert.equal(after.asideSessionRefs?.length ?? 0, 0);
  assert.equal(after.asideUnanchoredSessionRefs?.length ?? 0, 0);
  const payload = buildStoryPayload(after);
  assert.equal(payload.hasAsideSessions, undefined);
  assert.equal(payload.asidePresence, undefined);
});

test("terminal Aside CAS rejects a take changed to a chapter summary", async (t) => {
  const fixture = await setup(t, "1667-aside-terminal-summary-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  await fixture.stories.mutate(STORY_ID, (story) => {
    const root = story.nodes[0]!;
    story.nodes.push({
      ...root,
      id: "summary-terminal-anchor",
      parentId: root.id,
      text: "This take becomes a chapter summary.",
      activeChildId: null
    });
    createChapterBreak(story, root.id, "Terminal summary race", "terminal-summary-break");
  });
  const before = await fixture.stories.load(STORY_ID);
  const takeId = "summary-terminal-anchor";
  const parentId = before.nodes.find((node) => node.id === takeId)!.parentId!;
  const anchor = { partId: takeId, takeId };
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 2 as const,
    anchor,
    title: "Terminal summary race",
    turns: [{ q: "Can this take answer?", a: "unexpected" }]
  };
  const provider = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    providerOperation(
      async (stories, start) => {
        await start();
        await fixture.stories.withAggregateSession(STORY_ID, async (session) => {
          const current = await session.loadLive();
          const node = current.nodes.find((candidate) => candidate.id === takeId);
          assert.ok(node !== undefined);
          node.role = "summary";
          node.chapterBreakId = "terminal-summary-break";
          node.coveredExtent = { fromPartId: parentId, toPartId: parentId };
          node.madeAt = new Date().toISOString();
          node.activeChildId = null;
          const parent = current.nodes.find((candidate) => candidate.id === parentId);
          assert.ok(parent !== undefined);
          parent.activeChildId = null;
          const replacement = await session.prepareContent(current, {
            asideActivation: fixture.stories.asideActivation
          });
          const manifest = reduceStoryV6(
            {
              kind: "present",
              manifest: session.snapshot.manifest,
              manifestHash: session.snapshot.manifestHash
            },
            {
              kind: "local-committed",
              expectedManifestHash: session.snapshot.manifestHash,
              content: replacement.content,
              summary: replacement.summary
            }
          );
          assert.ok(manifest !== null);
          await session.stageManifest(manifest);
          await session.publishStagedManifest();
        });
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          sessionId: "summary-terminal-race",
          expectedAsideSessionDocumentId: null,
          expectedAsideSessionAnchor: anchor,
          sessionDocument: document
        });
        return document;
      },
      () => document
    )
  );

  await assert.rejects(provider, hasCode("conflict"));
  const after = await fixture.stories.load(STORY_ID);
  assert.equal(after.nodes.find((node) => node.id === takeId)?.chapterBreakId, "terminal-summary-break");
  assert.equal(after.asideSessionRefs?.length ?? 0, 0);
  assert.equal(after.asideUnanchoredSessionRefs?.length ?? 0, 0);
});

test("chapter-summary anchors are rejected and persisted summary refs read unanchored", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside chapter-summary anchor");
  const parent = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A prose part."
  });
  const parentId = parent.path.at(-1)!.id;
  const { breakId } = await service.createChapterBreak(
    created.id,
    parentId,
    "A chapter",
    "summary-break"
  );
  const summaryId = "summary-anchor";
  await service.summarizeChapter(
    created.id,
    breakId,
    new AbortController().signal,
    { summaryNodeId: summaryId }
  );
  const summaryAnchor = { partId: summaryId, takeId: summaryId };

  let providerEntered = false;
  await assert.rejects(
    service.askAsideV2(
      created.id,
      { question: "Use the summary?", anchor: summaryAnchor, sessionId: "summary-ask" },
      async () => { providerEntered = true; },
      new AbortController().signal,
      { providerStarted: async () => { providerEntered = true; } }
    ),
    hasCode("conflict")
  );
  assert.equal(providerEntered, false);

  const saved = await service.askAsideV2(
    created.id,
    { question: "Keep this session.", anchor: null, sessionId: "summary-ref" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(saved !== null);
  await service.stories.withAggregateSession(created.id, async (session) => {
    const story = await session.loadLive();
    const ref = story.asideUnanchoredSessionRefs?.find((candidate) => candidate.id === saved.id);
    assert.ok(ref !== undefined);
    story.asideUnanchoredSessionRefs = (story.asideUnanchoredSessionRefs ?? [])
      .filter((candidate) => candidate.id !== saved.id);
    story.asideSessionRefs = [
      ...(story.asideSessionRefs ?? []),
      { ...ref, anchor: summaryAnchor }
    ];
    const replacement = await session.prepareContent(story, {
      asideActivation: service.stories.asideActivation
    });
    const manifest = reduceStoryV6(
      {
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: session.snapshot.manifestHash
      },
      {
        kind: "local-committed",
        expectedManifestHash: session.snapshot.manifestHash,
        content: replacement.content,
        summary: replacement.summary
      }
    );
    assert.ok(manifest !== null);
    await session.stageManifest(manifest);
    await session.publishStagedManifest();
  });

  const read = await service.getAsideV2(created.id);
  const persisted = read.sessions.find((session) => session.id === saved.id);
  assert.ok(persisted !== undefined);
  assert.equal(persisted.anchor, null);
  assert.equal(persisted.turns[0]?.q, "Keep this session.");
  assert.equal(read.anchors.length, 0);
  assert.equal(read.unanchoredCount, 1);
});

test("provider-start CAS rejects a line that became a chapter summary", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside summary CAS");
  const parent = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A prose parent."
  });
  const parentId = parent.path.at(-1)!.id;
  const take = await service.createNode(created.id, {
    parentId,
    instruction: "",
    text: "A take that will become a summary."
  });
  const takeId = take.path.at(-1)!.id;
  const { breakId } = await service.createChapterBreak(
    created.id,
    parentId,
    "A chapter",
    "summary-cas-break"
  );
  const anchor = { partId: takeId, takeId };
  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  let bound!: () => void;
  const boundP = new Promise<void>((resolve) => { bound = resolve; });
  let providerStarted = false;
  const ask = service.askAsideV2(
    created.id,
    { question: "Can this take answer?", anchor, sessionId: "summary-cas" },
    async () => {},
    new AbortController().signal,
    {
      bindIntent: async () => {
        bound();
        await bindGate;
      },
      providerStarted: async () => { providerStarted = true; }
    }
  );
  await boundP;
  await service.stories.withAggregateSession(created.id, async (session) => {
    const story = await session.loadLive();
    const node = story.nodes.find((candidate) => candidate.id === takeId);
    assert.ok(node !== undefined);
    node.role = "summary";
    node.chapterBreakId = breakId;
    node.coveredExtent = { fromPartId: parentId, toPartId: parentId };
    node.madeAt = new Date().toISOString();
    node.activeChildId = null;
    const parentNode = story.nodes.find((candidate) => candidate.id === parentId);
    assert.ok(parentNode !== undefined);
    parentNode.activeChildId = null;
    const replacement = await session.prepareContent(story, {
      asideActivation: service.stories.asideActivation
    });
    const manifest = reduceStoryV6(
      {
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: session.snapshot.manifestHash
      },
      {
        kind: "local-committed",
        expectedManifestHash: session.snapshot.manifestHash,
        content: replacement.content,
        summary: replacement.summary
      }
    );
    assert.ok(manifest !== null);
    await session.stageManifest(manifest);
    await session.publishStagedManifest();
  });
  releaseBind();
  await assert.rejects(ask, hasCode("conflict"));
  assert.equal(providerStarted, false);
  assert.equal((await service.getAsideV2(created.id)).sessions.length, 0);
});

test("legacy V1-to-V2 materialization keeps its V1 start CAS", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("V1 materialization CAS");
  const legacy = await service.askAside(
    created.id,
    { question: "Legacy?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(legacy !== null);

  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  let bound!: () => void;
  const boundP = new Promise<void>((resolve) => { bound = resolve; });
  const materialize = service.askAsideV2(
    created.id,
    { question: "Append legacy", anchor: null, sessionId: "legacy" },
    async () => {},
    new AbortController().signal,
    {
      bindIntent: async () => {
        bound();
        await bindGate;
      }
    }
  );
  await boundP;
  await service.clearAside(created.id);
  releaseBind();

  await assert.rejects(materialize, hasCode("conflict"));
  assert.equal((await service.getAsideV2(created.id, null)).sessions.length, 0);
});

test("reserved legacy session id cannot hide a later V1 Aside", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("V1 and V2 coexistence");
  const existing = await service.askAsideV2(
    created.id,
    { question: "Existing V2?", anchor: null, sessionId: "ordinary-v2" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(existing !== null);

  await assert.rejects(
    () => service.askAsideV2(
      created.id,
      { question: "Claim the reserved id", anchor: null, sessionId: "legacy" },
      async () => {},
      new AbortController().signal
    ),
    hasCode("invalid_request")
  );
  await assert.rejects(
    () => service.askAsideV2(
      created.id,
      {
        question: "Claim a hash-qualified legacy id",
        anchor: null,
        sessionId: `legacy-v1:${"a".repeat(64)}`
      },
      async () => {},
      new AbortController().signal
    ),
    hasCode("invalid_request")
  );

  const legacy = await service.askAside(
    created.id,
    { question: "Later V1?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(legacy !== null);
  const read = await service.getAsideV2(created.id, null);
  assert.deepEqual(
    read.sessions.map((session) => session.id).sort(),
    ["legacy", "ordinary-v2"]
  );
  assert.equal(read.sessions.find((session) => session.id === "legacy")?.turns.length, 1);
  assert.equal(read.sessions.find((session) => session.id === "ordinary-v2")?.turns.length, 1);
  assert.deepEqual(await service.getAside(created.id), legacy);
});

test("materialized legacy ref does not hide a later V1 append", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Materialized legacy ref");
  const initial = await service.askAside(
    created.id,
    { question: "Initial V1?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(initial !== null);
  const initialStory = await service.stories.load(created.id);
  const initialDocumentId = initialStory.asideDocumentId;
  assert.ok(initialDocumentId !== undefined && initialDocumentId !== null);

  const materialized = await service.askAsideV2(
    created.id,
    { question: "Materialized V2 append?", anchor: null, sessionId: "legacy" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(materialized !== null);
  const materializedStory = await service.stories.load(created.id);
  const materializedRef = [
    ...(materializedStory.asideSessionRefs ?? []),
    ...(materializedStory.asideUnanchoredSessionRefs ?? [])
  ].find((ref) => ref.id === "legacy");
  assert.ok(materializedRef !== undefined);
  assert.equal(materializedRef.sourceAsideDocumentId, initialDocumentId);

  const later = await service.askAside(
    created.id,
    { question: "Later V1 append?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(later !== null);
  const laterStory = await service.stories.load(created.id);
  const laterDocumentId = laterStory.asideDocumentId;
  assert.ok(laterDocumentId !== undefined && laterDocumentId !== null);
  assert.notEqual(laterDocumentId, initialDocumentId);
  const preservedRef = [
    ...(laterStory.asideSessionRefs ?? []),
    ...(laterStory.asideUnanchoredSessionRefs ?? [])
  ].find((ref) => ref.id === "legacy");
  assert.equal(preservedRef?.sourceAsideDocumentId, initialDocumentId);

  const read = await service.getAsideV2(created.id, null);
  const virtualId = `legacy-v1:${laterDocumentId}`;
  const materializedView = read.sessions.find((session) => session.id === "legacy");
  const virtualView = read.sessions.find((session) => session.id === virtualId);
  assert.ok(materializedView !== undefined);
  assert.ok(virtualView !== undefined);
  assert.ok(materializedView.turns.some((turn) => turn.q === "Materialized V2 append?"));
  assert.ok(virtualView.turns.some((turn) => turn.q === "Later V1 append?"));
  assert.equal(read.unanchoredCount, 2);
  const payload = await service.loadStory(created.id);
  assert.equal(payload.asidePresence?.unanchoredCount, 2);
  assert.deepEqual(await service.getAside(created.id), later);

  await assert.rejects(
    () => service.askAsideV2(
      created.id,
      { question: "Forged alias?", anchor: null, sessionId: `${virtualId}:v99` },
      async () => {},
      new AbortController().signal
    ),
    hasCode("invalid_request")
  );

  const olderDocument = await service.stories.readAsideSessionDocument(
    created.id,
    materializedRef.documentId
  );
  const appended = await service.askAsideV2(
    created.id,
    { question: "Append to visible V1 view?", anchor: null, sessionId: virtualId },
    async () => {},
    new AbortController().signal
  );
  assert.ok(appended !== null);
  assert.equal(appended.id, virtualId);

  const reset = await service.asideSessionMutation(created.id, {
    operation: "reset",
    sessionId: virtualId,
    turnIndex: 0,
    anchor: null
  });
  assert.equal(reset.id, virtualId);
  assert.equal(reset.turns.length, 1);
  const appendedAgain = await service.askAsideV2(
    created.id,
    { question: "Append before delete?", anchor: null, sessionId: virtualId },
    async () => {},
    new AbortController().signal
  );
  assert.ok(appendedAgain !== null);
  const deleted = await service.asideSessionMutation(created.id, {
    operation: "delete-turn",
    sessionId: virtualId,
    turnIndex: 1,
    anchor: null
  });
  assert.equal(deleted.id, virtualId);
  assert.equal(deleted.turns.length, 1);
  const cleared = await service.asideSessionMutation(created.id, {
    operation: "clear",
    sessionId: virtualId,
    anchor: null
  });
  assert.equal(cleared.id, virtualId);
  assert.equal(cleared.turns.length, 0);

  const after = await service.getAsideV2(created.id, null);
  assert.equal(after.sessions.find((session) => session.id === "legacy")?.turns.length,
    olderDocument.turns.length);
  assert.equal(after.sessions.find((session) => session.id === virtualId)?.turns.length, 0);
  assert.deepEqual(
    await service.stories.readAsideSessionDocument(created.id, materializedRef.documentId),
    olderDocument
  );
  assert.deepEqual(await service.getAside(created.id), later);

  const olderAppend = await service.askAsideV2(
    created.id,
    { question: "Append to older materialized view?", anchor: null, sessionId: "legacy" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(olderAppend !== null);
  assert.equal(olderAppend.payload?.asidePresence?.unanchoredCount, 2);
});

test("v2 read keeps session refs and documents on one aggregate snapshot", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Consistent Aside read");
  const first = await service.askAsideV2(
    created.id,
    { question: "First?", anchor: null, sessionId: "first" },
    async () => {},
    new AbortController().signal
  );
  const second = await service.askAsideV2(
    created.id,
    { question: "Second?", anchor: null, sessionId: "second" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(first !== null && second !== null);

  const readDocument = StoryAggregateSession.prototype.readAsideSessionDocument;
  let firstDocument = true;
  let resolveFirstDocumentStarted!: () => void;
  const firstDocumentStarted = new Promise<void>((resolve) => {
    resolveFirstDocumentStarted = resolve;
  });
  let releaseFirstDocument!: () => void;
  const firstDocumentGate = new Promise<void>((resolve) => {
    releaseFirstDocument = resolve;
  });
  StoryAggregateSession.prototype.readAsideSessionDocument = async function (documentId) {
    const document = await readDocument.call(this, documentId);
    if (firstDocument) {
      firstDocument = false;
      resolveFirstDocumentStarted();
      await firstDocumentGate;
    }
    return document;
  };
  t.after(() => {
    releaseFirstDocument();
    StoryAggregateSession.prototype.readAsideSessionDocument = readDocument;
  });

  const read = service.getAsideV2(created.id, null);
  await firstDocumentStarted;
  let clearSettled = false;
  const clear = service.asideSessionMutation(created.id, {
    operation: "clear",
    sessionId: "second",
    anchor: null
  }).then(async (result) => {
    clearSettled = true;
    await service.stories.waitForMaintenance();
    return result;
  }, (error: unknown) => {
    clearSettled = true;
    throw error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clearSettled, false, "clear must wait for the claimed read");
  releaseFirstDocument();
  const outcome = await read;
  assert.equal(outcome.sessions.length, 2);
  assert.deepEqual(
    outcome.sessions.map((session) => session.id).sort(),
    ["first", "second"]
  );
  assert.equal(outcome.unanchoredCount, 2);
  assert.equal(outcome.sessions.find((session) => session.id === "first")?.turns.length, 1);
  assert.equal(outcome.sessions.find((session) => session.id === "second")?.turns.length, 1);

  const cleared = await clear;
  assert.equal(cleared.turns.length, 0);
});

test("retake streams reasoning and replaces the same last turn", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("v2 retake");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A bell rang."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const answer = await service.askAsideV2(
    created.id,
    { question: "Why?", anchor, sessionId: "retake" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(answer !== null);
  const oldAnswer = answer.turns[0]!.a;
  const prose: string[] = [];
  const thoughts: string[] = [];
  const retaken = await service.retakeAside(
    created.id,
    { sessionId: answer.id, turnIndex: 0, anchor },
    async (delta) => { prose.push(delta); },
    new AbortController().signal,
    { onReasoning: (delta) => { thoughts.push(delta.text); } }
  );
  assert.ok(retaken !== null);
  assert.equal(retaken.id, answer.id);
  assert.equal(retaken.turns.length, 1);
  assert.equal(retaken.turns[0]!.q, "Why?");
  assert.equal(retaken.turns[0]!.a, oldAnswer);
  assert.ok(prose.join("").length > 0);
  assert.ok(thoughts.join("").length > 0);
  assert.equal((await service.getAsideV2(created.id, anchor)).sessions[0]!.turns.length, 1);

  const reprompted = await service.retakeAside(
    created.id,
    { sessionId: answer.id, turnIndex: 0, anchor, question: "What rang?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(reprompted !== null);
  assert.equal(reprompted.turns.length, 1);
  assert.equal(reprompted.turns[0]!.q, "What rang?");
  assert.equal(reprompted.title, "What rang?");
});

test("retake prompt excludes the replaced turn and its stored thoughts", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("v2 retake prompt");
  const node = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A bell rang."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const earlier = await service.askAsideV2(
    created.id,
    { question: "EARLIER_QUESTION", anchor, sessionId: "prompt-test" },
    async () => {},
    new AbortController().signal
  );
  const existing = await service.askAsideV2(
    created.id,
    { question: "OLD_RETAKE_QUESTION", anchor, sessionId: "prompt-test" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(earlier !== null && existing !== null);
  const oldThought = existing.turns.at(-1)?.thoughts;
  assert.ok(oldThought !== undefined);

  let invalidProviderStarted = false;
  await assert.rejects(
    service.retakeAside(
      created.id,
      {
        sessionId: "prompt-test",
        turnIndex: 0,
        anchor,
        question: "INVALID_EARLIER_REPROMPT"
      },
      async () => {},
      new AbortController().signal,
      {
        providerStarted: async () => { invalidProviderStarted = true; }
      }
    ),
    hasCode("conflict")
  );
  assert.equal(invalidProviderStarted, false);

  let prompt = "";
  const retaken = await service.retakeAside(
    created.id,
    { sessionId: "prompt-test", turnIndex: 1, anchor },
    async () => {},
    new AbortController().signal,
    {
      bindIntent: async (_settings, intent) => {
        const captured = intent as {
          readonly messages: readonly { readonly content: string }[];
        };
        prompt = captured.messages.map((message) => message.content).join("\n");
      }
    }
  );
  assert.ok(retaken !== null);
  assert.match(prompt, /EARLIER_QUESTION/u);
  assert.match(prompt, new RegExp(escapeRegExp(earlier.turns[0]!.a), "u"));
  assert.equal(
    [...prompt.matchAll(/OLD_RETAKE_QUESTION/gu)].length,
    1,
    "the retaken question remains only as the current instruction"
  );
  assert.doesNotMatch(prompt, new RegExp(escapeRegExp(existing.turns.at(-1)!.a), "u"));
  assert.doesNotMatch(prompt, new RegExp(escapeRegExp(oldThought), "u"));
});

test("anchored Aside prompt stops at a non-leaf anchor", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("v2 anchored prompt");
  const root = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "ANCHOR_ROOT_ONLY"
  });
  const anchorId = root.path.at(-1)!.id;
  await service.createNode(created.id, {
    parentId: anchorId,
    instruction: "",
    text: "DESCENDANT_AFTER_ANCHOR"
  });

  let prompt = "";
  const answer = await service.askAsideV2(
    created.id,
    {
      question: "ANCHOR_PROMPT_QUESTION",
      anchor: { partId: anchorId, takeId: anchorId },
      sessionId: "non-leaf-anchor"
    },
    async () => {},
    new AbortController().signal,
    {
      bindIntent: async (_settings, intent) => {
        const captured = intent as {
          readonly messages: readonly { readonly content: string }[];
        };
        prompt = captured.messages.map((message) => message.content).join("\n");
      }
    }
  );

  assert.ok(answer !== null);
  assert.match(prompt, /ANCHOR_ROOT_ONLY/u);
  assert.doesNotMatch(prompt, /DESCENDANT_AFTER_ANCHOR/u);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
