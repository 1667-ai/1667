import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import { RETAKE_GONE_TOAST, type DraftHandle } from "../web/src/generation/actions.js";
import { manuscriptGenerationView } from "../web/src/generation/state.js";
import {
  STORY_ID,
  connectedState,
  createActionsForStore,
  deferred,
  fakeApi,
  linearPayload,
  plainFailure,
  providerFailure,
  storeOpenOn,
  toasts,
  waitFor
} from "./web-story-fixtures.js";

/**
 * The writing loop's composer side (#409 step 6): a typed direction and a
 * retake ride through `generation.continue`, and the writer's draft is
 * settled exactly once per run — restored on every failure, cleared when the
 * take lands. This file drives the REAL app actions over a fake `StoryApi`.
 */

/** A draft handle that only records what the run did with it. */
function spyDraft(options: { readonly throwOnRestore?: boolean } = {}): DraftHandle & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    restore: () => {
      calls.push("restore");
      if (options.throwOnRestore === true) throw new Error("restore blew up");
    },
    clear: () => {
      calls.push("clear");
    }
  };
}

function open(payload: StoryPayload, focused: string | null, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, focused);
  const fake = fakeApi(apiOptions);
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions, scheduler } = createActionsForStore(store);
  return { store, fake, actions, scheduler };
}

// ---------------------------------------------------------------------------
// Direct: the typed direction.
// ---------------------------------------------------------------------------

test("a typed direction goes on the wire as typed and always opens a take", async () => {
  const payload = linearPayload(["a1", "b1"]);
  const { actions, fake } = open(payload, "b1");

  await actions.generation.continue({ instruction: "  She turns around.  " });

  assert.equal(fake.continueCalls.length, 1);
  assert.equal(fake.continueCalls[0]!.instruction, "  She turns around.  ");
  assert.deepEqual(fake.continueCalls[0]!.target, { parentId: "b1" });
});

test("a stopped Direct take saves the trimmed direction as its instruction", async () => {
  const payload = linearPayload(["a1", "b1"]);
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake } = open(payload, "b1", {
    continueStory: () => gate.promise,
    createNode: async () => linearPayload(["a1", "b1", "c1"])
  });
  const draft = spyDraft();

  const run = actions.generation.continue({ instruction: "  She turns around.  ", draft });
  await waitFor(() => fake.continueCalls.length === 1);
  fake.continueCalls[0]!.onDelta("She did.");
  actions.generation.stop();
  gate.resolve(null);
  await run;

  assert.equal(fake.createNodeCalls.length, 1);
  assert.deepEqual(fake.createNodeCalls[0]!.body, {
    parentId: "b1",
    instruction: "She turns around.",
    text: "She did.",
    genId: fake.continueCalls[0]!.genId
  });
  assert.deepEqual(draft.calls, ["clear"]);
});

// ---------------------------------------------------------------------------
// Draft lifecycle: exactly once, restore on failure, clear on landing.
// ---------------------------------------------------------------------------

test("a landed take clears the draft once", async () => {
  const { actions } = open(linearPayload(["a1", "b1"]), "b1");
  const draft = spyDraft();

  await actions.generation.continue({ instruction: "go", draft });

  assert.deepEqual(draft.calls, ["clear"]);
});

test("a provider rejection reloads the story and restores the draft", async () => {
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: (_s, _i, _g, _t, onDelta) => {
      onDelta("refused prose");
      return Promise.reject(providerFailure("The model refused this request."));
    }
  });
  const draft = spyDraft();

  await actions.generation.continue({ instruction: "go", draft });

  assert.deepEqual(draft.calls, ["restore"]);
  assert.equal(fake.loadStoryCalls.length, 1);
  assert.equal(fake.createNodeCalls.length, 0);
  assert.ok(toasts(store).some((message) => message.includes("The model refused this request.")));
});

test("an empty Stop restores the draft and saves nothing", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake } = open(linearPayload(["a1", "b1"]), "b1", { continueStory: () => gate.promise });
  const draft = spyDraft();

  const run = actions.generation.continue({ instruction: "go", draft });
  await waitFor(() => fake.continueCalls.length === 1);
  actions.generation.stop();
  gate.resolve(null);
  await run;

  assert.deepEqual(draft.calls, ["restore"]);
  assert.equal(fake.createNodeCalls.length, 0);
});

test("a revision_conflict at admission reloads and restores the draft", async () => {
  const reloaded = linearPayload(["a1", "b1", "c1"]);
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(plainFailure("revision_conflict", "stale")),
    loadStory: async () => reloaded
  });
  const draft = spyDraft();

  await actions.generation.continue({ instruction: "go", draft });

  assert.deepEqual(draft.calls, ["restore"]);
  assert.equal(fake.loadStoryCalls.length, 1);
  const story = store.get().story;
  assert.equal(story.kind === "loaded" ? story.payload : null, reloaded);
});

test("resource_busy is retried, and the take then lands: the draft clears once", { timeout: 5_000 }, async () => {
  let attempts = 0;
  const { actions } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(plainFailure("resource_busy", "busy"));
      return Promise.resolve({ payload: linearPayload(["a1", "b1", "c1"]) });
    }
  });
  const draft = spyDraft();

  await actions.generation.continue({ instruction: "go", draft });

  assert.equal(attempts, 2);
  assert.deepEqual(draft.calls, ["clear"]);
});

test("a final resource_busy restores the draft", { timeout: 5_000 }, async () => {
  const { actions, store } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(plainFailure("resource_busy", "busy"))
  });
  const draft = spyDraft();

  await actions.generation.continue({ instruction: "go", draft });

  assert.deepEqual(draft.calls, ["restore"]);
  assert.deepEqual(toasts(store), ["Another window is writing in this story."]);
});

