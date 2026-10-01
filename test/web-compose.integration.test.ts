import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import { RETAKE_GONE_TOAST, type DraftHandle } from "../web/src/generation/actions.js";
import { composeDraftOf } from "../web/src/compose/state.js";
import { manuscriptGenerationView } from "../web/src/generation/state.js";
import { STORY_LOCKED_TOAST } from "../web/src/story/actions.js";
import { PART_SWITCHING_TOAST } from "../web/src/story/part-guard.js";
import { SUMMARY_RETAKE_TOAST } from "../web/src/story/part-actions.js";
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

// ---------------------------------------------------------------------------
// `r`: the instant retake.
// ---------------------------------------------------------------------------

test("r retakes the part with its own direction and moves focus onto it first", async () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const { actions, fake, store } = open(payload, "c1", { continueStory: () => new Promise(() => {}) });

  actions.part.retake("b1");
  await waitFor(() => fake.continueCalls.length === 1);

  assert.equal(fake.continueCalls[0]!.instruction, "Go left.");
  assert.deepEqual(fake.continueCalls[0]!.target, { parentId: "a1" });
  const story = store.get().story;
  assert.equal(story.kind === "loaded" ? story.focusedPartId : null, "b1");
});

test("r refuses a summary", async () => {
  const payload = linearPayload(["a1", "s1"], { nodeOverrides: { s1: { role: "summary" } } });
  const { actions, fake, store } = open(payload, "s1");

  actions.part.retake("s1");

  assert.deepEqual(toasts(store), [SUMMARY_RETAKE_TOAST]);
  assert.equal(fake.continueCalls.length, 0);
});

test("r is refused while this story writes, and while a take switch is in flight", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(linearPayload(["a1", "b1", "c1"]), "b1", { continueStory: () => gate.promise });
  const run = actions.generation.continue();
  await waitFor(() => fake.continueCalls.length === 1);

  actions.part.retake("b1");

  assert.deepEqual(toasts(store), [STORY_LOCKED_TOAST]);
  assert.equal(fake.continueCalls.length, 1);
  gate.resolve({ payload: linearPayload(["a1", "b1", "c1"]) });
  await run;

  store.set((state) => state.story.kind === "loaded"
    ? { ...state, toasts: [], story: { ...state.story, switching: { partId: "a1", targetId: "a2" } } }
    : state);
  actions.part.retake("b1");

  assert.deepEqual(toasts(store), [PART_SWITCHING_TOAST]);
  assert.equal(fake.continueCalls.length, 1);
});

// ---------------------------------------------------------------------------
// The composer itself: real compose actions, real draft handles.
// ---------------------------------------------------------------------------

function draftOf(store: ReturnType<typeof open>["store"]) {
  return composeDraftOf(store.get().compose, STORY_ID);
}

test("Enter sends the typed direction: raw on the wire, a take of the next part, the box cleared, the text in the history", async () => {
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1");
  actions.compose.setText(STORY_ID, "  She turns around.  ");

  assert.equal(actions.compose.submit(STORY_ID), true);
  await waitFor(() => fake.continueCalls.length === 1);

  assert.equal(fake.continueCalls[0]!.instruction, "  She turns around.  ");
  assert.deepEqual(fake.continueCalls[0]!.target, { parentId: "b1" });
  assert.equal(draftOf(store).direct, "", "the box is emptied the moment it is sent");
  assert.deepEqual(store.get().compose.history, ["  She turns around.  "]);
  await waitFor(() => store.get().generation.kind === "idle");
  assert.equal(draftOf(store).direct, "", "a landed take leaves the box empty");
});

test("an empty box is a plain Continue and adds nothing to the history", async () => {
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1");

  assert.equal(actions.compose.submit(STORY_ID), true);
  await waitFor(() => fake.continueCalls.length === 1);

  assert.equal(fake.continueCalls[0]!.instruction, "");
  assert.equal(fake.continueCalls[0]!.target.appendTo, "b1");
  assert.deepEqual(store.get().compose.history, []);
});

