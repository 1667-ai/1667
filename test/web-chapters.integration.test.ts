import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import {
  STORY_ID,
  connectedState,
  createActionsForStore,
  deferred,
  fakeApi,
  linearPayload,
  lostAnswer,
  plainFailure,
  providerFailure,
  storeOpenOn,
  toasts,
  waitFor
} from "./web-story-fixtures.js";

/**
 * Chapter breaks, summaries, and tags over a fake `StoryApi` (#409 step 7a):
 * only what a browser test cannot reach — a lost answer, a rejected provider
 * call, a busy refusal, a summary that lands after Stop. Real app actions.
 */

const BREAK = { id: "br1", parentPartId: "b", title: "Second", createdAt: new Date(0).toISOString() };

const PLAIN = linearPayload(["a", "b", "c"]);
const WITH_BREAK = linearPayload(["a", "b", "c"], { chapterBreaks: [BREAK] });

function open(payload: StoryPayload, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, "b");
  const fake = fakeApi(apiOptions);
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions } = createActionsForStore(store);
  return { store, fake, actions };
}

function openPayload(store: ReturnType<typeof open>["store"]): StoryPayload {
  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  return story.kind === "loaded" ? story.payload : PLAIN;
}

test("a break whose answer was lost is found by the reload: counted once, and u can take it back", async () => {
  const removed: string[] = [];
  const { actions, fake, store } = open(PLAIN, {
    loadStory: async () => WITH_BREAK,
    methods: {
      createChapterBreak: async () => { throw lostAnswer(); },
      removeChapterBreak: async (_storyId: string, breakId: string) => {
        removed.push(breakId);
        return { payload: PLAIN, removed: {} };
      }
    }
  });

  await actions.chapters.addBreak("b");
  assert.equal(fake.calls.filter((name) => name === "createChapterBreak").length, 1);
  assert.equal(openPayload(store).chapterBreaks.length, 1);
  assert.deepEqual(store.get().chapters.undo[STORY_ID], [{ kind: "added", breakId: "br1" }]);

  await actions.chapters.undo();
  assert.deepEqual(removed, ["br1"]);
  assert.equal(openPayload(store).chapterBreaks.length, 0);
  assert.deepEqual(store.get().chapters.undo[STORY_ID], []);
});

test("a removal whose answer was lost is found by the reload: no undo entry, and the toast says so", async () => {
  const { actions, store } = open(WITH_BREAK, {
    loadStory: async () => PLAIN,
    methods: { removeChapterBreak: async () => { throw lostAnswer(); } }
  });

  await actions.chapters.removeBreak("br1");
  assert.equal(openPayload(store).chapterBreaks.length, 0);
  assert.equal(store.get().chapters.undo[STORY_ID], undefined);
  assert.ok(toasts(store).includes("Removed. This one cannot be undone."));
});

test("a rejected summary reloads the story, and the next rename is built on the fresh version", async () => {
  const fresh = linearPayload(["a", "b", "c"], { chapterBreaks: [BREAK] });
  const order: string[] = [];
  const { actions, store } = open(WITH_BREAK, {
    loadStory: async () => { order.push("load"); return fresh; },
    methods: {
      summarizeChapter: async () => { order.push("summarize"); throw providerFailure("The model refused."); },
      renameChapterBreak: async () => { order.push("rename"); return fresh; }
    }
  });

  await actions.chapters.summarize(1);
  assert.deepEqual(order, ["summarize", "load"]);
  assert.equal(openPayload(store), fresh);
  assert.ok(toasts(store).includes("The model refused."));
  assert.equal(store.get().chapters.summaryRun, null);

  actions.chapters.startRename("br1", "manuscript");
  actions.chapters.setRenameText("Third");
  await actions.chapters.saveRename();
  assert.deepEqual(order, ["summarize", "load", "rename"]);
});

test("a busy refusal is retried for a summary and for a tag", async () => {
  let summaries = 0;
  let tags = 0;
  const { actions, store } = open(WITH_BREAK, {
    methods: {
      summarizeChapter: async () => {
        summaries += 1;
        if (summaries === 1) throw plainFailure("resource_busy", "busy");
        return WITH_BREAK;
      },
      putBookmark: async () => {
        tags += 1;
        if (tags === 1) throw plainFailure("resource_busy", "busy");
        return WITH_BREAK;
      }
    }
  });

  await actions.chapters.summarize(1);
  assert.equal(summaries, 2);
  assert.ok(toasts(store).includes("Chapter One summarized."));

  actions.tags.openForPart("c");
  actions.tags.setName("Ending");
  await actions.tags.save();
  assert.equal(tags, 2);
  assert.equal(store.get().tags.open, null);
});

test("a busy refusal after Stop is not retried", async () => {
  let summaries = 0;
  const first = deferred<StoryPayload>();
  const { actions, store } = open(WITH_BREAK, {
    loadStory: async () => WITH_BREAK,
    methods: {
      summarizeChapter: async () => {
        summaries += 1;
        return await first.promise;
      }
    }
  });

  const run = actions.chapters.summarize(1);
  await waitFor(() => summaries === 1);
  assert.equal(actions.chapters.stopSummary(), true);
  first.reject(plainFailure("resource_busy", "busy"));
  await run;
  assert.equal(summaries, 1);
  assert.ok(toasts(store).includes("Chapter One summary stopped."));
  assert.equal(store.get().chapters.summaryRun, null);
});

test("a summary that arrives after Stop is kept and says it completed before the stop", async () => {
  const done = deferred<StoryPayload>();
  const { actions, store } = open(WITH_BREAK, { methods: { summarizeChapter: () => done.promise } });

  const run = actions.chapters.summarize(1);
  await waitFor(() => store.get().chapters.summaryRun !== null);
  actions.chapters.stopSummary();
  assert.equal(store.get().chapters.summaryRun?.phase, "stopping");
  done.resolve(WITH_BREAK);
  await run;
  assert.ok(toasts(store).includes("Chapter One summary completed before stop."));
  assert.equal(store.get().chapters.summaryRun, null);
});
