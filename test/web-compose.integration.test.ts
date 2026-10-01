import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import type { DraftHandle } from "../web/src/generation/actions.js";
import { composeDraftOf } from "../web/src/compose/state.js";
import { manuscriptGenerationView } from "../web/src/generation/state.js";
import { STORY_LOCKED_TOAST } from "../web/src/story/actions.js";
import { RETAKE_GONE_TOAST, SUMMARY_RETAKE_TOAST, UNSAVED_TOAST } from "../web/src/story/part-policy.js";
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
 * The composer (#409 step 6), driven the way the writer drives it: type into
 * the box, press Enter, and read what the box and the story show. The real
 * app actions run over a fake `StoryApi` that throws for any call a test did
 * not expect.
 */

function open(payload: StoryPayload, focused: string | null, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, focused);
  const fake = fakeApi({ continueStory: () => Promise.resolve({ payload }), ...apiOptions });
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions, scheduler } = createActionsForStore(store);
  return { store, fake, actions, scheduler };
}

type Harness = ReturnType<typeof open>;

/** What the writer sees in the box. */
function boxOf(h: Harness): string {
  const draft = composeDraftOf(h.store.get().compose, STORY_ID);
  return draft.retake === null ? draft.direct : draft.retake.text;
}

function directOf(h: Harness): string {
  return composeDraftOf(h.store.get().compose, STORY_ID).direct;
}

function retakeOf(h: Harness) {
  return composeDraftOf(h.store.get().compose, STORY_ID).retake;
}

/** Types `text` and presses Enter. */
function send(h: Harness, text: string): boolean {
  h.actions.compose.setText(STORY_ID, text);
  return h.actions.compose.submit(STORY_ID);
}

const idle = (h: Harness) => waitFor(() => h.store.get().generation.kind === "idle");
const running = (h: Harness) => waitFor(() => h.store.get().generation.kind === "running");

// ---------------------------------------------------------------------------
// Direct: the typed direction.
// ---------------------------------------------------------------------------

test("Enter sends the typed direction as typed, opens a take of the next part, empties the box, and keeps the text in the history", async () => {
  const h = open(linearPayload(["a1", "b1"]), "b1");

  assert.equal(send(h, "  She turns around.  "), true);
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.equal(h.fake.continueCalls[0]!.instruction, "  She turns around.  ");
  assert.deepEqual(h.fake.continueCalls[0]!.target, { parentId: "b1" });
  assert.equal(boxOf(h), "", "the box is emptied the moment it is sent");
  assert.deepEqual(h.store.get().compose.history, ["  She turns around.  "]);
  await idle(h);
  assert.equal(boxOf(h), "", "a landed take leaves the box empty");
});

test("an empty box is a plain Continue and adds nothing to the history", async () => {
  const h = open(linearPayload(["a1", "b1"]), "b1");

  assert.equal(h.actions.compose.submit(STORY_ID), true);
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.equal(h.fake.continueCalls[0]!.instruction, "");
  assert.equal(h.fake.continueCalls[0]!.target.appendTo, "b1");
  assert.deepEqual(h.store.get().compose.history, []);
});

test("a send is refused while this story writes: a toast, the draft stays, nothing enters the history", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(linearPayload(["a1", "b1"]), "b1", { continueStory: () => gate.promise });
  const first = h.actions.generation.continue();
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.equal(send(h, "next direction"), false);

  assert.equal(boxOf(h), "next direction");
  assert.deepEqual(toasts(h.store), [`${STORY_LOCKED_TOAST} Draft kept.`]);
  assert.deepEqual(h.store.get().compose.history, []);
  gate.resolve({ payload: linearPayload(["a1", "b1"]) });
  await first;
});

