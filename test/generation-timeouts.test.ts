import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { continueStory, rewriteNode } from "../server/generation-http.js";
import {
  GenerationResultError,
  GenerationStoppedError,
  ProviderError,
  ServiceError
} from "../server/errors.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { PartialRewriteStash } from "../server/rewrite-partial.js";
import { classifyServiceError } from "../server/service-error-policy.js";
import type { SettingsStore } from "../server/settings.js";
import { sha256 } from "../server/story-format.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import { applyProviderStoryEffect } from "../server/story-provider-effect.js";
import {
  createFailureEnvelope,
  isTimeoutClassFailure
} from "../shared/failure-envelope.js";
import { createHttpOperationLease } from "../shared/http-operation-lease.js";
import { rewriteStreamDigest } from "../shared/rewrite-partial-contract.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import {
  fakeModel,
  modelSettings,
  providerTest,
  stream
} from "./provider-http-fixture.js";

// Small enough that a stalled fake model trips the idle or total deadline in
// well under the providerTest budget, large enough that a healthy exchange
// never does.
const FAST_TIMEOUTS = {
  responseHeaderMs: 5_000,
  firstTokenMs: 5_000,
  idleMs: 400,
  totalMs: 15_000
};

function timedSettings(
  baseUrl: string,
  options: {
    assistantPrefill: "supported" | "unsupported";
    timeouts?: typeof FAST_TIMEOUTS;
  }
): GenerationSettings {
  return attachProviderRuntime(modelSettings(baseUrl), {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts: options.timeouts ?? FAST_TIMEOUTS,
    allowInsecureHttp: true,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: options.assistantPrefill,
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;
}

const STORY_TEXT = "A grey cat slept on the warm stone by the door.";
const SELECTION = "slept on the warm stone";

function fixtureStory(): { story: Story; nodeId: string; start: number; end: number } {
  const nodeId = "timeout-root";
  const start = STORY_TEXT.indexOf(SELECTION);
  return {
    story: {
      id: "timeout-story",
      title: "Timeouts",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{
        id: nodeId,
        parentId: null,
        instruction: "Open.",
        text: STORY_TEXT,
        model: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        activeChildId: null
      }],
      activeRootId: nodeId,
      tags: [],
      recentNodeIds: [],
      facts: [],
      chapterBreaks: []
    },
    nodeId,
    start,
    end: start + SELECTION.length
  };
}

function refusingStories<M extends "continueStory" | "rewriteNode">(
  story: Story
): ProviderStoryRuntime<M> {
  return {
    loadForMutation: async () => story,
    hydratePath: async () => {},
    commitProviderEffect: async () => {
      throw new Error("commitProviderEffect must not run for a rejected or failed generation");
    }
  } as unknown as ProviderStoryRuntime<M>;
}

/** SSE headers plus deltas, then silence: the stream stays open so only the
 * idle deadline can end it. */
function stall(response: ServerResponse, chunks: readonly string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const content of chunks) {
    response.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content }, finish_reason: null }]
      })}\n\n`
    );
  }
}

/** A delta every 150 ms forever, so only the total deadline can end it. */
function drip(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const timer = setInterval(() => {
    response.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "drip " }, finish_reason: null }]
      })}\n\n`
    );
  }, 150);
  response.once("close", () => clearInterval(timer));
}

function timeoutEnvelope(error: unknown) {
  return createFailureEnvelope(classifyServiceError(error).publicError);
}

providerTest("generation timeouts: a provider idle timeout keeps streamed prose and carries provider-idle provenance", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    stall(response, ["The cat ", "stretched slowly"]);
  });
  const { story, nodeId } = fixtureStory();
  const streamed: string[] = [];

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: nodeId, instruction: "Continue.", genId: "idle-gen" },
      refusingStories<"continueStory">(story),
      stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "supported" })),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      (delta) => { streamed.push(delta); },
      new AbortController().signal
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.timeout, "provider-idle");
      assert.match(error.message, /idle beyond the configured deadline/);
      const envelope = timeoutEnvelope(error);
      assert.equal(envelope.code, "provider_failure");
      assert.equal(envelope.timeout, "provider-idle");
      assert.ok(isTimeoutClassFailure(envelope));
      return true;
    }
  );
  // The prose that streamed before the deadline reached the caller intact;
  // preserving it is the caller's decision, not a lost cause.
  assert.equal(streamed.join(""), "The cat stretched slowly");
  assert.equal(story.nodes.length, 1);
  assert.equal(story.nodes[0]!.text, STORY_TEXT);
});

