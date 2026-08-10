import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { type ObjectHash } from "../server/story-format.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

/**
 * Performance-contract regression for the fix to StoryObjectStore.verifyGraph
 * reparsing every historical Generation Record on every save (cumulative
 * O(n^2) work as a story accumulates records — see
 * server/story-objects.ts's adoptKnownGenerationRecordGraph and
 * server/story-aggregate-session.ts's cross-session generationRecordGraph).
 *
 * StoryObjectStore.prototype.readGenerationRecord is the one place a record
 * is parsed back from disk, so counting its calls across a chain of saves is
 * a direct measurement of reparsing, not a proxy for it.
 */
test("repeated saves do not reparse previously-verified Generation Records", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-graph-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const reads: ObjectHash[] = [];
  const originalReadGenerationRecord = StoryObjectStore.prototype.readGenerationRecord;
  t.mock.method(
    StoryObjectStore.prototype,
    "readGenerationRecord",
    async function (this: StoryObjectStore, hash: ObjectHash) {
      reads.push(hash);
      return await originalReadGenerationRecord.call(this, hash);
    }
  );

  const RECORD_COUNT = 6;
  let parentId: string | null = null;
  let lastRecordId: string | null = null;
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const result = await continueStory(
      story.id,
      { parentId, instruction: "Continue.", genId: `gen-${index}` },
      stories,
      stubSettingsStore(dryRunSettings()),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
    );
    const node = result?.nodes.find((candidate) => candidate.parentId === parentId);
    if (node === undefined) throw new Error("continuation did not commit a take");
    assert.equal(node.generationRecordIds?.length, 1);
    parentId = node.id;
    lastRecordId = node.generationRecordIds![0]!;
  }

  // Six chained saves accumulate six live Generation Records. Each save's
  // own new record is learned from the write that creates it, never from a
  // read-back — so if every prior record were also reparsed every save (the
  // regression this guards), this would total 0+1+2+3+4+5 = 15 reads. The
  // cross-session graph cache keeps every one of those reads at zero: a
  // record's source revisions are hash-verified once and reused for as long
  // as the manifest that committed them stays current.
  assert.deepEqual(reads, [], `expected no reparsing across ${RECORD_COUNT} saves, got reads of: ${reads.join(", ")}`);

  // Positive control: an on-demand read of that same record (the record
  // detail route) still goes through this exact method, proving the mock
  // observes real reads rather than the assertion above passing by accident
  // (e.g. because the mock never actually intercepted anything).
  if (parentId === null || lastRecordId === null) throw new Error("no chained node was committed");
  await stories.loadGenerationRecord(story.id, parentId, lastRecordId);
  assert.deepEqual(reads, [lastRecordId]);
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