test("a send is refused while unsaved text waits, with the same words Space gets", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => gate.promise,
    createNode: async () => { throw new Error("disk full"); },
    loadStory: async () => linearPayload(["a1", "b1"])
  });
  const first = h.actions.generation.continue();
  await waitFor(() => h.fake.continueCalls.length === 1);
  h.fake.continueCalls[0]!.onDelta("Text that will not save.");
  h.actions.generation.stop();
  gate.resolve(null);
  await first;
  assert.equal(h.store.get().generation.kind, "unsaved");

  assert.equal(send(h, "another"), false);
  await h.actions.generation.continue();

  assert.deepEqual(toasts(h.store).slice(1), [`${UNSAVED_TOAST} Draft kept.`, UNSAVED_TOAST]);
  assert.equal(boxOf(h), "another");
});

test("not connected: a send is refused and the draft stays", () => {
  const h = open(linearPayload(["a1", "b1"]), "b1");
  h.store.set((state) => ({ ...state, connection: { kind: "connecting" } }));

  assert.equal(send(h, "go"), false);

  assert.equal(boxOf(h), "go");
  assert.deepEqual(toasts(h.store), ["Not connected. Draft kept."]);
});

// ---------------------------------------------------------------------------
// The draft contract: restore on every failure, clear when the take lands.
// ---------------------------------------------------------------------------

test("a provider rejection reloads the story and puts the sent text back, but never over text typed meanwhile", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => gate.promise,
    loadStory: async () => linearPayload(["a1", "b1"])
  });
  send(h, "first try");
  await waitFor(() => h.fake.continueCalls.length === 1);

  gate.reject(providerFailure("The model refused this request."));
  await idle(h);
  assert.equal(boxOf(h), "first try", "an untouched box gets the sent text back");
  assert.equal(h.fake.loadStoryCalls.length, 1, "the story is reloaded after the failure");
  assert.ok(toasts(h.store).some((message) => message.includes("The model refused this request.")));

  const gate2 = deferred<{ payload: StoryPayload } | null>();
  h.fake.setContinueStory(() => gate2.promise);
  h.actions.compose.submit(STORY_ID);
  await running(h);
  h.actions.compose.setText(STORY_ID, "something newer");
  gate2.reject(providerFailure("refused again"));
  await idle(h);

  assert.equal(boxOf(h), "something newer");
  assert.ok(h.store.get().compose.history.includes("first try"), "the dropped text is still in the history");
});

test("an empty Stop returns the sent text; a Stop with prose saves the trimmed direction and clears the box", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => gate.promise,
    createNode: async () => linearPayload(["a1", "b1", "c1"]),
    loadStory: async () => linearPayload(["a1", "b1"])
  });
  send(h, "  go left  ");
  await waitFor(() => h.fake.continueCalls.length === 1);
  h.actions.generation.stop();
  gate.resolve(null);
  await idle(h);
  assert.equal(boxOf(h), "  go left  ");
  assert.equal(h.fake.createNodeCalls.length, 0);

  const gate2 = deferred<{ payload: StoryPayload } | null>();
  h.fake.setContinueStory(async (_s, _i, _g, _t, onDelta) => {
    onDelta("Left it was.");
    return gate2.promise;
  });
  h.actions.compose.submit(STORY_ID);
  await running(h);
  h.actions.generation.stop();
  gate2.resolve(null);
  await idle(h);

  assert.equal(h.fake.createNodeCalls.length, 1);
  assert.equal((h.fake.createNodeCalls[0]!.body as { instruction: string }).instruction, "go left");
  assert.equal(boxOf(h), "", "a saved stop clears the box");
});

test("a retried save that lands clears the restored text only when the writer has not changed it", async () => {
  async function runCase(typedAfter: string | null): Promise<string> {
    const gate = deferred<{ payload: StoryPayload } | null>();
    let saves = 0;
    const h = open(linearPayload(["a1", "b1"]), "b1", {
      continueStory: () => gate.promise,
      createNode: async () => {
        saves += 1;
        if (saves === 1) throw new Error("disk full");
        return linearPayload(["a1", "b1", "c1"]);
      },
      loadStory: async () => linearPayload(["a1", "b1"])
    });
    send(h, "go left");
    await waitFor(() => h.fake.continueCalls.length === 1);
    h.fake.continueCalls[0]!.onDelta("Prose.");
    h.actions.generation.stop();
    gate.resolve(null);
    await waitFor(() => h.store.get().generation.kind === "unsaved");
    assert.equal(boxOf(h), "go left");
    if (typedAfter !== null) h.actions.compose.setText(STORY_ID, typedAfter);
    await h.actions.generation.retrySave();
    return boxOf(h);
  }

  assert.equal(await runCase(null), "", "unchanged restored text is cleared by the landing");
  assert.equal(await runCase("go left, then right"), "go left, then right", "text the writer changed is kept");
});

