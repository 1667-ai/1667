import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { autonameStory, continueStory, rewriteNode } from "../server/generation-http.js";
import { summarizeChapter } from "../server/chapter-summary.js";
import {
  GenerationCancelledError,
  GenerationResultError,
  ServiceError
} from "../server/errors.js";
import { InternalErrorReporter } from "../server/internal-error-reporter.js";
import { internalErrorLogPath } from "../server/internal-error-log.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import type { SettingsStore } from "../server/settings.js";
import { createSummaryTake } from "../server/summary-take.js";
import type { StoryStore } from "../server/stories.js";
import type { Story } from "../shared/types.js";
import type { FailureEnvelope } from "../shared/failure-envelope.js";
import { streamResponse } from "../server/stream-response.js";
import { PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { MAX_DELTA_BATCH_BYTES } from "../shared/worker-protocol.js";
import { FakeResponse } from "./fake-http-response.js";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const NOW = "2026-01-01T00:00:00.000Z";

test("generation operations observe cancellation during story-load preflight", async (t) => {
  const cases: Array<{
    name: string;
    body: Record<string, unknown>;
    run: (body: Record<string, unknown>, stories: StoryStore, settings: SettingsStore, signal: AbortSignal) => Promise<unknown>;
  }> = [
    {
      name: "summary",
      body: { nodeId: "root" },
      run: (body, stories, settings, signal) =>
        createSummaryTake("story", body, stories, settings, new PromptCacheRuntime(), () => {}, signal)
    },
    {
      name: "continue",
      body: { parentId: null, instruction: "Continue", genId: "cancel-preflight" },
      run: (body, stories, settings, signal) => continueStory(
        "story", body, stories, settings, new PromptCacheRuntime(),
        new GenerationAdmissionRegistry(), () => {}, signal
      )
    },
    {
      name: "rewrite",
      body: { start: 0, end: 4, expected: "Root", instruction: "Change it" },
      run: (body, stories, settings, signal) =>
        rewriteNode(
          "story", "root", body, stories, settings, new PromptCacheRuntime(), () => {}, signal
        )
    }
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    let loadStarted!: () => void;
    let releaseLoad!: () => void;
    const started = new Promise<void>((resolve) => { loadStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let settingsLoads = 0;
    let hydrations = 0;
    const stories = {
      loadForMutation: async () => { loadStarted(); await gate; return fixture(); },
      hydratePath: async () => { hydrations += 1; }
    } as unknown as StoryStore;
    const settings = {
      load: async () => { settingsLoads += 1; throw new Error("settings must not load after disconnect"); }
    } as unknown as SettingsStore;
    const controller = new AbortController();
    const running = scenario.run(scenario.body, stories, settings, controller.signal);

    await started;
    controller.abort();
    releaseLoad();
    await running;

    assert.equal(settingsLoads, 0);
    assert.equal(hydrations, 0);
  });
});

test("generation operations refuse unsupported story mutations before settings, objects, or providers", async (t) => {
  const cases: Array<{
    name: string;
    run: (
      stories: StoryStore,
      settings: SettingsStore,
      signal: AbortSignal,
      providerStarted: () => void
    ) => Promise<unknown>;
  }> = [
    {
      name: "autoname",
      run: (stories, settings, signal, providerStarted) =>
        autonameStory(
          "story", stories, settings, new PromptCacheRuntime(), signal, providerStarted
        )
    },
    {
      name: "summary",
      run: (stories, settings, signal, providerStarted) =>
        createSummaryTake(
          "story", { nodeId: "root" }, stories, settings, new PromptCacheRuntime(),
          () => {}, signal, providerStarted
        )
    },
    {
      name: "chapter summary",
      run: (stories, settings, signal, providerStarted) =>
        summarizeChapter(
          "story", "break", stories, settings, new PromptCacheRuntime(), signal,
          { providerStarted }
        )
    },
    {
      name: "continue",
      run: (stories, settings, signal, providerStarted) => continueStory(
        "story",
        { parentId: null, instruction: "Continue", genId: "successor-refusal" },
        stories,
        settings,
        new PromptCacheRuntime(),
        new GenerationAdmissionRegistry(),
        () => {},
        signal,
        providerStarted
      )
    },
    {
      name: "rewrite",
      run: (stories, settings, signal, providerStarted) => rewriteNode(
        "story",
        "root",
        { start: 0, end: 4, expected: "Root", instruction: "Change it" },
        stories,
        settings,
        new PromptCacheRuntime(),
        () => {},
        signal,
        providerStarted
      )
    }
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const refusal = new ServiceError(
      409,
      "This story requires a successor release before it can be changed.",
      "story_manifest_requires_successor"
    );
    let mutationLoads = 0;
    let readLoads = 0;
    let settingsLoads = 0;
    let hydrations = 0;
    let commits = 0;
    let providerStarts = 0;
    const stories = {
      loadForMutation: async () => { mutationLoads += 1; throw refusal; },
      load: async () => { readLoads += 1; throw new Error("read-only load bypassed mutation preflight"); },
      hydratePath: async () => { hydrations += 1; },
      commitSummary: async () => { commits += 1; throw new Error("commit reached"); }
    } as unknown as StoryStore;
    const settings = {
      load: async () => { settingsLoads += 1; throw new Error("settings loaded"); }
    } as unknown as SettingsStore;

    await assert.rejects(
      scenario.run(stories, settings, new AbortController().signal, () => { providerStarts += 1; }),
      (error: unknown) => error === refusal
    );

    assert.equal(mutationLoads, 1);
    assert.equal(readLoads, 0);
    assert.equal(settingsLoads, 0);
    assert.equal(hydrations, 0);
    assert.equal(commits, 0);
    assert.equal(providerStarts, 0);
  });
});

test("HTTP stream adapter aborts generation before and after SSE opens", async (t) => {
  for (const phase of ["preflight", "streaming"] as const) await t.test(phase, async () => {
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = Readable.from([]) as unknown as IncomingMessage;
    const response = new FakeResponse();
    let observedSignal: AbortSignal | null = null;
    const running = streamResponse(
      request,
      response as unknown as ServerResponse,
      async (onDelta, signal) => {
        observedSignal = signal;
        // A batch only leaves the process once it clears a threshold or the
        // batching window elapses (server/delta-batcher.ts); a byte-threshold
        // batch clears synchronously, with no timer involved, so awaiting it
        // here deterministically opens the SSE session before the "close"
        // below, the same way one small unbatched delta used to.
        if (phase === "streaming") await onDelta("x".repeat(MAX_DELTA_BATCH_BYTES));
        started();
        await gate;
        return { ok: true };
      },
      (value) => value
    );

    await didStart;
    response.closed = true;
    response.emit("close");
    assert.equal((observedSignal as AbortSignal | null)?.aborted, true);
    release();
    await running;

    assert.equal(response.headersWritten, phase === "streaming" ? 1 : 0);
    assert.equal(response.writes, phase === "streaming" ? 1 : 0);
    assert.equal(response.ends, 1);
  });
});

test("a supervised generation disconnect is terminal", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let observedSignal: AbortSignal | null = null;
  let observedReason: unknown;
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (_onDelta, signal) => {
      observedSignal = signal;
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      observedReason = signal.reason;
      throw signal.reason;
    },
    (value) => value,
    operation.signal
  );

  await didStart;
  response.closed = true;
  response.emit("close");
  await running;

  assert.equal(
    observedReason instanceof GenerationResultError,
    true
  );
  assert.equal(observedReason instanceof GenerationCancelledError, false);
  assert.equal(operation.signal.aborted, false);
  assert.equal(response.ends, 1);
});