test("a send while this story writes is refused with a toast and the draft stays in the box", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", { continueStory: () => gate.promise });
  const first = actions.generation.continue();
  await waitFor(() => fake.continueCalls.length === 1);
  actions.compose.setText(STORY_ID, "next direction");

  assert.equal(actions.compose.submit(STORY_ID), false);

  assert.equal(draftOf(store).direct, "next direction");
  assert.deepEqual(toasts(store), [`${STORY_LOCKED_TOAST} Draft kept.`]);
  assert.deepEqual(store.get().compose.history, []);
  gate.resolve({ payload: linearPayload(["a1", "b1"]) });
  await first;
});

test("a provider rejection puts the sent text back, but never over text typed meanwhile", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", { continueStory: () => gate.promise });
  actions.compose.setText(STORY_ID, "first try");
  actions.compose.submit(STORY_ID);
  await waitFor(() => fake.continueCalls.length === 1);

  gate.reject(providerFailure("The model refused this request."));
  await waitFor(() => store.get().generation.kind === "idle");
  assert.equal(draftOf(store).direct, "first try", "an untouched box gets the sent text back");
  assert.equal(fake.loadStoryCalls.length, 1, "the story is reloaded after the failure");

  const gate2 = deferred<{ payload: StoryPayload } | null>();
  (fake.api as { continueStory: unknown }).continueStory = async () => gate2.promise;
  actions.compose.submit(STORY_ID);
  await waitFor(() => store.get().generation.kind === "running");
  actions.compose.setText(STORY_ID, "something newer");
  gate2.reject(providerFailure("refused again"));
  await waitFor(() => store.get().generation.kind === "idle");

  assert.equal(draftOf(store).direct, "something newer");
  assert.ok(store.get().compose.history.includes("first try"), "the dropped text is still in the history");
});

test("an empty Stop returns the sent text; a Stop with prose saves the trimmed direction and clears", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => gate.promise,
    createNode: async () => linearPayload(["a1", "b1", "c1"])
  });
  actions.compose.setText(STORY_ID, "  go left  ");
  actions.compose.submit(STORY_ID);
  await waitFor(() => fake.continueCalls.length === 1);
  actions.generation.stop();
  gate.resolve(null);
  await waitFor(() => store.get().generation.kind === "idle");
  assert.equal(draftOf(store).direct, "  go left  ");
  assert.equal(fake.createNodeCalls.length, 0);

  const gate2 = deferred<{ payload: StoryPayload } | null>();
  (fake.api as { continueStory: unknown }).continueStory = async (
    _s: string, _i: string, _g: string, _t: unknown, onDelta: (text: string) => void
  ) => {
    onDelta("Left it was.");
    return gate2.promise;
  };
  actions.compose.submit(STORY_ID);
  await waitFor(() => store.get().generation.kind === "running");
  actions.generation.stop();
  gate2.resolve(null);
  await waitFor(() => store.get().generation.kind === "idle");

  assert.equal(fake.createNodeCalls.length, 1);
  assert.equal((fake.createNodeCalls[0]!.body as { instruction: string }).instruction, "go left");
  assert.equal(draftOf(store).direct, "", "a saved stop clears the box");
});

test("a retried save that lands clears the restored text only when it is unchanged", async () => {
  async function runCase(typedAfter: string | null): Promise<string> {
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
    actions.compose.setText(STORY_ID, "go left");
    actions.compose.submit(STORY_ID);
    await waitFor(() => fake.continueCalls.length === 1);
    fake.continueCalls[0]!.onDelta("Prose.");
    actions.generation.stop();
    gate.resolve(null);
    await waitFor(() => store.get().generation.kind === "unsaved");
    assert.equal(draftOf(store).direct, "go left");
    if (typedAfter !== null) actions.compose.setText(STORY_ID, typedAfter);
    await actions.generation.retrySave();
    return draftOf(store).direct;
  }

  assert.equal(await runCase(null), "", "unchanged restored text is cleared by the landing");
  assert.equal(await runCase("go left, then right"), "go left, then right", "text the writer changed is kept");
});