test("a revision_conflict at admission reloads and returns the sent text; resource_busy is retried and then lands", { timeout: 8_000 }, async () => {
  const conflict = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(plainFailure("revision_conflict", "stale")),
    loadStory: async () => linearPayload(["a1", "b1", "c1"])
  });
  send(conflict, "go");
  await waitFor(() => conflict.fake.loadStoryCalls.length === 1 && conflict.store.get().generation.kind === "idle");
  assert.equal(boxOf(conflict), "go");

  let attempts = 0;
  const busy = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(plainFailure("resource_busy", "busy"))
        : Promise.resolve({ payload: linearPayload(["a1", "b1", "c1"]) });
    }
  });
  send(busy, "go");
  await waitFor(() => attempts === 2 && busy.store.get().generation.kind === "idle");
  assert.equal(boxOf(busy), "");

  const stillBusy = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(plainFailure("resource_busy", "busy")),
    loadStory: async () => linearPayload(["a1", "b1"])
  });
  send(stillBusy, "go");
  await waitFor(() => stillBusy.store.get().generation.kind === "idle" && stillBusy.store.get().toasts.length > 0, 4_000);
  assert.equal(boxOf(stillBusy), "go", "a final busy refusal gives the text back");
  assert.deepEqual(toasts(stillBusy.store), ["Another window is writing in this story."]);
});

test("a draft handle that throws never breaks the run", async () => {
  const h = open(linearPayload(["a1", "b1"]), "b1", {
    continueStory: () => Promise.reject(providerFailure("refused")),
    loadStory: async () => linearPayload(["a1", "b1"])
  });
  const draft: DraftHandle = {
    restore: () => { throw new Error("restore blew up"); },
    clear: () => { throw new Error("clear blew up"); }
  };

  await h.actions.generation.continue({ instruction: "go", draft });

  assert.equal(h.store.get().generation.kind, "idle");
  assert.ok(toasts(h.store).includes("refused"));
});

// ---------------------------------------------------------------------------
// Retake (r, R).
// ---------------------------------------------------------------------------

test("retake opens a sibling take: parentId, the old direction, and the part's own number", async () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(payload, "c1", { continueStory: () => gate.promise });

  h.actions.part.run("retake", "b1");
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.deepEqual(h.fake.continueCalls[0]!.target, { parentId: "a1" });
  assert.equal(h.fake.continueCalls[0]!.instruction, "Go left.");
  const story = h.store.get().story;
  assert.equal(story.kind === "loaded" ? story.focusedPartId : null, "b1", "focus moves onto the part first");
  const view = manuscriptGenerationView(h.store.get().generation, STORY_ID);
  assert.equal(view?.mode, "take");
  assert.equal(view?.seamPathIndex, 0, "the seam sits above the retaken part");
  assert.equal(view?.partNumber, 2, "the streaming take shows the retaken part's number");
  gate.resolve({ payload: linearPayload(["a1", "b2"]) });
  await idle(h);
});

test("retaking the first part opens a root take", async () => {
  const h = open(linearPayload(["a1", "b1"]), "a1", { continueStory: () => new Promise(() => {}) });

  h.actions.part.run("retake", "a1");
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.deepEqual(h.fake.continueCalls[0]!.target, { parentId: null });
  const view = manuscriptGenerationView(h.store.get().generation, STORY_ID);
  assert.equal(view?.seamPathIndex, -1);
  assert.equal(view?.partNumber, 1);
});