providerTest("generation timeouts: a provider total timeout carries provider-total provenance", async (t) => {
  const model = await fakeModel(t, (_body, response) => { drip(response); });
  const { story, nodeId } = fixtureStory();
  const streamed: string[] = [];

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: nodeId, instruction: "Continue.", genId: "total-gen" },
      refusingStories<"continueStory">(story),
      stubSettingsStore(timedSettings(model.baseUrl, {
        assistantPrefill: "supported",
        timeouts: { responseHeaderMs: 5_000, firstTokenMs: 5_000, idleMs: 5_000, totalMs: 900 }
      })),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      (delta) => { streamed.push(delta); },
      new AbortController().signal
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.timeout, "provider-total");
      const envelope = timeoutEnvelope(error);
      assert.equal(envelope.timeout, "provider-total");
      assert.ok(isTimeoutClassFailure(envelope));
      return true;
    }
  );
  assert.ok(streamed.join("").startsWith("drip"));
  assert.equal(story.nodes.length, 1);
});

providerTest("generation timeouts: an idle timeout after a rejected continuation echo is the rejection, not a timeout", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    // Never echoes the required left boundary, then stalls into the idle
    // deadline: a timeout masking an exact-echo rejection.
    stall(response, ["#".repeat(700)]);
  });
  const { story, nodeId } = fixtureStory();

  await assert.rejects(
    continueStory(
      story.id,
      // Appending to the unfinished passage is the one continuation shape
      // that uses the exact left-boundary echo contract on a no-prefill
      // provider (docs/generation-boundaries.md).
      {
        appendTo: nodeId,
        expectedTextHash: sha256(STORY_TEXT),
        instruction: "",
        genId: "masked-gen"
      },
      refusingStories<"continueStory">(story),
      stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "unsupported" })),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
    ),
    (error: unknown) => {
      assert.ok(error instanceof GenerationResultError);
      assert.match(error.message, /did not continue from the exact final characters/);
      const envelope = timeoutEnvelope(error);
      assert.equal(envelope.timeout, undefined);
      assert.equal(isTimeoutClassFailure(envelope), false);
      return true;
    }
  );
  assert.equal(story.nodes.length, 1);
  assert.equal(story.nodes[0]!.text, STORY_TEXT);
});

providerTest("generation timeouts: Stop cannot settle a continuation after its exact echo was rejected", async (t) => {
  const controller = new AbortController();
  const model = await fakeModel(t, (_body, response) => {
    stall(response, ["#".repeat(700)]);
    setTimeout(() => controller.abort(), 150);
  });
  const { story, nodeId } = fixtureStory();

  await assert.rejects(
    continueStory(
      story.id,
      {
        appendTo: nodeId,
        expectedTextHash: sha256(STORY_TEXT),
        instruction: "",
        genId: "stopped-rejected-gen"
      },
      refusingStories<"continueStory">(story),
      stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "unsupported" })),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      controller.signal
    ),
    (error: unknown) => error instanceof GenerationResultError
      && /did not continue from the exact final characters/.test(error.message)
  );
  assert.equal(story.nodes[0]!.text, STORY_TEXT);
});