test("a revision_conflict at admission reloads and returns the sent text; resource_busy is retried and then lands", { timeout: 8_000 }, async () => {
  const conflict = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(plainFailure("revision_conflict", "stale")),
    loadStory: async () => linearPayload(["a1", "b1", "c1"])
  });
  conflict.actions.compose.setText(STORY_ID, "go");
  conflict.actions.compose.submit(STORY_ID);
  await waitFor(() => conflict.fake.loadStoryCalls.length === 1 && conflict.store.get().generation.kind === "idle");
  assert.equal(draftOf(conflict.store).direct, "go");

  let attempts = 0;
  const busy = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(plainFailure("resource_busy", "busy"))
        : Promise.resolve({ payload: linearPayload(["a1", "b1", "c1"]) });
    }
  });
  busy.actions.compose.setText(STORY_ID, "go");
  busy.actions.compose.submit(STORY_ID);
  await waitFor(() => attempts === 2 && busy.store.get().generation.kind === "idle");
  assert.equal(draftOf(busy.store).direct, "");
});

// ---------------------------------------------------------------------------
// Retake mode (R).
// ---------------------------------------------------------------------------

test("R opens retake mode filled with the part's direction and sets the Direct draft aside", () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const { actions, store } = open(payload, "c1");
  actions.compose.setText(STORY_ID, "my direct draft");

  actions.compose.startRetake("b1");

  const draft = draftOf(store);
  assert.deepEqual(draft.retake, { nodeId: "b1", text: "Go left." });
  assert.equal(draft.direct, "my direct draft");
  assert.equal(store.get().compose.focusRequest, 1);
  actions.compose.setText(STORY_ID, "Go right.");
  assert.equal(draftOf(store).retake?.text, "Go right.");
  assert.equal(draftOf(store).direct, "my direct draft", "typing in retake mode never touches the Direct text");
});

test("Escape in retake mode brings the Direct draft back and keeps a changed direction in the history", () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const { actions, store } = open(payload, "b1");
  actions.compose.setText(STORY_ID, "direct");
  actions.compose.startRetake("b1");
  actions.compose.setText(STORY_ID, "Go right.");

  actions.compose.cancelRetake(STORY_ID);

  assert.equal(draftOf(store).retake, null);
  assert.equal(draftOf(store).direct, "direct");
  assert.deepEqual(store.get().compose.history, ["Go right."]);
});

test("a retake send uses the typed direction, sets retakeOf, and a Direct draft comes back in the box", async () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const { actions, fake, store } = open(payload, "c1");
  actions.compose.setText(STORY_ID, "direct draft");
  actions.compose.startRetake("b1");
  actions.compose.setText(STORY_ID, "Go right.");

  assert.equal(actions.compose.submit(STORY_ID), true);
  await waitFor(() => fake.continueCalls.length === 1);

  assert.equal(fake.continueCalls[0]!.instruction, "Go right.");
  assert.deepEqual(fake.continueCalls[0]!.target, { parentId: "a1" });
  assert.equal(draftOf(store).retake, null);
  assert.equal(draftOf(store).direct, "direct draft");
  await waitFor(() => store.get().generation.kind === "idle");
  assert.equal(draftOf(store).retake, null, "a landed retake leaves retake mode closed");
});

test("a failed retake goes back into retake mode, unless the Direct text changed meanwhile", async () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(payload, "b1", {
    continueStory: () => gate.promise,
    loadStory: async () => payload
  });
  actions.compose.startRetake("b1");
  actions.compose.setText(STORY_ID, "Go right.");
  actions.compose.submit(STORY_ID);
  await waitFor(() => fake.continueCalls.length === 1);
  gate.reject(providerFailure("refused"));
  await waitFor(() => store.get().generation.kind === "idle");
  assert.deepEqual(draftOf(store).retake, { nodeId: "b1", text: "Go right." });

  const gate2 = deferred<{ payload: StoryPayload } | null>();
  (fake.api as { continueStory: unknown }).continueStory = async () => gate2.promise;
  actions.compose.submit(STORY_ID);
  await waitFor(() => store.get().generation.kind === "running");
  actions.compose.setText(STORY_ID, "typed while it ran");
  gate2.reject(providerFailure("refused again"));
  await waitFor(() => store.get().generation.kind === "idle");

  assert.equal(draftOf(store).retake, null);
  assert.equal(draftOf(store).direct, "typed while it ran");
});

