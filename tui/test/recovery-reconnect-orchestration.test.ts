import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { ApiHttpError } from "../src/api.js";
import { handleKey, initialState } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import {
  connectionSucceeded,
  createConnectionMonitor,
  type ConnectionMonitor,
  type ConnectionState
} from "../src/connection.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import { WorkerApiError, type WorkerRecoveryWarning } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "../src/model.js";
import { factRows } from "../src/facts-model.js";
import { applyOpeningFocus } from "../src/reading-position.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { createPrunePlan, createUnusedTakesPrunePlan } from "../src/prune-model.js";
import { nextRequestContext } from "../src/request-context.js";
import { initialSettingsOverlay, SETTINGS_ROW_IDS } from "../src/settings-overlay-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

function ctrlP(): KeyEvent {
  return { ...key("p", "\u0010"), ctrl: true } as KeyEvent;
}

async function typeQuery(
  press: (event: KeyEvent) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

describe("backend recovery orchestration", () => {
  test("an automatic reconnect refreshes every generation setting projection", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, {
      down: true, attempt: 1, nextRetryAt: null, error: "offline"
    });
    source.connection = connection.monitor;
    const recoveredPayload = { ...source.payload, title: "fresh automatic reconnect" };
    const recoveredSettings = {
      ...source.settings,
      provider: "anthropic" as const,
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      systemPrompt: "Use the server's fresh voice.",
      contextWindow: 8_192
    };
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const recoveredView = {
      ...source.settingsView,
      document: applyBasicSettingsDraft(source.settingsView.document, recoveredSettings),
      effective: recoveredSettings,
      effectiveProse: recoveredSettings
    };
    let settingsLoads = 0;
    const discoveryEntered = deferred<void>();
    const discoverModels = source.api.discoverModels;
    source.api.discoverModels = async (target, signal) => {
      discoveryEntered.resolve();
      return discoverModels(target, signal);
    };
    source.api.loadStory = async () => recoveredPayload;
    source.api.getSettings = async () => {
      settingsLoads += 1;
      return recoveredView;
    };
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    connection.publish(connectionSucceeded());
    await settled.promise;
    await discoveryEntered.promise;
    await backend.whenIdle();

    expect(settingsLoads).toBe(1);
    expect(source.settings).toBe(recoveredSettings);
    expect(state.settings?.draft.generation).toEqual(recoveredSettings);
    expect(state.model).toBe(recoveredSettings.model);
    expect(state.contextWindow).toBe(recoveredSettings.contextWindow);
    expect(state.systemPrompt).toBe(recoveredSettings.systemPrompt);
    expect(state.assistantPrefill).toBeFalse();
    expect(nextRequestContext(state)).toMatchObject({
      systemPrompt: recoveredSettings.systemPrompt,
      assistantPrefill: false
    });
    stop();
  });

  test("a newer reconnect transition supersedes an in-flight automatic snapshot", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, {
      down: true, attempt: 1, nextRetryAt: null, error: "offline"
    });
    source.connection = connection.monitor;
    const stale = { ...source.payload, title: "stale first reconnect" };
    const fresh = { ...source.payload, title: "fresh second reconnect" };
    const staleSettings = { ...source.settings, model: "stale reconnect model" };
    const freshSettings = { ...source.settings, model: "fresh reconnect model" };
    const first = deferred<StoryPayload>();
    const second = deferred<StoryPayload>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    let loads = 0;
    let settingsLoads = 0;
    source.api.getSettings = async () => {
      settingsLoads += 1;
      return {
        ...source.settingsView,
        effective: settingsLoads === 1 ? staleSettings : freshSettings,
        effectiveProse: settingsLoads === 1 ? staleSettings : freshSettings
      };
    };
    source.api.loadStory = async () => {
      loads += 1;
      if (loads === 1) {
        firstEntered.resolve();
        return first.promise;
      }
      secondEntered.resolve();
      return second.promise;
    };
    const state = initialState(source, false);
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === fresh) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    connection.publish(connectionSucceeded());
    await firstEntered.promise;
    connection.publish({ down: true, attempt: 2, nextRetryAt: null, error: "offline again" });
    connection.publish(connectionSucceeded());
    first.resolve(stale);
    await secondEntered.promise;

    expect(state.payload).not.toBe(stale);
    expect(source.settings).not.toBe(staleSettings);
    second.resolve(fresh);
    await adopted.promise;

    expect(loads).toBe(2);
    expect(settingsLoads).toBe(2);
    expect(state.payload).toBe(fresh);
    expect(source.settings).toBe(freshSettings);
    expect(state.model).toBe(freshSettings.model);
    stop();
  });

  test("a publish-boundary reconnect drains under the same automatic owner", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, {
      down: true, attempt: 1, nextRetryAt: null, error: "offline"
    });
    source.connection = connection.monitor;
    const stalePayload = { ...source.payload, title: "stale publish-boundary snapshot" };
    const freshPayload = { ...source.payload, title: "fresh publish-boundary snapshot" };
    const freshLoad = deferred<StoryPayload>();
    const freshEntered = deferred<void>();
    let storyLoads = 0;
    source.api.loadStory = async () => {
      storyLoads += 1;
      if (storyLoads === 1) return stalePayload;
      freshEntered.resolve();
      return freshLoad.promise;
    };
    const state = initialState(source, false);
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === freshPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    let firstOwnerId: number | null = null;
    let invalidations = 0;
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: reconcileSpyCache(() => {
        invalidations += 1;
        if (invalidations === 1) {
          firstOwnerId = state.backendTask?.id ?? null;
          queueMicrotask(() => {
            connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "boundary outage" });
            connection.publish(connectionSucceeded());
          });
        }
      }),
      repaint
    });

    connection.publish(connectionSucceeded());
    await freshEntered.promise;

    expect(firstOwnerId).not.toBe(null);
    expect(state.backendTask).toMatchObject({
      id: firstOwnerId,
      kind: "connection-reconcile"
    });
    let competingMutationRan = false;
    expect(await backend.run("competing mutation", async () => {
      competingMutationRan = true;
    })).toBeFalse();
    expect(competingMutationRan).toBeFalse();

    freshLoad.resolve(freshPayload);
    await adopted.promise;

    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(freshPayload);
    expect(state.backendTask).toBe(null);
    stop();
  });

  test("a stale error cannot settle a newer intent across its async return boundary", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, {
      down: true, attempt: 1, nextRetryAt: null, error: "offline"
    });
    source.connection = connection.monitor;
    const staleLoad = deferred<StoryPayload>();
    const staleEntered = deferred<void>();
    const freshLoad = deferred<StoryPayload>();
    const freshEntered = deferred<void>();
    const freshPayload = { ...source.payload, title: "fresh after stale error" };
    let storyLoads = 0;
    source.api.loadStory = async () => {
      storyLoads += 1;
      if (storyLoads === 1) {
        staleEntered.resolve();
        return staleLoad.promise;
      }
      freshEntered.resolve();
      return freshLoad.promise;
    };
    const state = initialState(source, false);
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === freshPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    connection.publish(connectionSucceeded());
    await staleEntered.promise;
    const firstOwnerId = state.backendTask?.id ?? null;
    staleLoad.reject(new ApiHttpError(createFailureEnvelope({
      code: "internal",
      message: "obsolete recovery error",
      status: 500
    })));
    // Three chained promise turns place the transition after reconcileOwned's
    // failure result but before its backend owner accepts that result.
    let boundary = Promise.resolve();
    for (let turn = 0; turn < 3; turn += 1) boundary = boundary.then(() => undefined);
    void boundary.then(() => {
      connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "boundary outage" });
      connection.publish(connectionSucceeded());
    });
    await freshEntered.promise;

    expect(firstOwnerId).not.toBe(null);
    expect(state.backendTask).toMatchObject({
      id: firstOwnerId,
      kind: "connection-reconcile"
    });
    expect(state.toast).not.toBe("obsolete recovery error");
    freshLoad.resolve(freshPayload);
    await adopted.promise;

    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(freshPayload);
    expect(state.toast).toBe("reconnected · story reloaded");
    stop();
  });

  test("a reconnect supersedes warning recovery without stale publication or releasing its owner", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const connection = controlledMonitor(source.api, connectionSucceeded());
    source.backendRecovery = feed;
    source.connection = connection.monitor;
    const originalPayload = source.payload;
    const originalStories = source.stories;
    const originalSettings = source.settings;
    const stalePayload = { ...source.payload, title: "stale warning recovery" };
    const freshPayload = { ...source.payload, title: "fresh warning recovery" };
    const staleStories = source.stories.map((story) => story.id === source.payload.id
      ? { ...story, title: stalePayload.title }
      : story);
    const freshStories = source.stories.map((story) => story.id === source.payload.id
      ? { ...story, title: freshPayload.title }
      : story);
    const staleSettings = { ...source.settings, model: "stale warning model" };
    const freshSettings = { ...source.settings, model: "fresh warning model" };
    const staleLoad = deferred<StoryPayload>();
    const freshLoad = deferred<StoryPayload>();
    const staleEntered = deferred<void>();
    const freshEntered = deferred<void>();
    let catalogLoads = 0;
    let settingsLoads = 0;
    let storyLoads = 0;
    source.api.listStories = async () => {
      catalogLoads += 1;
      return catalogLoads === 1 ? staleStories : freshStories;
    };
    source.api.getSettings = async () => {
      settingsLoads += 1;
      return {
        ...source.settingsView,
        effective: settingsLoads === 1 ? staleSettings : freshSettings,
        effectiveProse: settingsLoads === 1 ? staleSettings : freshSettings
      };
    };
    source.api.loadStory = async () => {
      storyLoads += 1;
      if (storyLoads === 1) {
        staleEntered.resolve();
        return staleLoad.promise;
      }
      freshEntered.resolve();
      return freshLoad.promise;
    };
    const state = initialState(source, false);
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === freshPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    feed.publish([], true);
    await staleEntered.promise;
    connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "offline again" });
    connection.publish(connectionSucceeded());
    staleLoad.resolve(stalePayload);
    await freshEntered.promise;

    expect(state.payload).toBe(originalPayload);
    expect(source.stories).toBe(originalStories);
    expect(source.settings).toBe(originalSettings);
    expect(state.backendTask).toMatchObject({
      kind: "connection-reconcile",
      label: "recovering backend state"
    });
    let competingMutationRan = false;
    const admitted = await backend.run("competing mutation", async () => {
      competingMutationRan = true;
    });
    expect(admitted).toBeFalse();
    expect(competingMutationRan).toBeFalse();
    expect(state.backendTask?.label).toBe("recovering backend state");

    freshLoad.resolve(freshPayload);
    await adopted.promise;

    expect(catalogLoads).toBe(2);
    expect(settingsLoads).toBe(2);
    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(freshPayload);
    expect(source.stories).toBe(freshStories);
    expect(source.settings).toBe(freshSettings);
    expect(state.backendTask).toBe(null);
    stop();
  });

  test("disposal rejects an automatic snapshot that settles late", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, {
      down: true, attempt: 1, nextRetryAt: null, error: "offline"
    });
    source.connection = connection.monitor;
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    const late = { ...source.payload, title: "must not land after disposal" };
    source.api.loadStory = async () => {
      entered.resolve();
      return reload.promise;
    };
    const state = initialState(source, false);
    const original = state.payload;
    const settled = deferred<void>();
    let requestStarted = false;
    const repaint = () => {
      if (requestStarted && state.backendTask === null) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    connection.publish(connectionSucceeded());
    await entered.promise;
    requestStarted = true;
    stop();
    reload.resolve(late);
    await settled.promise;

    expect(state.payload).toBe(original);
    expect(state.toast).not.toBe("reconnected · story reloaded");
  });

  test("a clean startup recovery reloads without announcing itself", async () => {
    // Every start publishes an empty warning batch to force this reload, so a
    // toast here fires on every launch and reports bookkeeping the reader never
    // saw go wrong. The reload still has to happen.
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const recoveredPayload = { ...source.payload };
    source.backendRecovery = feed;
    let reloads = 0;
    source.api.loadStory = async () => { reloads += 1; return recoveredPayload; };
    const state = initialState(source, false);
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    feed.publish([], true);
    await settled.promise;

    expect(reloads).toBe(1);
    expect(state.toast).toBe(null);
    stop();
  });

  test("generation recovery retires the provider record before reloading", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    source.backendRecovery = feed;
    const calls: string[] = [];
    source.api.acknowledgeUnknownOutcomes = async (
      storyId,
      originalProviderMutationId
    ) => {
      expect(feed.publish([warning])).toBeFalse();
      calls.push(`retire:${storyId}:${originalProviderMutationId}`);
      return source.payload;
    };
    source.api.loadStory = async (storyId) => {
      calls.push(`load:${storyId}`);
      return source.payload;
    };
    const warning: WorkerRecoveryWarning = {
      mutationId: "m1-generation-recovery",
      method: "continueStory",
      storyId: source.payload.id,
      resolution: "archived",
      error: new WorkerApiError(createFailureEnvelope({
        code: "generation_outcome_unknown",
        message: "Provider outcome is unknown.",
        status: 409
      }))
    };
    const state = initialState(source, false);
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null
        && calls.includes(`load:${source.payload.id}`)) {
        settled.resolve();
      }
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    expect(feed.publish([warning])).toBeTrue();
    await settled.promise;

    expect(calls).toEqual([
      `retire:${source.payload.id}:${warning.mutationId}`,
      `load:${source.payload.id}`
    ]);
    expect(state.toast).toBe(
      "something interrupted the model · you can try again"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feed.publish([warning])).toBeFalse();
    stop();
  });

});


