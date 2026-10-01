import assert from "node:assert/strict";
import test from "node:test";
import { textHash } from "../client/api.js";
import type { StoryPayload } from "../shared/types.js";
import {
  NOTHING_TO_SAVE_TOAST,
  PART_CHANGED_TOAST,
  PART_GONE_TOAST,
  SUMMARY_FORK_TOAST
} from "../web/src/editor/actions.js";
import { editorDirty } from "../web/src/editor/state.js";
import { STORY_LOCKED_TOAST, STORY_RELOADED_TOAST } from "../web/src/story/actions.js";
import { EDITOR_OPEN_TOAST } from "../web/src/editor/state.js";
import { deleteQuestion } from "../web/src/story/part-ui-state.js";
import { PART_WRITING_TOAST } from "../web/src/story/part-guard.js";
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
 * The inline editor's saves (#409 step 6): `e` forks (primary) or saves in
 * place, with the TUI's conflict and unknown-outcome rules. Real app actions
 * over a fake `StoryApi`.
 */

function open(payload: StoryPayload, focused: string | null, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, focused);
  const fake = fakeApi(apiOptions);
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions } = createActionsForStore(store);
  return { store, fake, actions };
}

function focusedPart(store: ReturnType<typeof open>["store"]): string | null {
  const story = store.get().story;
  return story.kind === "loaded" ? story.focusedPartId : null;
}

const THREE = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Left it was." } } });

test("save in place sends only the changed fields, against the part as it was when the editor opened", async () => {
  const landed = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { text: "Left it was, slowly." } } });
  const { actions, fake, store } = open(THREE, "c1", { editNode: async () => landed });

  actions.editor.openEdit("b1");
  actions.editor.setText("  Left it was, slowly.  ");
  await actions.editor.save("in-place");

  assert.equal(fake.editNodeCalls.length, 1);
  assert.equal(fake.editNodeCalls[0]!.node.text, "Left it was.", "the snapshot taken at open is what gets hashed");
  assert.deepEqual(fake.editNodeCalls[0]!.patch, { text: "Left it was, slowly." });
  assert.equal(store.get().editor, null);
  assert.equal(focusedPart(store), "b1");
});

test("save as new take forks from the part with its hash, and lands focus on the new take", async () => {
  const landed = linearPayload(["a1", "b2"], {
    nodeOverrides: { b2: { instruction: "Go left.", text: "Left it was, slowly." } }
  });
  const { actions, fake, store } = open(THREE, "c1", { createNode: async () => landed });

  actions.editor.openEdit("b1");
  actions.editor.setText("Left it was, slowly.");
  await actions.editor.save("new");

  assert.equal(fake.createNodeCalls.length, 1);
  assert.deepEqual(fake.createNodeCalls[0]!.body, {
    sourceNodeId: "b1",
    expectedTextHash: await textHash("Left it was."),
    instruction: "Go left.",
    text: "Left it was, slowly."
  });
  assert.equal(store.get().editor, null);
  assert.equal(focusedPart(store), "b2");
});

test("a changed direction alone is saved; blank prose is refused; an unchanged editor closes without a call", async () => {
  const { actions, fake, store } = open(THREE, "b1");

  actions.editor.openEdit("b1");
  await actions.editor.save("new");
  assert.equal(store.get().editor, null, "no change: just close");
  assert.equal(fake.createNodeCalls.length + fake.editNodeCalls.length, 0);

  actions.editor.openEdit("b1");
  actions.editor.setText("   ");
  await actions.editor.save("in-place");
  assert.deepEqual(toasts(store), [NOTHING_TO_SAVE_TOAST]);
  assert.notEqual(store.get().editor, null);

  actions.editor.setText("Left it was.");
  actions.editor.setInstruction("Go far left.");
  await actions.editor.save("in-place");
  assert.deepEqual(fake.editNodeCalls[0]!.patch, { instruction: "Go far left." });
});

test("a legacy summary can only be saved in place", async () => {
  const payload = linearPayload(["a1", "s1"], { nodeOverrides: { s1: { role: "summary", text: "A summary." } } });
  const { actions, fake, store } = open(payload, "s1");

  actions.editor.openEdit("s1");
  actions.editor.setText("A better summary.");
  await actions.editor.save("new");

  assert.deepEqual(toasts(store), [SUMMARY_FORK_TOAST]);
  assert.equal(fake.createNodeCalls.length, 0);
});