test("a stopped retake saves the take under the retaken part's parent, with the direction", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(
    linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } }),
    "b1",
    { continueStory: () => gate.promise, createNode: async () => linearPayload(["a1", "b2"]) }
  );

  h.actions.part.run("retake", "b1");
  await waitFor(() => h.fake.continueCalls.length === 1);
  h.fake.continueCalls[0]!.onDelta("A different take.");
  h.actions.generation.stop();
  gate.resolve(null);
  await idle(h);

  assert.deepEqual(h.fake.createNodeCalls[0]!.body, {
    parentId: "a1",
    instruction: "Go left.",
    text: "A different take.",
    genId: h.fake.continueCalls[0]!.genId
  });
});

test("R opens retake mode with the part's direction and sets the Direct draft aside; typing never touches it", () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const h = open(payload, "c1");
  h.actions.compose.setText(STORY_ID, "my direct draft");

  h.actions.part.run("retake-with-prompt", "b1");

  assert.deepEqual(retakeOf(h), { nodeId: "b1", text: "Go left." });
  assert.equal(directOf(h), "my direct draft");
  h.actions.compose.setText(STORY_ID, "Go right.");
  assert.equal(retakeOf(h)?.text, "Go right.");
  assert.equal(directOf(h), "my direct draft");
});

test("Escape in retake mode brings the Direct draft back and keeps a changed direction in the history", () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const h = open(payload, "b1");
  h.actions.compose.setText(STORY_ID, "direct");
  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "Go right.");

  h.actions.compose.cancelRetake(STORY_ID);

  assert.equal(retakeOf(h), null);
  assert.equal(directOf(h), "direct");
  assert.deepEqual(h.store.get().compose.history, ["Go right."]);
});

test("R on another part archives a typed direction instead of replacing it silently", () => {
  const payload = linearPayload(["a1", "b1", "c1"], {
    nodeOverrides: { b1: { instruction: "Go left." }, c1: { instruction: "Go on." } }
  });
  const h = open(payload, "c1");
  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "A direction I typed.");

  h.actions.part.run("retake-with-prompt", "c1");

  assert.deepEqual(retakeOf(h), { nodeId: "c1", text: "Go on." });
  assert.deepEqual(h.store.get().compose.history, ["A direction I typed."]);
});

test("a retake send uses the typed direction and sets retakeOf; the Direct draft is in the box, and a landed retake leaves retake mode closed", async () => {
  const payload = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const h = open(payload, "c1");
  h.actions.compose.setText(STORY_ID, "direct draft");
  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "Go right.");

  assert.equal(h.actions.compose.submit(STORY_ID), true);
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.equal(h.fake.continueCalls[0]!.instruction, "Go right.");
  assert.deepEqual(h.fake.continueCalls[0]!.target, { parentId: "a1" });
  assert.equal(retakeOf(h), null);
  assert.equal(directOf(h), "direct draft");
  await idle(h);
  assert.equal(retakeOf(h), null);
});

test("a failed retake goes back into retake mode, unless the Direct text changed meanwhile", async () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const gate = deferred<{ payload: StoryPayload } | null>();
  const h = open(payload, "b1", { continueStory: () => gate.promise, loadStory: async () => payload });
  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "Go right.");
  h.actions.compose.submit(STORY_ID);
  await waitFor(() => h.fake.continueCalls.length === 1);
  gate.reject(providerFailure("refused"));
  await idle(h);
  assert.deepEqual(retakeOf(h), { nodeId: "b1", text: "Go right." });

  const gate2 = deferred<{ payload: StoryPayload } | null>();
  h.fake.setContinueStory(() => gate2.promise);
  h.actions.compose.submit(STORY_ID);
  await running(h);
  h.actions.compose.setText(STORY_ID, "typed while it ran");
  gate2.reject(providerFailure("refused again"));
  await idle(h);

  assert.equal(retakeOf(h), null);
  assert.equal(directOf(h), "typed while it ran");
});

