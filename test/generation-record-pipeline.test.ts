import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { sha256, type StoryManifestV5 } from "../server/story-format.js";
import { StoryStore } from "../server/stories.js";
import { setAuthorsNote } from "../server/story-authors-note.js";
import type { SettingsStore } from "../server/settings.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { ResolvedGenerationRecord } from "../shared/generation-record.js";
import type { GenerationSettings } from "../shared/types.js";

/**
 * Generation Records: every model request that creates or changes a take
 * gets a durable, content-addressed record beside it (mirrors issue #291's
 * token-probability storage — see test/token-probability-storage.test.ts).
 * The dry-run provider fabricates deterministic completions, which is what
 * makes these end-to-end assertions possible without a real model.
 *
 * This file covers the ordered, categorized prompt pipeline a record
 * captures — Author's Note placement and per-part source instructions — and
 * a superseded revision's continued liveness while a record still cites it.
 * See test/generation-record-lifecycle.test.ts for the per-commit lifecycle.
 */

test("a continuation's Generation Record preserves the ordered, categorized pipeline, including Author's Note placement and per-part instructions", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-pipeline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const root = await stories.createNode(story.id, null, "The lighthouse stood alone.", "Chapter one begins.");
  const rootId = root.nodes[0]!.id;
  const withChild = await stories.createNode(story.id, rootId, "Rain lashed the windows.", "Then the storm came.");
  const childId = withChild.nodes.find((node) => node.parentId === rootId)!.id;

  // Depth 1: the note lands after the most recent one part (the child),
  // ahead of the root — splitting the story's context into two source runs
  // with the note positioned exactly between them, the same placement the
  // Next Request preview shows.
  await stories.mutate(story.id, (current) => {
    setAuthorsNote(current, "The lighthouse keeper is secretly the storm's cause.", 1);
  });

  const continued = await continueStory(
    story.id,
    { parentId: childId, instruction: "Continue.", genId: "gen-pipeline" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const generatedId = continued?.nodes.find((node) => node.parentId === childId)?.id;
  if (generatedId === undefined) throw new Error("continuation did not commit a take");
  const recordId = continued!.nodes.find((node) => node.id === generatedId)!.generationRecordIds![0]!;
  const record = await stories.loadGenerationRecord(story.id, generatedId, recordId);

  const kinds = record.prompt.entries.map((entry) => entry.kind);
  const noteIndex = kinds.indexOf("authors-note");
  const requestIndex = kinds.indexOf("request");
  assert.notEqual(noteIndex, -1, "expected an authors-note entry");
  assert.notEqual(requestIndex, -1, "expected a trailing request entry");
  const sourceIndexes = kinds.reduce<number[]>((found, kind, index) => {
    if (kind === "source") found.push(index);
    return found;
  }, []);
  assert.equal(sourceIndexes.length, 2, "expected the story context split into a run before and a run after the note");
  const [beforeNoteIndex, afterNoteIndex] = sourceIndexes;
  assert.ok(beforeNoteIndex! < noteIndex, "the root's context must precede the Author's Note");
  assert.ok(noteIndex < afterNoteIndex!, "the child's context must follow the Author's Note");
  assert.ok(afterNoteIndex! < requestIndex, "every context part precedes the volatile request");

  const beforeNoteEntry = record.prompt.entries[beforeNoteIndex!];
  const afterNoteEntry = record.prompt.entries[afterNoteIndex!];
  if (beforeNoteEntry === undefined || beforeNoteEntry.source !== "revisions") throw new Error("expected a resolved source entry before the note");
  if (afterNoteEntry === undefined || afterNoteEntry.source !== "revisions") throw new Error("expected a resolved source entry after the note");

  assert.equal(beforeNoteEntry.parts.length, 1);
  assert.equal(beforeNoteEntry.parts[0]?.nodeId, rootId);
  assert.equal(beforeNoteEntry.parts[0]?.category, "recent");
  assert.equal(beforeNoteEntry.parts[0]?.instruction, "Chapter one begins.");
  assert.equal(beforeNoteEntry.parts[0]?.text, "The lighthouse stood alone.");

  assert.equal(afterNoteEntry.parts.length, 1);
  assert.equal(afterNoteEntry.parts[0]?.nodeId, childId);
  assert.equal(afterNoteEntry.parts[0]?.category, "recent");
  assert.equal(afterNoteEntry.parts[0]?.instruction, "Then the storm came.");
  assert.equal(afterNoteEntry.parts[0]?.text, "Rain lashed the windows.");
});

test("a superseded revision stays on disk while a Generation Record still cites it as source", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-source-liveness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const root = await stories.createNode(story.id, null, "The lighthouse keeper checked the lamp.", "");
  const rootId = root.nodes[0]!.id;
  const manifestBefore = JSON.parse(
    await readFile(path.join(dir, story.id, "manifest.json"), "utf8")
  ) as StoryManifestV5;
  const originalRevisionId = manifestBefore.nodes.find((node) => node.id === rootId)!.revisionId;

  // A continuation whose source includes the root: its Generation Record
  // cites the root's revision at this exact moment.
  const continued = await continueStory(
    story.id,
    { parentId: rootId, instruction: "Continue.", genId: "gen-source-liveness" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const childId = continued!.nodes.find((node) => node.parentId === rootId)!.id;

  // Now the root's own text changes — a human edit mints a new revision, so
  // nothing in the current manifest points at the original one any more,
  // except the child's Generation Record.
  await stories.editNode(story.id, rootId, {
    text: "The lighthouse keeper checked the lamp, then wound the clockwork.",
    expectedTextHash: sha256(root.nodes[0]!.text)
  });
  await stories.waitForMaintenance();

  const objects = new StoryObjectStore(path.join(dir, story.id));
  await readFile(objects.objectPath("revisions", originalRevisionId)); // still present — throws otherwise

  const manifestAfter = JSON.parse(
    await readFile(path.join(dir, story.id, "manifest.json"), "utf8")
  ) as StoryManifestV5;
  assert.notEqual(manifestAfter.nodes.find((node) => node.id === rootId)!.revisionId, originalRevisionId);

  const childRecordId = manifestAfter.nodes.find((node) => node.id === childId)!.generationRecordIds![0]!;
  const record = await stories.loadGenerationRecord(story.id, childId, childRecordId);
  const sourceEntry = record.prompt.entries.find(
    (entry): entry is Extract<ResolvedGenerationRecord["prompt"]["entries"][number], { source: "revisions" }> =>
      entry.source === "revisions"
  );
  assert.ok(sourceEntry !== undefined, "expected a source entry with revision references");
  const rootPart = sourceEntry.parts.find((part) => part.revisionId === originalRevisionId);
  assert.ok(rootPart !== undefined, "expected a source part citing the root's original revision");
  // The record must show the root's exact historical prose, resolved from
  // the revision it referenced — never the root's current (since-edited)
  // text, even though both live on the very same node id.
  assert.equal(rootPart.text, "The lighthouse keeper checked the lamp.");
  assert.equal(rootPart.nodeId, rootId);
});

function dryRunSettings(): GenerationSettings {
  return attachProviderRuntime({
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  }, {
    preset: "dry-run",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unsupported",
      reasoningEffort: "unsupported",
      promptCaching: "unsupported"
    }
  }, true);
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;
}