test("confirmed operation cancellation wins before response close", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  const cancellation = new GenerationCancelledError();
  let observedReason: unknown;
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (_onDelta, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      observedReason = signal.reason;
      throw signal.reason;
    },
    (value) => value,
    operation.signal
  );

  operation.abort(cancellation);
  response.closed = true;
  response.emit("close");
  await running;

  assert.equal(observedReason, cancellation);
  assert.equal(response.ends, 1);
});

test("HTTP stream adapter batches a small delta instead of gating the model on the socket", async () => {
  // Batching decouples model production from the network up to its own
  // thresholds (server/delta-batcher.ts): one small delta below the byte
  // threshold is accepted and returned immediately, unlike the old
  // one-write-per-delta path where every delta wait on the socket.
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  response.acceptWrites = false;
  let ranToCompletion = false;
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      await onDelta("first");
      ranToCompletion = true;
      return { ok: true };
    },
    (value) => value
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ranToCompletion, true);
  // The batch still has to leave the process before the stream can finish:
  // the flush before "done" waits on the same drain event a per-delta write
  // always did, so the stream is not done yet.
  assert.equal(response.writes, 1);
  assert.equal(response.ends, 0);

  response.acceptWrites = true;
  response.emit("drain");
  await running;

  assert.equal(response.writes, 2);
  assert.equal(response.ends, 1);
});

