import assert from "node:assert/strict";
import test from "node:test";
import { loadLazyActions } from "../web/src/app/lazy-actions.js";
import { textHash } from "../client/api.js";
import type { StoryPayload } from "../shared/types.js";
import {
  NOTHING_TO_SAVE_TOAST,
  PART_CHANGED_TOAST,
  PART_GONE_TOAST,
  SUMMARY_FORK_TOAST
} from "../web/src/editor/actions.js";
import { editorCopyText, editorDirty } from "../web/src/editor/state.js";
import { unsavedWork } from "../web/src/app/unsaved-work.js";
import { UNRESOLVED_TOAST } from "../web/src/editor/actions.js";
import { STORY_LOCKED_TOAST, STORY_RELOADED_TOAST } from "../web/src/story/actions.js";
import { ApiFailureError } from "../client/api-error.js";
import { WebBridgeTransportError } from "../client/web-bridge-transport.js";
import {
  STORY_ID,
  stub,
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

async function open(payload: StoryPayload, focused: string | null, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, focused);
  const fake = fakeApi(apiOptions);
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions } = createActionsForStore(store);
  // The editor loads at first use; wait, so each call below acts at once.
  await loadLazyActions(actions.editor);
  return { store, fake, actions };
}

function focusedPart(store: Awaited<ReturnType<typeof open>>["store"]): string | null {
  const story = store.get().story;
  return story.kind === "loaded" ? story.focusedPartId : null;
}

const THREE = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Left it was." } } });

test("save in place sends only the changed fields, against the part as it was when the editor opened", async () => {
  const landed = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { text: "Left it was, slowly." } } });
  const { actions, fake, store } = await open(THREE, "c1", { editNode: async () => landed });

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
  const { actions, fake, store } = await open(THREE, "c1", { createNode: async () => landed });

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
  const { actions, fake, store } = await open(THREE, "b1");

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
  const { actions, fake, store } = await open(payload, "s1");

  actions.editor.openEdit("s1");
  actions.editor.setText("A better summary.");
  await actions.editor.save("new");

  assert.deepEqual(toasts(store), [SUMMARY_FORK_TOAST]);
  assert.equal(fake.createNodeCalls.length, 0);
});

