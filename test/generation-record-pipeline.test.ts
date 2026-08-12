import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
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

const providerPipelineTest = ownedLoopbackHttpSupported() ? test : test.skip;

providerPipelineTest("a nonofficial OpenAI record captures the provider-folded Author's Note and a full valid model id", async (t) => {
  let requestBody: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "The lamp flared." }, finish_reason: null }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-folded-note-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "The lighthouse stood alone.", "Hold the line.");
  const rootId = root.nodes[0]!.id;
  const note = "The keeper caused the storm.";
  await stories.mutate(story.id, (current) => setAuthorsNote(current, note, 1));
  const model = "m".repeat(512);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const continued = await continueStory(
    story.id,
    { parentId: rootId, instruction: "Continue.", genId: "gen-folded-note" },
    stories,
    stubSettingsStore(openAiSettings(baseUrl, model)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const generated = continued?.nodes.find((node) => node.parentId === rootId);
  if (generated === undefined) throw new Error("continuation did not commit a take");
  const recordId = generated.generationRecordIds?.[0];
  if (recordId === undefined) throw new Error("continuation did not commit a Generation Record");
  const record = await stories.loadGenerationRecord(story.id, generated.id, recordId);

  assert.equal(record.provider.model, model);
  assert.equal(record.prompt.entries.some((entry) => entry.kind === "authors-note"), false);
  const source = record.prompt.entries.find(
    (entry): entry is Extract<typeof record.prompt.entries[number], { source: "revisions" }> =>
      entry.source === "revisions"
  );
  assert.equal(source?.parts[0]?.instruction, `${note}\n\nHold the line.`);

  const messages = (requestBody as unknown as { messages?: unknown } | null)?.messages;
  assert.ok(Array.isArray(messages));
  const foldedUser = messages.find((message) =>
    message !== null && typeof message === "object"
    && (message as { role?: unknown }).role === "user"
    && String((message as { content?: unknown }).content).startsWith(note));
  assert.ok(foldedUser !== undefined, "the provider request must contain the same folded user turn");
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

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * An unmigrated legacy JSON story's nodes carry prose but never went through
 * `attachStoredNodeText` — nothing has minted a reusable immutable revision
 * for them yet, since that only happens when a v5/v6 manifest is decoded.
 * The first continuation or append against such a story must still let the
 * provider run and the commit (and its migration to the current format)
 * succeed, but the Generation Record it attaches must say so honestly
 * instead of silently omitting the legacy context it could not cite.
 */
test("a legacy story's first continuation still commits and migrates, but its Generation Record is unsupported", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-legacy-continue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();

  const legacyId = "legacy-continue";
  const legacyText = "Written before Generation Records existed.";
  await writeFile(path.join(dir, `${legacyId}.json`), JSON.stringify({
    id: legacyId,
    title: "Legacy",
    createdAt: NOW,
    updatedAt: NOW,
    parts: [{ id: "p1", instruction: "Go", text: legacyText, model: "m", createdAt: NOW }]
  }));

  const continued = await continueStory(
    legacyId,
    { parentId: "p1", instruction: "Continue.", genId: "gen-legacy-continue" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const generated = continued?.nodes.find((node) => node.parentId === "p1");
  if (generated === undefined) throw new Error("continuation did not commit a take");
  const recordId = generated.generationRecordIds?.[0];
  if (recordId === undefined) throw new Error("continuation did not commit a Generation Record");
  const record = await stories.loadGenerationRecord(legacyId, generated.id, recordId);

  assert.equal(record.kind, "unsupported");
  assert.equal(record.prompt.entries.length, 0, "an unsupported record must carry no partial/truncated prompt entries");
  assert.match(record.unsupportedReason ?? "", /reusable stored revision/);

  // The commit still migrated the legacy file to the current bundle format.
  await assert.rejects(readFile(path.join(dir, `${legacyId}.json`)));
  await readFile(path.join(dir, legacyId, "manifest.json"));
});

test("a legacy story's first append still commits and migrates, but its Generation Record is unsupported", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-legacy-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();

  const legacyId = "legacy-append";
  const legacyText = "Written before Generation Records existed.";
  await writeFile(path.join(dir, `${legacyId}.json`), JSON.stringify({
    id: legacyId,
    title: "Legacy",
    createdAt: NOW,
    updatedAt: NOW,
    parts: [{ id: "p1", instruction: "Go", text: legacyText, model: "m", createdAt: NOW }]
  }));

  const continued = await continueStory(
    legacyId,
    { appendTo: "p1", genId: "gen-legacy-append", expectedTextHash: sha256(legacyText) },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const appended = continued?.nodes.find((node) => node.id === "p1");
  if (appended === undefined) throw new Error("append did not commit");
  assert.ok(appended.text.length > legacyText.length, "expected the append to extend the take's text");
  const recordId = appended.generationRecordIds?.at(-1);
  if (recordId === undefined) throw new Error("append did not commit a Generation Record");
  const record = await stories.loadGenerationRecord(legacyId, "p1", recordId);

  assert.equal(record.kind, "unsupported");
  assert.equal(record.prompt.entries.length, 0, "an unsupported record must carry no partial/truncated prompt entries");
  assert.match(record.unsupportedReason ?? "", /reusable stored revision/);

  // The commit still migrated the legacy file to the current bundle format.
  await assert.rejects(readFile(path.join(dir, `${legacyId}.json`)));
  await readFile(path.join(dir, legacyId, "manifest.json"));
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

function openAiSettings(baseUrl: string, model: string): GenerationSettings {
  return attachProviderRuntime({
    provider: "openai-compatible",
    baseUrl,
    model,
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  }, {
    preset: "custom",
    protocol: "openai-chat-completions",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 2_000,
      firstTokenMs: 2_000,
      idleMs: 2_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT }),
    loadImageInputCapability: async () => null
  } as unknown as SettingsStore;
}
