import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { autonameStory, continueStory, rewriteNode } from "../server/generation-http.js";
import { summarizeChapter } from "../server/chapter-summary.js";
import { ServiceError } from "../server/errors.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import type { SettingsStore } from "../server/settings.js";
import { createSummaryTake } from "../server/summary-take.js";
import type { StoryStore } from "../server/stories.js";
import type { Story } from "../shared/types.js";
import { streamResponse } from "../server/stream-response.js";
import { PromptCacheRuntime } from "../server/provider-cache-policy.js";

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
        if (phase === "streaming") onDelta("first");
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

test("HTTP stream adapter waits for response drain before reading more model output", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  response.acceptWrites = false;
  let passedBackpressure = false;
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      await onDelta("first");
      passedBackpressure = true;
      return { ok: true };
    },
    (value) => value
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(response.writes, 1);
  assert.equal(passedBackpressure, false);

  response.acceptWrites = true;
  response.emit("drain");
  await running;

  assert.equal(passedBackpressure, true);
  assert.equal(response.writes, 2);
  assert.equal(response.ends, 1);
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  closed = false;
  writableEnded = false;
  headersWritten = 0;
  writes = 0;
  ends = 0;
  acceptWrites = true;
  writeHead(): this { this.headersWritten += 1; return this; }
  write(): boolean { this.writes += 1; return this.acceptWrites; }
  end(): this { this.writableEnded = true; this.ends += 1; return this; }
}

function fixture(): Story {
  return {
    id: "story", title: "Story", createdAt: NOW, updatedAt: NOW,
    nodes: [{
      id: "root", parentId: null, instruction: "Begin", text: "Root prose", model: "test",
      createdAt: NOW, activeChildId: null
    }],
    activeRootId: "root", bookmarks: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}