test("HTTP streams persist private failures and return their reference", async (t) => {
  const machineDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-http-stream-log-"))
  );
  const reporter = await InternalErrorReporter.open(machineDir);
  t.after(async () => {
    await reporter.close();
    await rm(machineDir, { recursive: true, force: true });
  });
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();

  await streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      await onDelta("first");
      throw new Error("private streaming detail");
    },
    (value) => value as Record<string, unknown>,
    undefined,
    reporter,
    "continueStory"
  );

  const reference = /err_[0-9a-f]{24}/.exec(response.output)?.[0];
  assert.ok(reference);
  assert.match(response.output, /Internal server error/);
  assert.doesNotMatch(response.output, /private streaming detail/);
  const stored = await readFile(internalErrorLogPath(machineDir), "utf8");
  assert.match(stored, new RegExp(reference));
  assert.match(stored, /private streaming detail/);
});

test("aborted HTTP streams still persist private failures", async (t) => {
  const machineDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-http-aborted-stream-log-"))
  );
  const reporter = await InternalErrorReporter.open(machineDir);
  t.after(async () => {
    await reporter.close();
    await rm(machineDir, { recursive: true, force: true });
  });
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  const terminalFailures: FailureEnvelope[] = [];

  await streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      operation.abort();
      throw new Error("private failure after stream abort");
    },
    (value) => value as Record<string, unknown>,
    operation.signal,
    reporter,
    "continueStory",
    (failure) => { terminalFailures.push(failure); }
  );

  assert.equal(response.ends, 1);
  assert.equal(response.writes, 0);
  const stored = await readFile(internalErrorLogPath(machineDir), "utf8");
  assert.match(stored, /private failure after stream abort/);
  assert.match(stored, /continueStory/);
  assert.equal(terminalFailures[0]?.code, "internal");
  assert.equal(terminalFailures[0]?.kind, "diagnostic");
});

test("routine HTTP stream cancellation does not create an incident", async (t) => {
  const machineDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-http-stream-cancel-log-"))
  );
  const reporter = await InternalErrorReporter.open(machineDir);
  t.after(async () => {
    await reporter.close();
    await rm(machineDir, { recursive: true, force: true });
  });
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();

  await streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      operation.abort();
      throw operation.signal.reason;
    },
    (value) => value as Record<string, unknown>,
    operation.signal,
    reporter,
    "continueStory"
  );

  assert.equal(response.ends, 1);
  assert.equal(
    await readFile(internalErrorLogPath(machineDir), "utf8"),
    ""
  );
});

function fixture(): Story {
  return {
    id: "story", title: "Story", createdAt: NOW, updatedAt: NOW,
    nodes: [{
      id: "root", parentId: null, instruction: "Begin", text: "Root prose", model: "test",
      createdAt: NOW, activeChildId: null
    }],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}