test("a refusal because a run is already live restores the draft and keeps the run", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", { continueStory: () => gate.promise });

  const first = actions.generation.continue({ instruction: "one" });
  await waitFor(() => fake.continueCalls.length === 1);
  const draft = spyDraft();
  await actions.generation.continue({ instruction: "two", draft });

  assert.deepEqual(draft.calls, ["restore"]);
  assert.equal(fake.continueCalls.length, 1);
  assert.equal(store.get().generation.kind, "running");
  gate.resolve({ payload: linearPayload(["a1", "b1", "c1"]) });
  await first;
});

test("not connected: the draft comes back and nothing starts", async () => {
  const { actions, store, fake } = open(linearPayload(["a1", "b1"]), "b1");
  store.set((state) => ({ ...state, connection: { kind: "connecting" } }));
  const draft = spyDraft();

  await actions.generation.continue({ instruction: "go", draft });

  assert.deepEqual(draft.calls, ["restore"]);
  assert.equal(fake.continueCalls.length, 0);
});

test("a failed save keeps the text unsaved and restores the draft; a later retry that lands clears it", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  let saves = 0;
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => gate.promise,
    createNode: async () => {
      saves += 1;
      if (saves === 1) throw new Error("disk full");
      return linearPayload(["a1", "b1", "c1"]);
    }
  });
  const draft = spyDraft();

  const run = actions.generation.continue({ instruction: "go", draft });
  await waitFor(() => fake.continueCalls.length === 1);
  fake.continueCalls[0]!.onDelta("Prose that failed to save.");
  actions.generation.stop();
  gate.resolve(null);
  await run;

  assert.equal(store.get().generation.kind, "unsaved");
  assert.deepEqual(draft.calls, ["restore"]);

  await actions.generation.retrySave();

  assert.equal(store.get().generation.kind, "idle");
  assert.deepEqual(draft.calls, ["restore", "clear"]);
});

test("a throwing restore does not break the run", async () => {
  const { actions, store } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(providerFailure("refused"))
  });
  const draft = spyDraft({ throwOnRestore: true });

  await actions.generation.continue({ instruction: "go", draft });

  assert.deepEqual(draft.calls, ["restore"]);
  assert.equal(store.get().generation.kind, "idle");
  assert.ok(toasts(store).includes("refused"));
});

// ---------------------------------------------------------------------------
// Retake.
// ---------------------------------------------------------------------------

test("retake opens a sibling take: parentId, the old direction, and the part's own number", async () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(payload, "b1", { continueStory: () => gate.promise });

  const run = actions.generation.continue({ instruction: "Go left.", retakeOf: "b1" });
  await waitFor(() => fake.continueCalls.length === 1);

  assert.deepEqual(fake.continueCalls[0]!.target, { parentId: "a1" });
  assert.equal(fake.continueCalls[0]!.instruction, "Go left.");
  const view = manuscriptGenerationView(store.get().generation, STORY_ID);
  assert.equal(view?.mode, "take");
  assert.equal(view?.seamPathIndex, 0, "the seam sits above the retaken part");
  assert.equal(view?.partNumber, 2, "the streaming take shows the retaken part's number");
  gate.resolve({ payload: linearPayload(["a1", "b2"]) });
  await run;
});

test("retaking the first part opens a root take", async () => {
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "a1", {
    continueStory: () => new Promise(() => {})
  });

  void actions.generation.continue({ instruction: "", retakeOf: "a1" });
  await waitFor(() => fake.continueCalls.length === 1);

  assert.deepEqual(fake.continueCalls[0]!.target, { parentId: null });
  const view = manuscriptGenerationView(store.get().generation, STORY_ID);
  assert.equal(view?.seamPathIndex, -1);
  assert.equal(view?.partNumber, 1);
});

test("a retake that is stopped saves the take under the retaken part's parent", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake } = open(
    linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } }),
    "b1",
    { continueStory: () => gate.promise, createNode: async () => linearPayload(["a1", "b2"]) }
  );

  const run = actions.generation.continue({ instruction: "Go left.", retakeOf: "b1" });
  await waitFor(() => fake.continueCalls.length === 1);
  fake.continueCalls[0]!.onDelta("A different take.");
  actions.generation.stop();
  gate.resolve(null);
  await run;

  assert.equal(fake.createNodeCalls.length, 1);
  assert.deepEqual(fake.createNodeCalls[0]!.body, {
    parentId: "a1",
    instruction: "Go left.",
    text: "A different take.",
    genId: fake.continueCalls[0]!.genId
  });
});

test("retake refuses a summary and a part that left the line, and gives the draft back", async () => {
  const payload = linearPayload(["a1", "s1"], { nodeOverrides: { s1: { role: "summary" } } });
  const { actions, fake, store } = open(payload, "s1");
  const summaryDraft = spyDraft();
  const goneDraft = spyDraft();

  await actions.generation.continue({ instruction: "x", retakeOf: "s1", draft: summaryDraft });
  await actions.generation.continue({ instruction: "x", retakeOf: "gone", draft: goneDraft });

  assert.deepEqual(summaryDraft.calls, ["restore"]);
  assert.deepEqual(goneDraft.calls, ["restore"]);
  assert.equal(fake.continueCalls.length, 0);
  assert.deepEqual(toasts(store), [RETAKE_GONE_TOAST, RETAKE_GONE_TOAST]);
});
