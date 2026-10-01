import assert from "node:assert/strict";
import test from "node:test";
import type { PartActionId } from "../shared/part-actions.js";
import type { StoryPayload } from "../shared/types.js";
import { editorIsOffLine } from "../web/src/editor/state.js";
import { STORY_LOCKED_TOAST, STORY_RELOADED_TOAST } from "../web/src/story/actions.js";
import { deleteQuestion } from "../web/src/story/delete-plan.js";
import {
  EDITOR_OPEN_TOAST,
  NOT_CONNECTED_TOAST,
  PART_SWITCHING_TOAST,
  PART_UNAVAILABLE_TOAST,
  PART_WRITING_TOAST,
  SUMMARY_RETAKE_TOAST,
  UNSAVED_TOAST,
  partActionRefusal
} from "../web/src/story/part-policy.js";
import {
  STORY_ID,
  connectedState,
  createActionsForStore,
  deferred,
  fakeApi,
  linearPayload,
  plainFailure,
  storeOpenOn,
  toasts,
  waitFor
} from "./web-story-fixtures.js";

/**
 * The part-action policy and its commands (#409 step 6): which actions a part
 * allows right now, the dispatcher every key and menu item goes through, and
 * the delete confirmation. Real app actions over a strict fake `StoryApi`.
 */

const THREE = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Left it was." } } });

function open(payload: StoryPayload, focused: string | null, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, focused);
  const fake = fakeApi({ continueStory: () => Promise.resolve({ payload }), ...apiOptions });
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions } = createActionsForStore(store);
  return { store, fake, actions };
}

type Harness = ReturnType<typeof open>;

function focusedPart(h: Harness): string | null {
  const story = h.store.get().story;
  return story.kind === "loaded" ? story.focusedPartId : null;
}

function refusal(h: Harness, partId: string, action: PartActionId): string | null {
  return partActionRefusal(h.store.get(), partId, action);
}

/** Starts a generation on the leaf and holds it open. */
async function startWriting(h: Harness) {
  const gate = deferred<{ payload: StoryPayload } | null>();
  h.fake.setContinueStory(() => gate.promise);
  const run = h.actions.generation.continue();
  await waitFor(() => h.fake.continueCalls.length === 1);
  return { finish: async () => { gate.resolve({ payload: THREE }); await run; } };
}

// ---------------------------------------------------------------------------
// The policy table.
// ---------------------------------------------------------------------------

test("an idle story allows every action, and a part off the line allows none", () => {
  const h = open(THREE, "b1");
  for (const id of ["continue", "direct", "retake", "retake-with-prompt", "write", "edit", "prune"] as const) {
    assert.equal(refusal(h, "b1", id), null, id);
    assert.equal(refusal(h, "gone", id), PART_UNAVAILABLE_TOAST, id);
  }
});

test("a summary is never retaken, but can be edited", () => {
  const h = open(linearPayload(["a1", "s1"], { nodeOverrides: { s1: { role: "summary" } } }), "s1");

  assert.equal(refusal(h, "s1", "retake"), SUMMARY_RETAKE_TOAST);
  assert.equal(refusal(h, "s1", "retake-with-prompt"), SUMMARY_RETAKE_TOAST);
  assert.equal(refusal(h, "s1", "edit"), null);
});

test("while this story writes: Continue, Retake and Delete wait; Direct, Write and Edit stay; Edit waits only for the leaf being appended", async () => {
  const h = open(THREE, "b1");
  const writing = await startWriting(h);

  assert.equal(refusal(h, "b1", "continue"), STORY_LOCKED_TOAST);
  assert.equal(refusal(h, "b1", "retake"), STORY_LOCKED_TOAST);
  assert.equal(refusal(h, "b1", "prune"), STORY_LOCKED_TOAST);
  assert.equal(refusal(h, "b1", "direct"), null);
  assert.equal(refusal(h, "b1", "write"), null);
  assert.equal(refusal(h, "b1", "edit"), null);
  assert.equal(refusal(h, "b1", "retake-with-prompt"), null);
  // The run above is a take from b1, not an append, so nothing is appended;
  // an append on the leaf is covered by the next test.
  await writing.finish();
});