providerTest("generation timeouts: a stopped rewrite stashes the streamed partial and the settle splices exactly the selected range", async (t) => {
  const controller = new AbortController();
  const model = await fakeModel(t, (_body, response) => {
    stall(response, ["rested on the cool step"]);
    // Stop once the partial is on the wire; the response never completes.
    setTimeout(() => controller.abort(), 150);
  });
  const { story, nodeId, start, end } = fixtureStory();
  const partials = new PartialRewriteStash();

  const result = await rewriteNode(
    story.id,
    nodeId,
    { start, end, expected: SELECTION, instruction: "", attemptId: "stopped-attempt" },
    refusingStories<"rewriteNode">(story),
    stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "supported" })),
    new PromptCacheRuntime(),
    () => {},
    controller.signal,
    undefined,
    "partial-rewrite-id",
    "partial-take-id",
    undefined,
    partials
  );
  assert.equal(result, null);
  assert.equal(story.nodes[0]!.text, STORY_TEXT);

  const record = partials.get(story.id, nodeId, "stopped-attempt");
  assert.ok(record, "a stopped rewrite with a verified partial must stash it");
  assert.equal(
    record.streamedDigest,
    rewriteStreamDigest("rested on the cool step")
  );
  // The settle path commits the stash through the same rewrite effect a full
  // commit uses: exact splice, exact recorded span, in-place destination.
  const applied = await applyProviderStoryEffect(
    story,
    { ...record.effect, updatedAt: "2026-01-02T00:00:00.000Z" },
    async () => {}
  );
  assert.equal(applied.changed, true);
  assert.equal(
    story.nodes[0]!.text,
    "A grey cat rested on the cool step by the door."
  );
  assert.deepEqual(story.nodes[0]!.rewrittenSpans, [
    { start, end: start + "rested on the cool step".length }
  ]);
  assert.equal(story.nodes.length, 1);
});

providerTest("generation timeouts: Stop during the completed rewrite tail cannot settle a missing end marker", async (t) => {
  const controller = new AbortController();
  const model = await fakeModel(t, (_body, response) => {
    // The short invalid reply stays in the rewrite filter until finish().
    // Stop arrives while that completed tail waits for its consumer.
    stream(response, ["rested on the cool step"]);
  });
  const { story, nodeId, start, end } = fixtureStory();
  const partials = new PartialRewriteStash();

  await assert.rejects(
    rewriteNode(
      story.id,
      nodeId,
      {
        start,
        end,
        expected: SELECTION,
        instruction: "Make the image colder.",
        attemptId: "missing-marker-attempt"
      },
      refusingStories<"rewriteNode">(story),
      stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "supported" })),
      new PromptCacheRuntime(),
      async () => {
        controller.abort();
        await Promise.resolve();
      },
      controller.signal,
      undefined,
      "missing-marker-rewrite",
      "missing-marker-take",
      undefined,
      partials
    ),
    (error: unknown) => error instanceof GenerationResultError
      && /did not reconnect the replacement/.test(error.message)
  );
  assert.equal(partials.get(story.id, nodeId, "missing-marker-attempt"), null);
  assert.equal(story.nodes[0]!.text, STORY_TEXT);
});

providerTest("a verified rewrite is stashed before its cancellable commit", async () => {
  const controller = new AbortController();
  const { story, nodeId, start, end } = fixtureStory();
  const partials = new PartialRewriteStash();
  const settings: GenerationSettings = {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  };
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => {},
    commitProviderEffect: async () => {
      controller.abort();
      throw new GenerationStoppedError("Story rewriting was cancelled");
    }
  } as unknown as ProviderStoryRuntime<"rewriteNode">;
  let streamed = "";

  await assert.rejects(
    rewriteNode(
      story.id,
      nodeId,
      {
        start,
        end,
        expected: SELECTION,
        instruction: "",
        attemptId: "commit-window-attempt"
      },
      stories,
      stubSettingsStore(settings),
      new PromptCacheRuntime(),
      (delta) => { streamed += delta; },
      controller.signal,
      undefined,
      "commit-window-rewrite",
      "commit-window-take",
      undefined,
      partials
    ),
    GenerationStoppedError
  );
  const record = partials.get(story.id, nodeId, "commit-window-attempt");
  assert.ok(record);
  assert.equal(record.streamedDigest, rewriteStreamDigest(streamed));
});

providerTest("rewrite stash capacity refuses provider work before it can emit prose", async () => {
  const { story, nodeId, start, end } = fixtureStory();
  const partials = new PartialRewriteStash();
  for (let index = 0; index < 64; index += 1) {
    partials.reserve(story.id, nodeId, `waiting-${index}`);
  }
  const settings: GenerationSettings = {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  };
  let deltas = 0;

  await assert.rejects(
    rewriteNode(
      story.id,
      nodeId,
      {
        start,
        end,
        expected: SELECTION,
        instruction: "",
        attemptId: "over-capacity"
      },
      refusingStories<"rewriteNode">(story),
      stubSettingsStore(settings),
      new PromptCacheRuntime(),
      () => { deltas += 1; },
      new AbortController().signal,
      undefined,
      "over-capacity-rewrite",
      "over-capacity-take",
      undefined,
      partials
    ),
    (error: unknown) => error instanceof ServiceError && error.status === 429
  );
  assert.equal(deltas, 0);
});