test("a conflict reloads, keeps the draft, rebases onto the new part, and the next save overwrites it", async () => {
  const changed = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Changed elsewhere." } } });
  let attempts = 0;
  const { actions, fake, store } = open(THREE, "b1", {
    editNode: async () => {
      attempts += 1;
      if (attempts === 1) throw plainFailure("conflict", "text changed");
      return changed;
    },
    loadStory: async () => changed
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("My version.");
  await actions.editor.save("in-place");

  const editor = store.get().editor;
  assert.equal(editor?.text, "My version.", "the draft is kept");
  assert.equal(editor?.base?.text, "Changed elsewhere.", "rebased onto the reloaded part");
  assert.equal(editor?.overwriteArmed, true);
  assert.equal(editor?.saving, false);
  assert.ok(toasts(store).includes(PART_CHANGED_TOAST));
  assert.equal(fake.loadStoryCalls.length, 1);

  await actions.editor.save("in-place");

  assert.equal(fake.editNodeCalls.length, 2);
  assert.equal(fake.editNodeCalls[1]!.node.text, "Changed elsewhere.");
  assert.equal(store.get().editor, null);
});

test("a part that no longer exists keeps the editor open and says so", async () => {
  const { actions, store } = open(THREE, "b1", {
    editNode: async () => { throw plainFailure("revision_conflict", "stale"); },
    loadStory: async () => linearPayload(["a1", "x1"])
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("My version.");
  await actions.editor.save("in-place");

  assert.ok(toasts(store).includes(PART_GONE_TOAST));
  assert.equal(store.get().editor?.text, "My version.");
});

test("resource_busy is retried and the save lands", { timeout: 5_000 }, async () => {
  let attempts = 0;
  const { actions, fake, store } = open(THREE, "b1", {
    editNode: async () => {
      attempts += 1;
      if (attempts === 1) throw plainFailure("resource_busy", "busy");
      return linearPayload(["a1", "b1", "c1"]);
    }
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("Retried.");
  await actions.editor.save("in-place");

  assert.equal(fake.editNodeCalls.length, 2);
  assert.equal(store.get().editor, null);
});

test("an unknown outcome reloads: a new take that is found counts as saved, otherwise the draft stays", async () => {
  const created = linearPayload(["a1", "b2"], { nodeOverrides: { b2: { instruction: "Go left.", text: "Fork text." } } });
  const found = open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => created
  });
  found.actions.editor.openEdit("b1");
  found.actions.editor.setText("Fork text.");
  await found.actions.editor.save("new");
  assert.equal(found.store.get().editor, null, "the reload shows the take: saved");
  assert.equal(focusedPart(found.store), "b2");

  const missing = open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => THREE
  });
  missing.actions.editor.openEdit("b1");
  missing.actions.editor.setText("Fork text.");
  await missing.actions.editor.save("new");
  assert.equal(missing.store.get().editor?.text, "Fork text.", "no take found: the draft is kept");
  assert.equal(missing.fake.loadStoryCalls.length, 1);

  const inPlace = open(THREE, "b1", {
    editNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Same." } } })
  });
  inPlace.actions.editor.openEdit("b1");
  inPlace.actions.editor.setText("Same.");
  await inPlace.actions.editor.save("in-place");
  assert.equal(inPlace.store.get().editor, null, "reloaded text equals the submitted text: saved");
});

test("a definite failure keeps the draft and reloads", async () => {
  const { actions, fake, store } = open(THREE, "b1", {
    editNode: async () => { throw plainFailure("validation_failed", "Too long.", 422); }
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("My version.");
  await actions.editor.save("in-place");

  assert.equal(store.get().editor?.text, "My version.");
  assert.equal(fake.loadStoryCalls.length, 1);
  assert.ok(toasts(store).some((message) => message.includes("Too long.") && message.includes("Draft kept.")));
});

test("Save is refused while this story writes; typing and opening still work; the draft stays", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(THREE, "c1", { continueStory: () => gate.promise });
  const run = actions.generation.continue();
  await waitFor(() => fake.continueCalls.length === 1);

  actions.editor.openEdit("a1");
  actions.editor.setText("Typed while it writes.");
  await actions.editor.save("in-place");

  assert.deepEqual(toasts(store), [`${STORY_LOCKED_TOAST} Draft kept.`]);
  assert.equal(store.get().editor?.text, "Typed while it writes.");
  assert.equal(fake.editNodeCalls.length, 0);
  gate.resolve({ payload: THREE });
  await run;
});

test("e on the leaf that is being appended to is refused", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, fake, store } = open(THREE, "c1", { continueStory: () => gate.promise });
  const run = actions.generation.continue();
  await waitFor(() => fake.continueCalls.length === 1);

  actions.editor.openEdit("c1");

  assert.deepEqual(toasts(store), [PART_WRITING_TOAST]);
  assert.equal(store.get().editor, null);
  gate.resolve({ payload: THREE });
  await run;
});

test("Escape closes a clean editor at once; a changed one needs a second press", () => {
  const { actions, store } = open(THREE, "b1");
  actions.editor.openEdit("b1");
  actions.editor.requestClose();
  assert.equal(store.get().editor, null);

  actions.editor.openEdit("b1");
  actions.editor.setText("Changed.");
  actions.editor.requestClose();
  assert.equal(store.get().editor?.discardArmed, true);
  assert.equal(editorDirty(store.get().editor!), true);
  actions.editor.setText("Changed again.");
  assert.equal(store.get().editor?.discardArmed, false, "typing disarms the discard");
  actions.editor.requestClose();
  actions.editor.requestClose();
  assert.equal(store.get().editor, null);
});

test("a take switch, retake, or second editor cannot take the edited part away", async () => {
  const { actions, store, fake } = open(THREE, "b1");
  actions.editor.openEdit("b1");
  actions.editor.setText("Draft.");

  actions.story.switchTake("b1", 1);
  actions.part.retake("a1");
  actions.editor.openEdit("c1");

  assert.equal(fake.continueCalls.length, 0);
  assert.equal(store.get().editor?.partId, "b1");
  assert.equal(store.get().editor?.text, "Draft.");
  assert.equal(toasts(store).length, 3);
});

// ---------------------------------------------------------------------------
// `w`: the writer's own take, and the first part.
// ---------------------------------------------------------------------------

test("w writes the writer's own take next to the part: parentId and text only, focus on the new take", async () => {
  const landed = linearPayload(["a1", "b2"], { nodeOverrides: { b2: { text: "My own words." } } });
  const { actions, fake, store } = open(THREE, "b1", { createNode: async () => landed });

  actions.editor.openWrite("b1");
  assert.equal(store.get().editor?.text, "", "the editor opens empty");
  actions.editor.setText("  My own words.  ");
  await actions.editor.save("new");

  assert.deepEqual(fake.createNodeCalls[0]!.body, { parentId: "a1", text: "My own words." });
  assert.equal(store.get().editor, null);
  assert.equal(focusedPart(store), "b2");
});

test("w on the first part sends no parent and an empty direction", async () => {
  const landed = linearPayload(["a1"], { nodeOverrides: { a1: { text: "Once upon a time." } } });
  const { actions, fake, store } = open(linearPayload([]), null, { createNode: async () => landed });

  actions.editor.openWrite(null);
  assert.equal(store.get().editor?.mode, "first");
  actions.editor.setText("Once upon a time.");
  await actions.editor.save("new");

  assert.deepEqual(fake.createNodeCalls[0]!.body, { parentId: null, instruction: "", text: "Once upon a time." });
  assert.equal(focusedPart(store), "a1");
});

test("w refuses blank text, and Save in place does not exist for it", async () => {
  const { actions, fake, store } = open(THREE, "b1");

  actions.editor.openWrite("b1");
  await actions.editor.save("new");
  actions.editor.setText("Words.");
  await actions.editor.save("in-place");

  assert.equal(toasts(store)[0], NOTHING_TO_SAVE_TOAST);
  assert.equal(fake.createNodeCalls.length, 0);
  assert.equal(store.get().editor?.text, "Words.");
});

test("a failed w keeps the draft; a revision_conflict reloads and does not retry by itself", async () => {
  const { actions, fake, store } = open(THREE, "b1", {
    createNode: async () => { throw plainFailure("revision_conflict", "stale"); },
    loadStory: async () => THREE
  });

  actions.editor.openWrite("b1");
  actions.editor.setText("Words.");
  await actions.editor.save("new");

  assert.equal(fake.createNodeCalls.length, 1);
  assert.equal(fake.loadStoryCalls.length, 1);
  assert.equal(store.get().editor?.text, "Words.");
  assert.equal(store.get().editor?.saving, false);
});

test("an unknown outcome of w is settled by finding the new take after the reload", async () => {
  const created = linearPayload(["a1", "b2"], { nodeOverrides: { b2: { text: "Words." } } });
  const { actions, store } = open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => created
  });

  actions.editor.openWrite("b1");
  actions.editor.setText("Words.");
  await actions.editor.save("new");

  assert.equal(store.get().editor, null);
  assert.equal(focusedPart(store), "b2");
});

