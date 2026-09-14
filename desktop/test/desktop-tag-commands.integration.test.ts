import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoryApi } from "../../client/api.js";
import { createWorkerHost } from "../../host/worker-host.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import type { StoryPayload } from "../../shared/types.js";
import { INITIAL_STATE, type RendererState } from "../renderer-model.js";
import { manageTags } from "../renderer-tag-commands.js";
import { tagLine } from "../renderer-story-commands.js";
import type { RendererCommandContext } from "../renderer-command-context.js";

test("cancelling a line tag status does not save an empty status", async () => {
  const fixture = await createTagFixture();
  try {
    const context = commandContext(fixture.api, fixture.story, {
      textDialog: async () => "A named line",
      choiceDialog: async () => null
    });
    await tagLine(context, fixture.story.path.at(-1)!);

    const persisted = await fixture.api.loadStory(fixture.story.id);
    assert.deepEqual(persisted.tags, []);
  } finally {
    await fixture.host.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("tag manager edits a tag anchored outside the active path", async () => {
  const fixture = await createTagFixture();
  try {
    assert.equal(fixture.story.path.some((node) => node.id === fixture.offPathNodeId), false);
    let story = await fixture.api.putBookmark(
      fixture.story.id,
      fixture.offPathNodeId,
      "Old name",
      "Draft"
    );
    const context = commandContext(fixture.api, story, {
      textDialog: async () => "Renamed line",
      choiceDialog: async (title, options) => title === "Tag action"
        ? "Edit tag"
        : title === "Line tag status"
          ? "Canon"
          : options[0]!
    });

    await manageTags(context);

    story = await fixture.api.loadStory(story.id);
    assert.deepEqual(story.tags.map(({ nodeId, name, status }) => ({ nodeId, name, status })), [{
      nodeId: fixture.offPathNodeId,
      name: "Renamed line",
      status: "Canon"
    }]);
  } finally {
    await fixture.host.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createTagFixture(): Promise<{
  readonly directory: string;
  readonly host: Awaited<ReturnType<typeof createWorkerHost>>;
  readonly api: StoryApi;
  readonly story: StoryPayload;
  readonly offPathNodeId: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-tags-"));
  const machineDir = path.join(directory, "machine");
  await mkdir(machineDir, { mode: 0o700 });
  const host = await createWorkerHost({
    dataDir: path.join(directory, "project"),
    machineDir,
    projectOwner: "desktop"
  });
  const api = storyApiFromWorkerTransport(host.transport);
  try {
    let story = await api.createStory("Tag command proof");
    story = await api.createNode(story.id, { parentId: null, text: "Active branch" });
    const activeNodeId = story.path.at(-1)!.id;
    story = await api.createNode(story.id, { parentId: null, text: "Off-path branch" });
    const offPathNodeId = story.path.at(-1)!.id;
    story = await api.switchLine(story.id, activeNodeId);
    return { directory, host, api, story, offPathNodeId };
  } catch (error) {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function commandContext(
  api: StoryApi,
  initialStory: StoryPayload,
  dialogs: Pick<RendererCommandContext, "textDialog" | "choiceDialog">
): RendererCommandContext {
  let story = initialStory;
  let state: RendererState = { ...INITIAL_STATE };
  return {
    state: () => state,
    api: () => api,
    story: () => story,
    setState: (update) => { state = { ...state, ...update }; },
    replaceStory: async (next) => { story = next; },
    refresh: async () => undefined,
    setDraft: () => undefined,
    run: async (_status, work) => await work(),
    textDialog: dialogs.textDialog,
    choiceDialog: dialogs.choiceDialog,
    formDialog: async () => null,
    confirmDialog: async () => true,
    confirmDiscardDrafts: async () => true,
    discardDrafts: async () => undefined,
    getAsideController: () => null,
    setAsideController: () => undefined
  };
}