test("a retake whose part left the line is refused and the draft stays; R and r refuse a summary", () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const h = open(payload, "b1");
  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "Go right.");
  h.store.set((state) => state.story.kind === "loaded"
    ? { ...state, story: { ...state.story, payload: linearPayload(["a1", "x1"]) } }
    : state);

  assert.equal(h.actions.compose.submit(STORY_ID), false);

  assert.equal(retakeOf(h)?.text, "Go right.");
  assert.deepEqual(toasts(h.store), [RETAKE_GONE_TOAST]);

  const summary = open(linearPayload(["a1", "s1"], { nodeOverrides: { s1: { role: "summary" } } }), "s1");
  summary.actions.part.run("retake-with-prompt", "s1");
  summary.actions.part.run("retake", "s1");
  assert.equal(retakeOf(summary), null);
  assert.deepEqual(toasts(summary.store), [SUMMARY_RETAKE_TOAST, SUMMARY_RETAKE_TOAST]);
  assert.equal(summary.fake.continueCalls.length, 0);
});

// ---------------------------------------------------------------------------
// History.
// ---------------------------------------------------------------------------

test("history walks sent directions and keeps the unsent text", async () => {
  const h = open(linearPayload(["a1", "b1"]), "b1");
  for (const text of ["one", "two"]) {
    send(h, text);
    await idle(h);
  }
  h.actions.compose.setText(STORY_ID, "half-typed");

  h.actions.compose.historyMove(STORY_ID, -1);
  assert.equal(boxOf(h), "two");
  h.actions.compose.historyMove(STORY_ID, -1);
  assert.equal(boxOf(h), "one");
  h.actions.compose.historyMove(STORY_ID, -1);
  assert.equal(boxOf(h), "one", "the oldest entry is the end of the walk");
  h.actions.compose.historyMove(STORY_ID, 1);
  h.actions.compose.historyMove(STORY_ID, 1);
  assert.equal(boxOf(h), "half-typed", "walking past the newest entry gives the unsent text back");
});

test("a history walk belongs to its story: Ctrl+Down in another story never brings the first story's draft", async () => {
  const h = open(linearPayload(["a1", "b1"]), "b1");
  send(h, "sent once");
  await idle(h);
  h.actions.compose.setText(STORY_ID, "half-typed in story one");
  h.actions.compose.historyMove(STORY_ID, -1);
  assert.equal(boxOf(h), "sent once");

  h.actions.compose.setText("story-2", "my own text");
  h.actions.compose.historyMove("story-2", 1);

  assert.equal(composeDraftOf(h.store.get().compose, "story-2").direct, "my own text");
  h.actions.compose.historyMove(STORY_ID, 1);
  assert.equal(boxOf(h), "half-typed in story one", "the first story's walk is intact");
});

test("the history is shared by every story", async () => {
  const h = open(linearPayload(["a1", "b1"]), "b1");
  send(h, "from story one");
  await idle(h);

  h.actions.compose.historyMove("story-2", -1);

  assert.equal(composeDraftOf(h.store.get().compose, "story-2").direct, "from story one");
});

test("closing a retake never disturbs an unsent Direct draft that the Direct walk is holding", async () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { instruction: "Go left." } } });
  const h = open(payload, "b1");
  send(h, "an old direction");
  await idle(h);
  h.actions.compose.setText(STORY_ID, "unsent direct draft");
  h.actions.compose.historyMove(STORY_ID, -1);
  assert.equal(directOf(h), "an old direction");

  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "A retake direction I typed.");
  h.actions.compose.cancelRetake(STORY_ID);

  assert.equal(directOf(h), "an old direction", "the Direct box still shows the recalled entry");
  h.actions.compose.historyMove(STORY_ID, 1);
  assert.equal(directOf(h), "A retake direction I typed.", "the archived retake direction is the newest entry");
  h.actions.compose.historyMove(STORY_ID, 1);
  assert.equal(directOf(h), "unsent direct draft", "walking past the newest entry gives the unsent draft back");
});
