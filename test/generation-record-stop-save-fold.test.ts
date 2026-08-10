import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { commitNode } from "../server/node-commit.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { setAuthorsNote } from "../server/story-authors-note.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { CreateNodeRequest, GenerationSettings } from "../shared/types.js";

/**
 * The stop-and-save handoff (`server/generation-record-handoff.ts`) is a
 * second, separate seam that must apply the same Author's Note lowering a
 * completed continuation's direct commit applies (see
 * test/generation-record-pipeline.test.ts's "provider-folded Author's Note"
 * case) — its own Generation Record is built from a handoff captured the
 * moment the stream stopped, not from the live `ContinuationPlan` a direct
 * commit still has in hand.
 */

/** Aborts as soon as the first delta arrives, mirroring
 *  test/generation-record-stop-save.test.ts's own helper. */
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

const stopFoldTest = ownedLoopbackHttpSupported() ? test : test.skip;

stopFoldTest("a stopped continuation's stop-save record folds the Author's Note exactly as the provider request did", async (t) => {
  let requestBody: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "The lamp flared." }, finish_reason: null }] })}\n\n`);
    // Never ends the stream — the client aborts after the first delta below.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-stop-fold-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "The lighthouse stood alone.", "Hold the line.");
  const rootId = root.nodes[0]!.id;
  const note = "The keeper caused the storm.";
  await stories.mutate(story.id, (current) => setAuthorsNote(current, note, 1));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const settings = openAiSettings(baseUrl);
  const admission = new GenerationAdmissionRegistry();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: rootId, instruction: "Continue.", genId: "gen-stop-fold" },
    stories,
    stubSettingsStore(settings),
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
    stubSettingsStore(settings),
    admission,
    story.id,
    { parentId: rootId, instruction: "Continue.", text: partial, genId: "gen-stop-fold" } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "gen-stop-fold");
  if (node === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(node.generationRecordIds?.length, 1);

  const record = await stories.loadGenerationRecord(story.id, node.id, node.generationRecordIds![0]!);
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
  assert.ok(foldedUser !== undefined, "the provider request must contain the same folded user turn the record cites");
  await stories.waitForMaintenance();
});

function openAiSettings(baseUrl: string): GenerationSettings {
  return attachProviderRuntime({
    provider: "openai-compatible",
    baseUrl,
    model: "m".repeat(64),
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
    load: async () => settings,
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;
}