test("e on the leaf that is being appended to is refused", async () => {
  const h = open(THREE, "c1");
  const writing = await startWriting(h);

  assert.equal(refusal(h, "c1", "edit"), PART_WRITING_TOAST);
  h.actions.part.run("edit", "c1");

  assert.deepEqual(toasts(h.store), [PART_WRITING_TOAST]);
  assert.equal(h.store.get().editor, null);
  await writing.finish();
});

test("unsaved text blocks Continue, Retake and Delete: the part it hangs below must not be deleted", async () => {
  const h = open(THREE, "c1", {
    createNode: async () => { throw new Error("disk full"); },
    loadStory: async () => THREE
  });
  const gate = deferred<{ payload: StoryPayload } | null>();
  h.fake.setContinueStory(() => gate.promise);
  const run = h.actions.generation.continue();
  await waitFor(() => h.fake.continueCalls.length === 1);
  h.fake.continueCalls[0]!.onDelta("Text that will not save.");
  h.actions.generation.stop();
  gate.resolve(null);
  await run;
  assert.equal(h.store.get().generation.kind, "unsaved");

  for (const id of ["continue", "retake", "prune"] as const) assert.equal(refusal(h, "b1", id), UNSAVED_TOAST, id);
  h.actions.part.run("prune", "c1");
  assert.equal(h.store.get().partUi.deletePlan, null);
  assert.equal(refusal(h, "b1", "write"), null);
});

test("a generation in another story blocks Continue and Retake, but not Delete here", async () => {
  const h = open(THREE, "b1");
  h.store.set((state) => ({
    ...state,
    generation: {
      kind: "running", genId: "g", storyId: "other", storyTitle: "Other", mode: "take", appendTo: null,
      parentId: null, seamPathIndex: 0, instruction: "", text: "", reasoning: null, focusAtStart: null
    }
  }));

  assert.equal(refusal(h, "b1", "continue"), "Already writing in Other. Esc stops it.");
  assert.equal(refusal(h, "b1", "prune"), null);
});

test("not connected: the actions that change the story at once say so, like the composer", () => {
  const h = open(THREE, "b1");
  h.store.set((state) => ({ ...state, connection: { kind: "connecting" } }));

  for (const id of ["continue", "retake", "prune"] as const) assert.equal(refusal(h, "b1", id), NOT_CONNECTED_TOAST, id);
  h.actions.part.run("retake", "b1");
  assert.deepEqual(toasts(h.store), [NOT_CONNECTED_TOAST]);
  assert.equal(refusal(h, "b1", "edit"), null);
});

test("a take switch in flight on the part or above it refuses everything but Direct", () => {
  const h = open(THREE, "b1");
  h.store.set((state) => state.story.kind === "loaded"
    ? { ...state, story: { ...state.story, switching: { partId: "a1", targetId: "a2" } } }
    : state);

  for (const id of ["continue", "retake", "retake-with-prompt", "write", "edit", "prune"] as const) {
    assert.equal(refusal(h, "b1", id), PART_SWITCHING_TOAST, id);
  }
  assert.equal(refusal(h, "b1", "direct"), null);
});

// ---------------------------------------------------------------------------
// The editor lock, including generation admission (review A1).
// ---------------------------------------------------------------------------

function openDirtyEditor(h: Harness, partId: string): void {
  h.actions.part.run("edit", partId);
  h.actions.editor.setText("Draft that must not be lost.");
}

test("with a changed editor on B, Space from A is refused: it would hide B's editor", () => {
  const h = open(THREE, "a1");
  openDirtyEditor(h, "b1");

  h.actions.part.run("continue", "a1");

  assert.deepEqual(toasts(h.store), [EDITOR_OPEN_TOAST]);
  assert.equal(h.fake.continueCalls.length, 0);
  assert.equal(h.store.get().editor?.text, "Draft that must not be lost.");
});

test("with an editor on the leaf, Continue at the leaf is refused; from the leaf's parent it is refused too, but a take after the leaf is not", () => {
  const h = open(THREE, "c1");
  openDirtyEditor(h, "c1");

  assert.equal(refusal(h, "c1", "continue"), EDITOR_OPEN_TOAST, "an append would change the edited leaf");
  assert.equal(refusal(h, "b1", "continue"), EDITOR_OPEN_TOAST, "a take under b1 hides the edited leaf");
  assert.equal(refusal(h, "a1", "continue"), EDITOR_OPEN_TOAST);
});