providerTest("generation timeouts: a rewrite idle timeout stashes the partial for a new take when the writer asked for one", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    stall(response, ["rested on the cool step"]);
  });
  const { story, nodeId, start, end } = fixtureStory();
  const partials = new PartialRewriteStash();

  await assert.rejects(
    rewriteNode(
      story.id,
      nodeId,
      { start, end, expected: SELECTION, instruction: "", destination: "take", attemptId: "timeout-attempt" },
      refusingStories<"rewriteNode">(story),
      stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "supported" })),
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      undefined,
      "partial-rewrite-id",
      "partial-take-id",
      undefined,
      partials
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.timeout, "provider-idle");
      assert.ok(isTimeoutClassFailure(timeoutEnvelope(error)));
      return true;
    }
  );
  assert.equal(story.nodes[0]!.text, STORY_TEXT);

  const record = partials.get(story.id, nodeId, "timeout-attempt");
  assert.ok(record, "a timed-out rewrite with a verified partial must stash it");
  const applied = await applyProviderStoryEffect(
    story,
    { ...record.effect, updatedAt: "2026-01-02T00:00:00.000Z" },
    async () => {}
  );
  assert.equal(applied.changed, true);
  // New-take destination: the original keeps its text; the sibling take
  // carries the splice and the recorded span.
  assert.equal(story.nodes.length, 2);
  assert.equal(applied.value.id, "partial-take-id");
  assert.equal(story.nodes[0]!.text, STORY_TEXT);
  assert.equal(
    applied.value.text,
    "A grey cat rested on the cool step by the door."
  );
  assert.deepEqual(applied.value.rewrittenSpans, [
    { start, end: start + "rested on the cool step".length }
  ]);
});

providerTest("generation timeouts: an idle timeout after a rejected rewrite echo stashes nothing and keeps the rejection", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    // Never copies the required left boundary, then stalls into the idle
    // deadline. The rejection must win and nothing may become committable.
    stall(response, ["#".repeat(700)]);
  });
  const { story, nodeId, start, end } = fixtureStory();
  const partials = new PartialRewriteStash();

  await assert.rejects(
    rewriteNode(
      story.id,
      nodeId,
      { start, end, expected: SELECTION, instruction: "Make it grimmer.", attemptId: "rejected-attempt" },
      refusingStories<"rewriteNode">(story),
      stubSettingsStore(timedSettings(model.baseUrl, { assistantPrefill: "unsupported" })),
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      undefined,
      "masked-rewrite-id",
      "masked-take-id",
      undefined,
      partials
    ),
    (error: unknown) => {
      assert.ok(error instanceof GenerationResultError);
      assert.match(error.message, /did not reconnect the replacement to the exact text before it/);
      assert.equal(isTimeoutClassFailure(timeoutEnvelope(error)), false);
      return true;
    }
  );
  assert.equal(partials.get(story.id, nodeId, "rejected-attempt"), null);
  assert.equal(story.nodes[0]!.text, STORY_TEXT);
});

providerTest("generation timeouts: the operation lease deadline aborts with the typed TimeoutError the client stamps as operation-lease", async () => {
  const shutdown = new AbortController();
  // The lease unrefs its deadline timer on purpose; without other work the
  // test's event loop would drain before the deadline can fire.
  const keepalive = setTimeout(() => {}, 5_000);
  const lease = createHttpOperationLease({
    fetch: async () => new Response(null, { status: 404 }),
    root: "http://127.0.0.1:1",
    serverInstanceId: "instance",
    capability: "bb".repeat(32),
    ticket: "ticket",
    sessionId: "session",
    sequence: "1",
    mutationId: null,
    deadlineEpochMs: Date.now() + 50,
    callerSignal: undefined,
    shutdownSignal: shutdown.signal,
    confirmListenerReplacement: async () => ({ kind: "unchanged" }),
    callerCancellation: "operation-first"
  });
  try {
    await new Promise<void>((resolve) => {
      if (lease.signal.aborted) return resolve();
      lease.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const reason: unknown = lease.signal.reason;
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, "TimeoutError");
  } finally {
    clearTimeout(keepalive);
    shutdown.abort();
    await lease.settle();
  }
});