function onlineMonitor(
  api: ReturnType<typeof demoAppSource>["api"],
  retryNow: () => Promise<boolean>
): ConnectionMonitor {
  return {
    api,
    state: connectionSucceeded,
    retryNow,
    subscribe: () => () => undefined,
    dispose: () => undefined
  };
}

function transitioningMonitor(api: ReturnType<typeof demoAppSource>["api"]): ConnectionMonitor {
  let current: ConnectionState = {
    down: true,
    attempt: 1,
    nextRetryAt: null,
    error: "offline"
  };
  let listener: ((state: ConnectionState) => void) | null = null;
  return {
    api,
    state: () => ({ ...current }),
    async retryNow() {
      current = connectionSucceeded();
      listener?.(current);
      return true;
    },
    subscribe(next) {
      listener = next;
      return () => { listener = null; };
    },
    dispose: () => undefined
  };
}

function controlledMonitor(
  api: ReturnType<typeof demoAppSource>["api"],
  initial: ConnectionState
): { monitor: ConnectionMonitor; publish(connection: ConnectionState): void } {
  let current = initial;
  let listener: ((state: ConnectionState) => void) | null = null;
  return {
    monitor: {
      api,
      state: () => ({ ...current }),
      retryNow: async () => !current.down,
      subscribe(next) {
        listener = next;
        return () => { listener = null; };
      },
      dispose: () => undefined
    },
    publish(connection) {
      current = connection;
      listener?.(connection);
    }
  };
}


