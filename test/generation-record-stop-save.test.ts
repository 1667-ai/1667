import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { commitNode } from "../server/node-commit.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { sha256, type StoryManifestV5 } from "../server/story-format.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import type { CreateNodeRequest, GenerationSettings } from "../shared/types.js";

/**
 * Stop-and-save: the client aborts a `/continue` stream and separately posts
 * whatever text it already received back as a `createNode`, keyed by the
 * same genId. `server/node-commit.ts`'s `commitNode` is that seam. These
 * assert it now attaches the same truthful Generation Record a normal
 * completion would, sourced from what `continueStory` handed to
 * `GenerationAdmissionRegistry` the moment its own stream stopped.
 */

/** Aborts the controller as soon as the first delta arrives, so at least one
 *  dry-run word streams (and the provider layer captures effective
 *  parameters) while most of the fabricated continuation never does — a
 *  genuine partial, not a completed response that merely returns early. */
function stopAfterFirstDelta(controller: AbortController): {
  onDelta: (text: string) => void;
  text: () => string;
} {
  let text = "";
  let stopped = false;
  return {
    onDelta: (delta: string) => {
      text += delta;
      if (!stopped) {
        stopped = true;
        controller.abort();
      }
    },
    text: () => text
  };
}

test("a stopped new-take continuation's later save attaches a truthful continue record", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-stop-save-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const admission = new GenerationAdmissionRegistry();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-stop-new-take" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);

  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    { parentId: null, instruction: "Continue.", text: partial, genId: "gen-stop-new-take" } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "gen-stop-new-take");
  if (node === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(node.generationRecordIds?.length, 1);
  assert.equal(node.reasoning, true);

  const reasoning = await stories.loadReasoning(story.id, node.id);
  assert.equal(reasoning.text, "(dry-run) weighing two openings before picking one.");

  const reloaded = await stories.load(story.id);
  assert.equal(reloaded.nodes.find((candidate) => candidate.id === node.id)?.reasoning, true);

  const record = await stories.loadGenerationRecord(story.id, node.id, node.generationRecordIds![0]!);
  assert.equal(record.kind, "continue");
  assert.equal(record.range, undefined);
  assert.equal(record.provider.provider, "dry-run");
  assert.equal(record.effective.wireProtocol, "dry-run");
  assert.ok(record.prompt.entries.some((entry) => entry.kind === "request" && entry.source === "text"));
  await stories.waitForMaintenance();
});

test("a stopped append's later save attaches a record with the correct affected range", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-stop-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "Original root prose.", "");
  const rootId = root.nodes[0]!.id;
  const rootText = root.nodes[0]!.text;
  const admission = new GenerationAdmissionRegistry();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    {
      appendTo: rootId,
      expectedTextHash: sha256(rootText),
      instruction: "",
      genId: "gen-stop-append"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);

  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    {
      appendTo: rootId,
      expectedTextHash: sha256(rootText),
      instruction: "",
      text: partial,
      genId: "gen-stop-append"
    } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.id === rootId);
  if (node === undefined) throw new Error("stop-save append did not commit");
  assert.equal(node.text, rootText + partial);
  assert.equal(node.generationRecordIds?.length, 1);
  assert.equal(node.reasoning, true);

  const reasoning = await stories.loadReasoning(story.id, rootId);
  assert.equal(reasoning.text, "(dry-run) weighing two openings before picking one.");

  const record = await stories.loadGenerationRecord(story.id, rootId, node.generationRecordIds![0]!);
  assert.equal(record.kind, "append");
  assert.equal(record.range?.start, rootText.length);
  assert.equal(record.range?.end, rootText.length + partial.length);
  await stories.waitForMaintenance();
});

test("a normal successful continuation still attaches exactly one record when a later stop-save replays its genId", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-no-duplicate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const admission = new GenerationAdmissionRegistry();

  const completed = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-completed" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    () => {},
    new AbortController().signal
  );
  const node = completed?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");
  assert.equal(node.generationRecordIds?.length, 1);

  // A client that raced its own completion — the stream finished and
  // committed, but its stop-save request lands anyway — replays the same
  // genId with different text. genId dedup refuses the second commit before
  // ever touching the registry's handoff, so the story, its take, and its
  // one Generation Record are all unchanged.
  const replayed = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    { parentId: null, instruction: "Continue.", text: "A different, late partial.", genId: "gen-completed" } as CreateNodeRequest
  );
  assert.equal(replayed.nodes.length, 1);
  assert.deepEqual(replayed.nodes[0]!.generationRecordIds, node.generationRecordIds);
  await stories.waitForMaintenance();
});

test("a stopped new-take continuation's later save is rejected when the saved text is not what streamed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-stop-forged-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const admission = new GenerationAdmissionRegistry();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-stop-forged" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);

  // A client that aborted a real request, then submits different prose under
  // the same, known genId — the forged-provenance attack this check exists
  // to refuse: the model, prompt, and settings this genId actually used must
  // never attach to text that model never produced.
  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    {
      parentId: null,
      instruction: "Continue.",
      text: `Forged prose the model never wrote. ${partial}`,
      genId: "gen-stop-forged"
    } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "gen-stop-forged");
  if (node === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(node.generationRecordIds?.length, 1);
  assert.equal(node.reasoning, undefined);
  await assert.rejects(
    () => stories.loadReasoning(story.id, node.id),
    /has no stored thought/
  );

  const record = await stories.loadGenerationRecord(story.id, node.id, node.generationRecordIds![0]!);
  assert.equal(record.kind, "unsupported");
  assert.equal(record.range, undefined);
  await stories.waitForMaintenance();
});