// ---------------------------------------------------------------------------
// `D`: delete with confirmation.
// ---------------------------------------------------------------------------

test("D asks first: the plan counts the part and the parts below it, and nothing is deleted yet", () => {
  const { actions, store, fake } = open(THREE, "b1");

  actions.part.askDelete("b1");

  const plan = store.get().partUi.deletePlan;
  assert.equal(plan?.nodeId, "b1");
  assert.equal(plan?.partNumber, 2);
  assert.equal(plan?.parts, 2, "b1 and c1");
  assert.equal(deleteQuestion(plan!), "Delete part 2 and the 1 part below it?");
  assert.equal(fake.deleteNodeCalls.length, 0);

  actions.part.cancelDelete();
  assert.equal(store.get().partUi.deletePlan, null);
});

test("confirming sends the counted subtree size, lands focus on the previous part, and closes the dialog", async () => {
  const after = linearPayload(["a1"]);
  const { actions, store, fake } = open(THREE, "b1", { deleteNode: async () => after });

  actions.part.askDelete("b1");
  await actions.part.confirmDelete();

  assert.deepEqual(fake.deleteNodeCalls, [{ storyId: STORY_ID, nodeId: "b1", count: 2 }]);
  assert.equal(store.get().partUi.deletePlan, null);
  assert.equal(focusedPart(store), "a1");
  const story = store.get().story;
  assert.equal(story.kind === "loaded" ? story.payload.path.length : -1, 1);
});

