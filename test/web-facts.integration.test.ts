import assert from "node:assert/strict";
import test from "node:test";
import type { StoryFact, StoryPayload } from "../shared/types.js";
import {
  STORY_ID,
  connectedState,
  createActionsForStore,
  fakeApi,
  linearPayload,
  lostAnswer,
  plainFailure,
  storeOpenOn,
  toasts
} from "./web-story-fixtures.js";

/**
 * Facts over a fake `StoryApi` (#409 step 7b and 7c): only what a browser
 * test cannot reach — a create whose answer was lost, a conflict, a busy
 * refusal. Real app actions.
 */

const AT = new Date(0).toISOString();

function fact(id: string, text: string, overrides: Partial<StoryFact> = {}): StoryFact {
  return {
    id, name: "Mara", tag: "people", activation: "always", keys: [], createdAt: AT, updatedAt: AT,
    states: [{ id: `${id}-s1`, text, createdAt: AT, updatedAt: AT }],
    ...overrides
  };
}

function withFacts(facts: StoryFact[]): StoryPayload {
  return { ...linearPayload(["a", "b", "c"]), facts };
}

function open(payload: StoryPayload, apiOptions: Parameters<typeof fakeApi>[0] = {}) {
  const store = storeOpenOn(payload, "b");
  const fake = fakeApi(apiOptions);
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions } = createActionsForStore(store);
  return { store, fake, actions };
}

function factsOf(store: ReturnType<typeof open>["store"]): StoryFact[] {
  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  return story.kind === "loaded" ? story.payload.facts : [];
}

function editorOf(store: ReturnType<typeof open>["store"]) {
  return store.get().facts.editor;
}

test("a create whose answer was lost is kept as pending; the next Save finds it and never sends it twice", async () => {
  const made = fact("f1", "Mara keeps the light.");
  let loads = 0;
  const { actions, fake, store } = open(withFacts([]), {
    // The reload right after the lost answer fails too; the check at the next Save works.
    loadStory: async () => {
      loads += 1;
      if (loads === 1) throw plainFailure("provider_failure", "down", 500);
      return withFacts([made]);
    },
    methods: { createFact: async () => { throw lostAnswer(); } }
  });

  actions.facts.openNew();
  actions.facts.setField("name", "Mara");
  actions.facts.setField("tag", "people");
  actions.facts.setField("text", "Mara keeps the light.");
  await actions.facts.save();
  assert.equal(fake.calls.filter((name) => name === "createFact").length, 1);
  assert.notEqual(editorOf(store)?.pending, null);
  assert.equal(editorOf(store)?.form.text, "Mara keeps the light.");
  assert.ok(toasts(store).some((message) => message.startsWith("Could not check whether")));

  await actions.facts.save();
  assert.equal(fake.calls.filter((name) => name === "createFact").length, 1);
  assert.equal(editorOf(store), null);
  assert.equal(factsOf(store).length, 1);
});

test("a pending create that left nothing behind is sent again by the next Save", async () => {
  let loads = 0;
  const { actions, fake, store } = open(withFacts([]), {
    loadStory: async () => {
      loads += 1;
      if (loads === 1) throw plainFailure("provider_failure", "down", 500);
      return withFacts([]);
    },
    methods: {
      createFact: async () => {
        if (fake.calls.filter((name) => name === "createFact").length === 1) throw lostAnswer();
        return withFacts([fact("f1", "Mara keeps the light.")]);
      }
    }
  });

  actions.facts.openNew();
  actions.facts.setField("name", "Mara");
  actions.facts.setField("tag", "people");
  actions.facts.setField("text", "Mara keeps the light.");
  await actions.facts.save();
  assert.notEqual(editorOf(store)?.pending, null);

  await actions.facts.save();
  assert.equal(fake.calls.filter((name) => name === "createFact").length, 2);
  assert.equal(editorOf(store), null);
});

test("a conflict keeps the draft, takes the other window's untouched fields, and the next Save sends only the typed ones", async () => {
  const original = fact("f1", "Mara keeps the light.");
  const changedElsewhere = fact("f1", "Mara left.", { tag: "rules" });
  const patches: unknown[] = [];
  let first = true;
  const { actions, store } = open(withFacts([original]), {
    loadStory: async () => withFacts([changedElsewhere]),
    methods: {
      patchFact: async (_storyId: string, _factId: string, patch: unknown) => {
        patches.push(patch);
        if (first) {
          first = false;
          throw plainFailure("revision_conflict", "moved");
        }
        return withFacts([fact("f1", "Mara keeps the light for years.", { tag: "rules" })]);
      }
    }
  });

  actions.facts.open("f1");
  actions.facts.setField("text", "Mara keeps the light for years.");
  await actions.facts.save();
  const armed = editorOf(store);
  assert.equal(armed?.overwriteArmed, true);
  assert.equal(armed?.form.text, "Mara keeps the light for years.");
  assert.equal(armed?.form.tag, "rules");
  assert.ok(toasts(store).includes("This fact changed in another window. Save again to overwrite."));

  await actions.facts.save();
  assert.deepEqual(patches, [{ text: "Mara keeps the light for years." }, { text: "Mara keeps the light for years." }]);
  assert.equal(editorOf(store), null);
});

test("a busy refusal at admission is retried for a fact save", async () => {
  let patches = 0;
  const { actions, store } = open(withFacts([fact("f1", "Mara keeps the light.")]), {
    methods: {
      patchFact: async () => {
        patches += 1;
        if (patches === 1) throw plainFailure("resource_busy", "busy");
        return withFacts([fact("f1", "Changed.")]);
      }
    }
  });

  actions.facts.open("f1");
  actions.facts.setField("text", "Changed.");
  await actions.facts.save();
  assert.equal(patches, 2);
  assert.equal(editorOf(store), null);
});

test("a save while a summary runs is refused and the draft stays", async () => {
  const { actions, store, fake } = open(withFacts([fact("f1", "Mara keeps the light.")]));
  store.set((state) => ({
    ...state,
    chapters: {
      ...state.chapters,
      summaryRun: { storyId: STORY_ID, storyTitle: "Test Story", breakId: "br1", chapterNumber: 1, refresh: false, phase: "running", text: "" }
    }
  }));

  actions.facts.open("f1");
  actions.facts.setField("text", "Typed during the run.");
  await actions.facts.save();
  assert.equal(fake.calls.includes("patchFact"), false);
  assert.equal(editorOf(store)?.form.text, "Typed during the run.");
  assert.ok(toasts(store).includes("Summarizing… Esc stops it first. Draft kept."));
});

test("a new state whose answer was lost is found by the reload and counted once", async () => {
  const original = fact("f1", "The door is open.");
  const after = fact("f1", "The door is open.", {
    states: [
      original.states[0]!,
      { id: "f1-s2", anchorPartId: "b", text: "The door is locked.", createdAt: AT, updatedAt: AT }
    ]
  });
  const { actions, fake, store } = open(withFacts([original]), {
    loadStory: async () => withFacts([after]),
    methods: { createFactState: async () => { throw lostAnswer(); } }
  });

  actions.facts.openNewState("f1", "b", false);
  actions.facts.setField("text", "The door is locked.");
  await actions.facts.save();
  assert.equal(fake.calls.filter((name) => name === "createFactState").length, 1);
  assert.equal(editorOf(store), null);
  assert.equal(factsOf(store)[0]!.states.length, 2);
});