test("a conflict reloads, keeps the draft, rebases onto the new part, and the next save overwrites it", async () => {
  const changed = linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Changed elsewhere." } } });
  let attempts = 0;
  const { actions, fake, store } = await open(THREE, "b1", {
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
  assert.equal(editor?.mode === "edit" ? editor.base.text : null, "Changed elsewhere.", "rebased onto the reloaded part");
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
  const { actions, store } = await open(THREE, "b1", {
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
  const { actions, fake, store } = await open(THREE, "b1", {
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
  const found = await open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => created
  });
  found.actions.editor.openEdit("b1");
  found.actions.editor.setText("Fork text.");
  await found.actions.editor.save("new");
  assert.equal(found.store.get().editor, null, "the reload shows the take: saved");
  assert.equal(focusedPart(found.store), "b2");

  const missing = await open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => THREE
  });
  missing.actions.editor.openEdit("b1");
  missing.actions.editor.setText("Fork text.");
  await missing.actions.editor.save("new");
  assert.equal(missing.store.get().editor?.text, "Fork text.", "no take found: the draft is kept");
  assert.equal(missing.fake.loadStoryCalls.length, 1);

  const inPlace = await open(THREE, "b1", {
    editNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => linearPayload(["a1", "b1", "c1"], { nodeOverrides: { b1: { instruction: "Go left.", text: "Same." } } })
  });
  inPlace.actions.editor.openEdit("b1");
  inPlace.actions.editor.setText("Same.");
  await inPlace.actions.editor.save("in-place");
  assert.equal(inPlace.store.get().editor, null, "reloaded text equals the submitted text: saved");
});

test("a definite failure keeps the draft and reloads", async () => {
  const { actions, fake, store } = await open(THREE, "b1", {
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
  const { actions, fake, store } = await open(THREE, "c1", { continueStory: () => gate.promise });
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

test("Escape closes a clean editor at once; a changed one needs a second press", async () => {
  const { actions, store } = await open(THREE, "b1");
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

// ---------------------------------------------------------------------------
// `w`: the writer's own take, and the first part.
// ---------------------------------------------------------------------------

test("w writes the writer's own take next to the part: parentId and text only, focus on the new take", async () => {
  const landed = linearPayload(["a1", "b2"], { nodeOverrides: { b2: { text: "My own words." } } });
  const { actions, fake, store } = await open(THREE, "b1", { createNode: async () => landed });

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
  const { actions, fake, store } = await open(linearPayload([]), null, { createNode: async () => landed });

  actions.editor.openWrite(null);
  assert.equal(store.get().editor?.mode, "first");
  actions.editor.setText("Once upon a time.");
  await actions.editor.save("new");

  assert.deepEqual(fake.createNodeCalls[0]!.body, { parentId: null, instruction: "", text: "Once upon a time." });
  assert.equal(focusedPart(store), "a1");
});

test("w refuses blank text, and Save in place does not exist for it", async () => {
  const { actions, fake, store } = await open(THREE, "b1");

  actions.editor.openWrite("b1");
  await actions.editor.save("new");
  actions.editor.setText("Words.");
  await actions.editor.save("in-place");

  assert.equal(toasts(store)[0], NOTHING_TO_SAVE_TOAST);
  assert.equal(fake.createNodeCalls.length, 0);
  assert.equal(store.get().editor?.text, "Words.");
});

test("a failed w keeps the draft; a revision_conflict reloads and does not retry by itself", async () => {
  const { actions, fake, store } = await open(THREE, "b1", {
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
  const { actions, store } = await open(THREE, "b1", {
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
// Review fixes: exact evidence after an unknown outcome.
// ---------------------------------------------------------------------------

test("an unknown outcome never counts a sibling that only looks alike: the full text decides", async () => {
  // Another window wrote a take under a1 whose preview and word count match
  // what this editor sent, but whose full text differs.
  const lookalike = { ...stub("b9", "a1", "Fork text."), words: 2, hasInstruction: true };
  const reloaded: StoryPayload = { ...THREE, nodes: [...THREE.nodes, lookalike] };
  const { actions, store, fake } = await open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => reloaded,
    getTakeLine: async () => ({
      forkIndex: 0,
      skipped: 0,
      parts: [{ id: "b9", parentId: "a1", instruction: "Go left.", text: "Fork text. And more from elsewhere.", model: "human", createdAt: new Date(0).toISOString(), activeChildId: null }]
    })
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("Fork text.");
  await actions.editor.save("new");

  assert.equal(store.get().editor?.text, "Fork text.", "no exact match: the draft is kept");
  assert.equal(fake.loadStoryCalls.length, 1);
});

test("an off-line take that matches exactly is found through its own line", async () => {
  const exactStub = { ...stub("b9", "a1", "Fork text."), words: 2 };
  const reloaded: StoryPayload = { ...THREE, nodes: [...THREE.nodes, exactStub] };
  const { actions, store } = await open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => reloaded,
    getTakeLine: async () => ({
      forkIndex: 0,
      skipped: 0,
      parts: [{ id: "b9", parentId: "a1", instruction: "Go left.", text: "Fork text.", model: "human", createdAt: new Date(0).toISOString(), activeChildId: null }]
    })
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("Fork text.");
  await actions.editor.save("new");

  assert.equal(store.get().editor, null);
});

test("a bridge failure that says the outcome is uncertain is reconciled, not taken as a definite failure", async () => {
  const created = linearPayload(["a1", "b2"], { nodeOverrides: { b2: { instruction: "Go left.", text: "Fork text." } } });
  const uncertain = new WebBridgeTransportError(
    { kind: "plain", code: "provider_failure", message: "unsure", status: 500 } as ConstructorParameters<typeof ApiFailureError>[0],
    "uncertain",
    undefined
  );
  const { actions, store } = await open(THREE, "b1", {
    createNode: async () => { throw uncertain; },
    loadStory: async () => created
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("Fork text.");
  await actions.editor.save("new");

  assert.equal(store.get().editor, null, "the reload shows the take: saved");
});

// ---------------------------------------------------------------------------
// Review round 3: a create that may have committed is never sent twice.
// ---------------------------------------------------------------------------

test("a lost answer whose check cannot finish keeps the request, and the next Save settles it before it creates again", async () => {
  const lookalike = { ...stub("b9", "a1", "Fork text."), words: 2, hasInstruction: true };
  const reloaded: StoryPayload = { ...THREE, nodes: [...THREE.nodes, lookalike] };
  let lineWorks = false;
  const { actions, fake, store } = await open(THREE, "b1", {
    createNode: async () => { throw new Error("socket closed"); },
    loadStory: async () => reloaded,
    getTakeLine: async () => {
      if (!lineWorks) throw new Error("line unavailable");
      return {
        forkIndex: 0,
        skipped: 0,
        parts: [{ id: "b9", parentId: "a1", instruction: "Go left.", text: "Fork text.", model: "human", createdAt: new Date(0).toISOString(), activeChildId: null }]
      };
    }
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("Fork text.");
  await actions.editor.save("new");
  assert.equal(fake.createNodeCalls.length, 1);
  assert.notEqual(store.get().editor?.pending, null, "the request is kept as evidence");
  assert.ok(toasts(store).includes(UNRESOLVED_TOAST));

  await actions.editor.save("new");
  assert.equal(fake.createNodeCalls.length, 1, "still unresolved: nothing is created again");

  lineWorks = true;
  await actions.editor.save("new");
  assert.equal(fake.createNodeCalls.length, 1, "the check found the first create: nothing is written twice");
  assert.equal(store.get().editor, null);
});

test("when the check finishes and finds nothing, the next Save creates", async () => {
  let creates = 0;
  const { actions, fake, store } = await open(THREE, "b1", {
    createNode: async () => {
      creates += 1;
      if (creates === 1) throw new Error("socket closed");
      return linearPayload(["a1", "b2"], { nodeOverrides: { b2: { instruction: "Go left.", text: "Fork text." } } });
    },
    loadStory: async () => THREE
  });

  actions.editor.openEdit("b1");
  actions.editor.setText("Fork text.");
  await actions.editor.save("new");
  // The reload succeeded and showed no new take: a plain failure, not unresolved.
  assert.equal(store.get().editor?.pending, null);
  await actions.editor.save("new");
  assert.equal(fake.createNodeCalls.length, 2);
  assert.equal(store.get().editor, null);
});