test("with an editor on A, Continue from B or C does not touch A", () => {
  const h = open(THREE, "c1");
  openDirtyEditor(h, "a1");

  assert.equal(refusal(h, "c1", "continue"), null);
  assert.equal(refusal(h, "b1", "continue"), null);
  assert.equal(refusal(h, "b1", "retake"), null);
  assert.equal(refusal(h, "a1", "retake"), EDITOR_OPEN_TOAST);
  assert.equal(refusal(h, "a1", "prune"), EDITOR_OPEN_TOAST);
});

test("an editor opened while Continue prepares is respected after the preparation, and the draft comes back", async () => {
  const settings = deferred<never>();
  const h = open(THREE, "a1", { getSettings: () => settings.promise });
  h.actions.compose.setText(STORY_ID, "a direction");
  const sent = h.actions.compose.submit(STORY_ID);
  assert.equal(sent, true);
  // The send is awaiting its settings; the writer opens an editor on B.
  h.actions.editor.openEdit("b1");
  h.actions.editor.setText("Draft that must not be lost.");

  settings.reject(new Error("no settings"));
  await waitFor(() => h.store.get().toasts.length > 0);

  assert.equal(h.fake.continueCalls.length, 0);
  assert.equal(h.store.get().generation.kind, "idle");
  assert.equal(h.store.get().editor?.text, "Draft that must not be lost.");
  assert.equal(h.store.get().compose.drafts[STORY_ID]?.direct, "a direction", "the direction is back in the box");
  assert.ok(toasts(h.store).some((message) => message.startsWith(EDITOR_OPEN_TOAST)));
});

test("an R draft opened before the editor cannot be sent over it", () => {
  const h = open(THREE, "c1");
  h.actions.part.run("retake-with-prompt", "b1");
  h.actions.compose.setText(STORY_ID, "Go right.");
  openDirtyEditor(h, "c1");

  assert.equal(h.actions.compose.submit(STORY_ID), false);

  assert.deepEqual(toasts(h.store), [`${EDITOR_OPEN_TOAST} Draft kept.`]);
  assert.equal(h.fake.continueCalls.length, 0);
  assert.equal(h.store.get().compose.drafts[STORY_ID]?.retake?.text, "Go right.");
});

test("a take switch, a retake, and a second editor cannot take the edited part away", () => {
  const h = open(THREE, "b1");
  openDirtyEditor(h, "b1");

  h.actions.story.switchTake("b1", 1);
  h.actions.part.run("retake", "a1");
  h.actions.part.run("edit", "c1");

  assert.equal(h.fake.continueCalls.length, 0);
  assert.equal(h.store.get().editor?.text, "Draft that must not be lost.");
  assert.deepEqual(toasts(h.store), [EDITOR_OPEN_TOAST, EDITOR_OPEN_TOAST, EDITOR_OPEN_TOAST]);
});

// ---------------------------------------------------------------------------
// An editor whose part left the line (review A2).
// ---------------------------------------------------------------------------

test("when the edited part leaves the line, the editor keeps the text and can be recovered or discarded", async () => {
  const h = open(THREE, "b1", {
    editNode: async () => { throw plainFailure("conflict", "changed"); },
    loadStory: async () => linearPayload(["a1", "x1"])
  });
  openDirtyEditor(h, "b1");
  assert.equal(editorIsOffLine(h.store.get(), STORY_ID), false);

  await h.actions.editor.save("in-place");

  assert.equal(editorIsOffLine(h.store.get(), STORY_ID), true, "the recovery view shows");
  assert.equal(h.store.get().editor?.text, "Draft that must not be lost.");
  h.actions.part.run("edit", "x1");
  assert.equal(refusalIsEditorOpen(h, "x1"), true, "another editor is refused while the text is kept");

  h.actions.editor.discard();
  assert.equal(h.store.get().editor, null);
  assert.equal(editorIsOffLine(h.store.get(), STORY_ID), false);
});