test("a retake whose part left the line is refused and the draft stays", () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const { actions, store, fake } = open(payload, "b1");
  actions.compose.startRetake("b1");
  actions.compose.setText(STORY_ID, "Go right.");
  store.set((state) => state.story.kind === "loaded"
    ? { ...state, story: { ...state.story, payload: linearPayload(["a1", "x1"]) } }
    : state);

  assert.equal(actions.compose.submit(STORY_ID), false);

  assert.equal(draftOf(store).retake?.text, "Go right.");
  assert.deepEqual(toasts(store), [RETAKE_GONE_TOAST]);
  assert.equal(fake.continueCalls.length, 0);
});

test("R refuses a summary", () => {
  const payload = linearPayload(["a1", "s1"], { nodeOverrides: { s1: { role: "summary" } } });
  const { actions, store } = open(payload, "s1");

  actions.compose.startRetake("s1");

  assert.equal(draftOf(store).retake, null);
  assert.deepEqual(toasts(store), [SUMMARY_RETAKE_TOAST]);
});

// ---------------------------------------------------------------------------
// History.
// ---------------------------------------------------------------------------

test("history walks sent directions and keeps the unsent text", async () => {
  const { actions, store } = open(linearPayload(["a1", "b1"]), "b1");
  for (const text of ["one", "two"]) {
    actions.compose.setText(STORY_ID, text);
    actions.compose.submit(STORY_ID);
    await waitFor(() => store.get().generation.kind === "idle");
  }
  actions.compose.setText(STORY_ID, "half-typed");

  actions.compose.historyMove(STORY_ID, -1);
  assert.equal(draftOf(store).direct, "two");
  actions.compose.historyMove(STORY_ID, -1);
  assert.equal(draftOf(store).direct, "one");
  actions.compose.historyMove(STORY_ID, -1);
  assert.equal(draftOf(store).direct, "one", "the oldest entry is the end of the walk");
  actions.compose.historyMove(STORY_ID, 1);
  actions.compose.historyMove(STORY_ID, 1);
  assert.equal(draftOf(store).direct, "half-typed", "walking past the newest entry gives the unsent text back");
});

test("the history is shared by every story", async () => {
  const { actions, store } = open(linearPayload(["a1", "b1"]), "b1");
  actions.compose.setText(STORY_ID, "from story one");
  actions.compose.submit(STORY_ID);
  await waitFor(() => store.get().generation.kind === "idle");

  actions.compose.historyMove("story-2", -1);

  assert.equal(composeDraftOf(store.get().compose, "story-2").direct, "from story one");
});

// ---------------------------------------------------------------------------
// Review fixes: per-story history walk, retake retargeting.
// ---------------------------------------------------------------------------

test("a history walk belongs to its story: Ctrl+Down in another story never brings the first story's draft", async () => {
  const { actions, store } = open(linearPayload(["a1", "b1"]), "b1");
  actions.compose.setText(STORY_ID, "sent once");
  actions.compose.submit(STORY_ID);
  await waitFor(() => store.get().generation.kind === "idle");
  actions.compose.setText(STORY_ID, "half-typed in story one");
  actions.compose.historyMove(STORY_ID, -1);
  assert.equal(draftOf(store).direct, "sent once");

  actions.compose.setText("story-2", "my own text");
  actions.compose.historyMove("story-2", 1);

  assert.equal(composeDraftOf(store.get().compose, "story-2").direct, "my own text");
  actions.compose.historyMove(STORY_ID, 1);
  assert.equal(draftOf(store).direct, "half-typed in story one", "the first story's walk is intact");
});

test("R on another part archives a typed retake direction instead of replacing it silently", () => {
  const payload = linearPayload(["a1", "b1", "c1"], {
    nodeOverrides: { b1: { instruction: "Go left." }, c1: { instruction: "Go on." } }
  });
  const { actions, store } = open(payload, "c1");
  actions.compose.startRetake("b1");
  actions.compose.setText(STORY_ID, "A direction I typed.");

  actions.compose.startRetake("c1");

  assert.deepEqual(draftOf(store).retake, { nodeId: "c1", text: "Go on." });
  assert.deepEqual(store.get().compose.history, ["A direction I typed."]);
});
