import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import { createWorkerHost } from "../../host/worker-host.js";
import type { StoryApi } from "../../client/api.js";
import { INITIAL_STATE, type RendererState } from "../renderer-model.js";
import type { RendererCommandContext } from "../renderer-command-context.js";
import { createFact, editFactState, runFactConsistency, summarizeChapter } from "../renderer-story-commands.js";

test("Fact commands create from selection and edit state scope and value", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-facts-"));
  await mkdir(path.join(directory, "machine"), { mode: 0o700 });
  const host = await createWorkerHost({
    dataDir: path.join(directory, "project"),
    machineDir: path.join(directory, "machine"),
    projectOwner: "desktop"
  });
  const api = storyApiFromWorkerTransport(host.transport);
  try {
    let story = await api.createStory("Fact command proof");
    story = await api.createNode(story.id, { parentId: null, text: "The blue door opens." });
    const root = story.path.at(-1)!;
    story = await api.createNode(story.id, { parentId: root.id, text: "A bell rings." });
    const activePart = story.path.at(-1)!;
    let nextForm: Record<string, string> | null = {
      text: "",
      scope: "After active part",
      ends: "Yes"
    };
    const context = commandContext(api, story, {
      textDialog: async (title) => title === "Fact name" ? "Door color" : "The door is blue.",
      formDialog: async () => nextForm
    });

    const start = root.text.indexOf("blue");
    await createFact(context, root, { start, end: start + 4, expected: "blue" });
    story = await api.loadStory(story.id);
    const fact = story.facts[0]!;
    assert.equal(fact.name, "Door color");
    assert.equal(fact.states[0]?.anchorPartId, root.id);
    assert.equal("text" in fact.states[0]!, true);
    if (!("text" in fact.states[0]!)) throw new Error("selection Fact did not create a text state");
    assert.equal(fact.states[0].text, "The door is blue.");

    await editFactState(context, fact, fact.states[0]!);
    story = await api.loadStory(story.id);
    const endedFact = story.facts[0]!;
    const ended = endedFact.states[0]!;
    assert.equal("ends" in ended && ended.ends === true, true);
    assert.equal(ended.anchorPartId, activePart.id);

    nextForm = { text: "The door is blue and open.", scope: "Story-wide", ends: "No" };
    await editFactState(context, endedFact, ended);
    story = await api.loadStory(story.id);
    const updated = story.facts[0]!.states[0]!;
    assert.equal("text" in updated && updated.text, "The door is blue and open.");
    assert.equal(updated.anchorPartId, undefined);
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("late Fact and chapter results keep the selected story and its drafts", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-facts-navigation-"));
  const host = await createWorkerHost({ dataDir: path.join(directory, "project"),
    machineDir: path.join(directory, "machine"), projectOwner: "desktop" });
  const api = storyApiFromWorkerTransport(host.transport);
  try {
    let first = await api.createStory("First story");
    first = await api.createNode(first.id, { parentId: null, text: "A blue door opens." });
    const second = await api.createStory("Second story");
    for (const phase of ["plan", "check", "connection", "summary"] as const) {
      first = await api.loadStory(first.id);
      let release!: () => void;
      let notify!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { notify = resolve; });
      const delayedApi: StoryApi = {
        ...api,
        planFactConsistency: async (input) => {
          const result = await api.planFactConsistency!(input);
          if (phase === "plan") { notify(); await pending; }
          return result;
        },
        checkFactConsistency: async (input) => {
          const result = await api.checkFactConsistency!(input);
          notify();
          await pending;
          return result;
        },
        summarizeChapter: async (storyId) => {
          const result = await api.loadStory(storyId);
          notify();
          await pending;
          return result;
        }
      };
      let activeApi = delayedApi;
      let confirmations = 0;
      const context = {
        ...commandContext(delayedApi, first, { textDialog: async () => null, formDialog: async () => null }),
        api: () => activeApi,
        confirmDialog: async () => { confirmations++; return true; }
      };
      const check = phase === "summary"
        ? summarizeChapter(context, "", "Opening chapter")
        : runFactConsistency(context, "story-line");
      await started;
      if (phase === "connection") activeApi = api;
      else await context.replaceStory(second);
      const selectedStory = context.state().story;
      context.setState({ factConsistencyBusy: false, status: "Writing", drafts: { composer: "Keep this direction.", "authors-note": "Keep this note." } });
      release();
      await check;
      assert.equal(context.state().story, selectedStory, phase);
      assert.equal(context.state().status, "Writing", phase);
      assert.equal(context.state().factConsistency, null, phase);
      assert.equal(context.state().drafts.composer, "Keep this direction.");
      assert.equal(context.state().drafts["authors-note"], "Keep this note.");
      assert.equal(confirmations, phase === "plan" || phase === "summary" ? 0 : 1);
    }
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function commandContext(
  api: StoryApi,
  initialStory: Awaited<ReturnType<StoryApi["loadStory"]>>,
  dialogs: Pick<RendererCommandContext, "textDialog" | "formDialog">
): RendererCommandContext {
  let story = initialStory;
  let state: RendererState = { ...INITIAL_STATE, story: initialStory };
  return {
    state: () => state,
    api: () => api,
    story: () => story,
    setState: (update) => { state = { ...state, ...update }; },
    replaceStory: async (next) => { story = next; state = { ...state, story: next }; },
    refresh: async () => undefined,
    setDraft: () => undefined,
    run: async (_status, work) => await work(),
    textDialog: dialogs.textDialog,
    choiceDialog: async () => null,
    formDialog: dialogs.formDialog,
    confirmDialog: async () => true,
    confirmDiscardDrafts: async () => true,
    discardDrafts: async () => undefined,
    getAsideController: () => null,
    setAsideController: () => undefined
  };
}