test("deleting the first part lands focus on the new first part", async () => {
  const after = linearPayload(["z1"]);
  const { actions, store } = open(THREE, "a1", { deleteNode: async () => after });

  actions.part.askDelete("a1");
  await actions.part.confirmDelete();

  assert.equal(focusedPart(store), "z1");
});

test("a conflict reloads the story, closes the dialog, and says the story was reloaded", async () => {
  const reloaded = linearPayload(["a1", "b1", "c1", "d1"]);
  const { actions, store, fake } = open(THREE, "b1", {
    deleteNode: async () => { throw plainFailure("conflict", "count changed"); },
    loadStory: async () => reloaded
  });

  actions.part.askDelete("b1");
  await actions.part.confirmDelete();

  assert.equal(fake.loadStoryCalls.length, 1);
  assert.equal(store.get().partUi.deletePlan, null);
  assert.deepEqual(toasts(store), [STORY_RELOADED_TOAST]);
  const story = store.get().story;
  assert.equal(story.kind === "loaded" ? story.payload : null, reloaded);
});

test("an unknown outcome that the reload shows as deleted counts as deleted", async () => {
  const { actions, store } = open(THREE, "b1", {
    deleteNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => linearPayload(["a1"])
  });

  actions.part.askDelete("b1");
  await actions.part.confirmDelete();

  assert.equal(store.get().partUi.deletePlan, null);
  assert.deepEqual(toasts(store), []);
  assert.equal(focusedPart(store), "a1");
});

test("D is refused while this story writes, while an editor sits in the part, and on a switching part", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const writing = open(THREE, "c1", { continueStory: () => gate.promise });
  const run = writing.actions.generation.continue();
  await waitFor(() => writing.fake.continueCalls.length === 1);
  writing.actions.part.askDelete("b1");
  assert.deepEqual(toasts(writing.store), [STORY_LOCKED_TOAST]);
  assert.equal(writing.store.get().partUi.deletePlan, null);
  gate.resolve({ payload: THREE });
  await run;

  const editing = open(THREE, "b1");
  editing.actions.editor.openEdit("b1");
  editing.actions.editor.setText("Draft.");
  editing.actions.part.askDelete("b1");
  assert.deepEqual(toasts(editing.store), [EDITOR_OPEN_TOAST]);
  assert.equal(editing.store.get().editor?.text, "Draft.");
});

test("confirming is refused if a generation started while the dialog was open", async () => {
  const gate = deferred<{ payload: StoryPayload } | null>();
  const { actions, store, fake } = open(THREE, "b1", { continueStory: () => gate.promise });
  actions.part.askDelete("b1");
  const run = actions.generation.continue();
  await waitFor(() => fake.continueCalls.length === 1);

  await actions.part.confirmDelete();

  assert.equal(fake.deleteNodeCalls.length, 0);
  assert.notEqual(store.get().partUi.deletePlan, null, "the dialog stays; nothing was lost");
  gate.resolve({ payload: THREE });
  await run;
});