/** Fire once per adoption commit. reconcileWrapCache reads partIds() exactly
 * once for a same-story snapshot and calls one full invalidate() for a
 * different story, so either signal marks one committed reconciliation. */
function reconcileSpyCache(onReconcile: () => void): ReturnType<typeof createWrapCache<ProseStyle>> {
  const cache = createWrapCache<ProseStyle>();
  return {
    wrap: (partId, width, text, runs, identity) => cache.wrap(partId, width, text, runs, identity),
    lineCount: (partId, width, text, identity) => cache.lineCount(partId, width, text, identity),
    isWarm: (partId, width, text, runs, identity) => cache.isWarm(partId, width, text, runs, identity),
    appendCandidate: (partId, width, appendStart) => cache.appendCandidate(partId, width, appendStart),
    prime: (partId, width, text, runs, lines, identity) => cache.prime(partId, width, text, runs, lines, identity),
    invalidate: (partId) => {
      if (partId === undefined) onReconcile();
      cache.invalidate(partId);
    },
    rebind: (partId, source, textLength) => cache.rebind(partId, source, textLength),
    partIds: () => {
      onReconcile();
      return cache.partIds();
    },
    get epoch() { return cache.epoch; },
    get revision() { return cache.revision; },
    get hits() { return cache.hits; },
    get misses() { return cache.misses; }
  };
}