function refusalIsEditorOpen(h: Harness, partId: string): boolean {
  return refusal(h, partId, "edit") === EDITOR_OPEN_TOAST;
}

// ---------------------------------------------------------------------------
// The dispatcher.
// ---------------------------------------------------------------------------

test("Retake goes through the dispatcher: the part's own direction, focus first", async () => {
  const h = open(THREE, "c1", { continueStory: () => new Promise(() => {}) });

  h.actions.part.run("retake", "b1");
  await waitFor(() => h.fake.continueCalls.length === 1);

  assert.equal(h.fake.continueCalls[0]!.instruction, "Go left.");
  assert.deepEqual(h.fake.continueCalls[0]!.target, { parentId: "a1" });
  assert.equal(focusedPart(h), "b1");
});

// ---------------------------------------------------------------------------
// `D`: delete with confirmation.
// ---------------------------------------------------------------------------

test("D asks first: the plan counts the part and the parts below it, and nothing is deleted yet", () => {
  const h = open(THREE, "b1");

  h.actions.part.run("prune", "b1");

  const plan = h.store.get().partUi.deletePlan;
  assert.equal(plan?.nodeId, "b1");
  assert.equal(plan?.partNumber, 2);
  assert.equal(plan?.parts, 2, "b1 and c1");
  assert.equal(deleteQuestion(plan!), "Delete part 2 and the 1 part below it?");
  assert.equal(h.fake.deleteNodeCalls.length, 0);

  h.actions.part.cancelDelete();
  assert.equal(h.store.get().partUi.deletePlan, null);
});

test("confirming sends the counted subtree size, lands focus on the previous part, and closes the dialog", async () => {
  const h = open(THREE, "b1", { deleteNode: async () => linearPayload(["a1"]) });

  h.actions.part.run("prune", "b1");
  await h.actions.part.confirmDelete();

  assert.deepEqual(h.fake.deleteNodeCalls, [{ storyId: STORY_ID, nodeId: "b1", count: 2 }]);
  assert.equal(h.store.get().partUi.deletePlan, null);
  assert.equal(focusedPart(h), "a1");
  const story = h.store.get().story;
  assert.equal(story.kind === "loaded" ? story.payload.path.length : -1, 1);
});

test("deleting the first part lands focus on the new first part", async () => {
  const h = open(THREE, "a1", { deleteNode: async () => linearPayload(["z1"]) });

  h.actions.part.run("prune", "a1");
  await h.actions.part.confirmDelete();

  assert.equal(focusedPart(h), "z1");
});

test("a conflict reloads the story, closes the dialog, and says the story was reloaded", async () => {
  const reloaded = linearPayload(["a1", "b1", "c1", "d1"]);
  const h = open(THREE, "b1", {
    deleteNode: async () => { throw plainFailure("conflict", "count changed"); },
    loadStory: async () => reloaded
  });

  h.actions.part.run("prune", "b1");
  await h.actions.part.confirmDelete();

  assert.equal(h.fake.loadStoryCalls.length, 1);
  assert.equal(h.store.get().partUi.deletePlan, null);
  assert.deepEqual(toasts(h.store), [STORY_RELOADED_TOAST]);
  const story = h.store.get().story;
  assert.equal(story.kind === "loaded" ? story.payload : null, reloaded);
});

test("an unknown outcome that the reload shows as deleted counts as deleted", async () => {
  const h = open(THREE, "b1", {
    deleteNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => linearPayload(["a1"])
  });

  h.actions.part.run("prune", "b1");
  await h.actions.part.confirmDelete();

  assert.equal(h.store.get().partUi.deletePlan, null);
  assert.deepEqual(toasts(h.store), []);
  assert.equal(focusedPart(h), "a1");
});

test("confirming is refused if a generation started while the dialog was open, and the dialog stays", async () => {
  const h = open(THREE, "b1");
  h.actions.part.run("prune", "b1");
  const writing = await startWriting(h);

  await h.actions.part.confirmDelete();

  assert.equal(h.fake.deleteNodeCalls.length, 0);
  assert.notEqual(h.store.get().partUi.deletePlan, null);
  assert.deepEqual(toasts(h.store), [STORY_LOCKED_TOAST]);
  await writing.finish();
});