test("a stopped append's later save is rejected when the saved text is not what streamed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-stop-append-forged-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "Original root prose.", "");
  const rootId = root.nodes[0]!.id;
  const rootText = root.nodes[0]!.text;
  const admission = new GenerationAdmissionRegistry();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    {
      appendTo: rootId,
      expectedTextHash: sha256(rootText),
      instruction: "",
      genId: "gen-stop-append-forged"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);

  // Same genId, same append target, but a different appended body than what
  // actually streamed — the client-controlled length this bug used to trust
  // would have let this through with the true generation's provenance.
  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    {
      appendTo: rootId,
      expectedTextHash: sha256(rootText),
      instruction: "",
      text: `${partial} plus forged extra words`,
      genId: "gen-stop-append-forged"
    } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.id === rootId);
  if (node === undefined) throw new Error("stop-save append did not commit");
  assert.equal(node.text, `${rootText}${partial} plus forged extra words`);
  assert.equal(node.generationRecordIds?.length, 1);
  assert.equal(node.reasoning, undefined);
  await assert.rejects(
    () => stories.loadReasoning(story.id, node.id),
    /has no stored thought/
  );

  const record = await stories.loadGenerationRecord(story.id, rootId, node.generationRecordIds![0]!);
  assert.equal(record.kind, "unsupported");
  await stories.waitForMaintenance();
});

test("a stale or unknown genId commits its text without fabricating a Generation Record", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-stale-genid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  // A fresh registry: this genId never streamed through continueStory in
  // this process, mirroring a process restart or a genId the server never
  // admitted (a forged or expired one).
  const admission = new GenerationAdmissionRegistry();

  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    { parentId: null, instruction: "Continue.", text: "Prose nobody streamed here.", genId: "never-seen" } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "never-seen");
  if (node === undefined) throw new Error("stale-genId save did not commit a take");
  assert.deepEqual(node.generationRecordIds ?? [], []);
});

test("a stop-save commit still resolves its source revision after cleanup runs between the cancel and the save", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-handoff-pin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "The lighthouse keeper checked the lamp.", "");
  const rootId = root.nodes[0]!.id;
  const rootText = root.nodes[0]!.text;
  const manifestBefore = JSON.parse(
    await readFile(path.join(dir, story.id, "manifest.json"), "utf8")
  ) as StoryManifestV5;
  const originalRevisionId = manifestBefore.nodes.find((node) => node.id === rootId)!.revisionId;

  // The real production wiring (server/story-service-runtime.ts): the
  // registry pins a handoff's source revisions straight into this same
  // StoryStore's object-sweep protection.
  const admission = new GenerationAdmissionRegistry(
    (storyId, revisionIds) => stories.pinRevisions(storyId, revisionIds)
  );
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  // A continuation off the root captures a handoff whose source cites the
  // root's current revision — then the stream is cancelled before anything
  // commits, so nothing yet keeps that revision reachable except the pin.
  const stopped = await continueStory(
    story.id,
    { parentId: rootId, instruction: "Continue.", genId: "gen-handoff-pin" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);

  // The root's own text changes before the stop-save arrives: the live
  // manifest now points at a new revision, so the original one is otherwise
  // unreachable — nothing but the handoff's pin protects it. Forcing
  // maintenance here is exactly the gap between "cancelled" and "saved" the
  // handoff has to survive.
  await stories.editNode(story.id, rootId, {
    text: "The lighthouse keeper checked the lamp, then wound the clockwork.",
    expectedTextHash: sha256(rootText)
  });
  await stories.waitForMaintenance();

  const objects = new StoryObjectStore(path.join(dir, story.id));
  // Still on disk — a leaked pin (or none at all) would have let this sweep
  // reap it, since the live manifest no longer references it and no commit
  // has happened yet to root it as a Generation Record source.
  await readFile(objects.objectPath("revisions", originalRevisionId));

  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    { parentId: rootId, instruction: "Continue.", text: partial, genId: "gen-handoff-pin" } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "gen-handoff-pin");
  if (node === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(node.generationRecordIds?.length, 1);

  const record = await stories.loadGenerationRecord(story.id, node.id, node.generationRecordIds![0]!);
  const sourceEntry = record.prompt.entries.find(
    (entry): entry is Extract<typeof record.prompt.entries[number], { source: "revisions" }> =>
      entry.source === "revisions"
  );
  assert.ok(sourceEntry !== undefined, "expected a source entry with revision references");
  const rootPart = sourceEntry.parts.find((part) => part.revisionId === originalRevisionId);
  assert.ok(rootPart !== undefined, "expected a source part citing the root's pre-edit revision");
  assert.equal(rootPart.text, rootText);

  // The commit's own Generation Record now roots the revision through the
  // ordinary sweep — the transient handoff pin has done its job and released.
  await stories.waitForMaintenance();
  await readFile(objects.objectPath("revisions", originalRevisionId));
});

function dryRunSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  };
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    load: async () => settings,
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
}
