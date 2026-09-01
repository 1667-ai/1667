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
  test("an explicit retry while online reloads the current story and library", async () => {
    const source = demoAppSource();
    const recoveredPayload = { ...source.payload, title: "recovered story title" };
    const recoveredStories: StorySummary[] = source.stories.map((story) =>
      story.id === recoveredPayload.id ? { ...story, title: recoveredPayload.title } : story);
    let retries = 0;
    let storyLoads = 0;
    let catalogLoads = 0;
    source.api.loadStory = async () => { storyLoads += 1; return recoveredPayload; };
    source.api.listStories = async () => { catalogLoads += 1; return recoveredStories; };
    source.connection = onlineMonitor(source.api, async () => { retries += 1; return true; });
    const state = initialState(source, false);
    state.library = { stories: source.stories, cursor: 0, query: "", prompt: null };
    state.mode = "LIBRARY";
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);

    await handleOverlayAction({ action: "retry" }, state, source, {
      backend,
      cache,
      repaint: () => undefined,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    });

    expect(retries).toBe(1);
    expect(storyLoads).toBe(1);
    expect(catalogLoads).toBe(1);
    expect(state.payload).toBe(recoveredPayload);
    expect(source.stories).toBe(recoveredStories);
    expect(state.library?.stories).toBe(recoveredStories);
    expect(state.toast).toBe("reconnected · story reloaded");
  });

  test("an explicit retry adopts a surviving fallback without losing a draft", async () => {
    const source = demoAppSource();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const recoveredPayload = { ...source.payload, id: fallback.id, title: fallback.title };
    source.api.listStories = async () => [fallback];
    source.api.loadStory = async (storyId) => {
      expect(storyId).toBe(fallback.id);
      return recoveredPayload;
    };
    source.connection = onlineMonitor(source.api, async () => true);
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("keep this draft");
    state.focusIndex = 0;
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);

    await handleOverlayAction({ action: "retry" }, state, source, {
      backend,
      cache,
      repaint: () => undefined,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    });

    expect(state.payload).toBe(recoveredPayload);
    expect(source.stories).toEqual([fallback]);
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this draft");
    expect(state.focusIndex).toBe(
      applyOpeningFocus(state.payload, state.readingPositions)
    );
  });

  test("an input-safe explicit retry surfaces a 404 and remains retryable", async () => {
    const source = demoAppSource();
    const recoveredPayload = { ...source.payload, title: "recovered after retry" };
    let retries = 0;
    let storyLoads = 0;
    let failReload = true;
    source.connection = onlineMonitor(source.api, async () => { retries += 1; return true; });
    source.api.loadStory = async () => {
      storyLoads += 1;
      if (failReload) {
        throw new ApiHttpError(createFailureEnvelope({
          code: "not_found",
          message: "story reload failed (404)",
          status: 404
        }));
      }
      return recoveredPayload;
    };
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("keep this draft");
    const cache = createWrapCache<ProseStyle>();
    const failed = deferred<void>();
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.toast === "story reload failed (404)") failed.resolve();
      if (state.backendTask === null && state.payload === recoveredPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const context = {
      backend,
      cache,
      repaint,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    };

    backend.observe(handleOverlayAction({ action: "retry" }, state, source, context));
    await failed.promise;

    expect(state.composer.text).toBe("keep this draft");
    expect(state.mode).toBe("COMPOSE");
    expect(state.toast).toBe("story reload failed (404)");
    expect(state.backendTask).toBe(null);

    failReload = false;
    backend.observe(handleOverlayAction({ action: "retry" }, state, source, context));
    await adopted.promise;

    expect(retries).toBe(2);
    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(recoveredPayload);
    expect(state.composer.text).toBe("keep this draft");
  });

  test("an explicit offline retry coalesces its connection transition reload", async () => {
    const source = demoAppSource();
    const monitor = transitioningMonitor(source.api);
    source.connection = monitor;
    let storyLoads = 0;
    let catalogLoads = 0;
    let settingsLoads = 0;
    source.api.loadStory = async () => { storyLoads += 1; return source.payload; };
    source.api.listStories = async () => { catalogLoads += 1; return source.stories; };
    source.api.getSettings = async () => { settingsLoads += 1; return source.settingsView; };
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache,
      repaint: () => undefined
    });

    await handleOverlayAction({ action: "retry" }, state, source, {
      backend,
      cache,
      repaint: () => undefined,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(storyLoads).toBe(1);
    expect(catalogLoads).toBe(1);
    expect(settingsLoads).toBe(1);
    stop();
  });

  test("a real monitor supersession cannot publish stale explicit retry state or expose idle", async () => {
    const source = demoAppSource();
    const raw = source.api;
    const originalPayload = source.payload;
    const originalStories = source.stories;
    const originalSettings = source.settings;
    const stalePayload = { ...source.payload, title: "stale explicit retry" };
    const freshPayload = { ...source.payload, title: "fresh explicit retry" };
    const staleStories = source.stories.map((story) => story.id === source.payload.id
      ? { ...story, title: stalePayload.title }
      : story);
    const freshStories = source.stories.map((story) => story.id === source.payload.id
      ? { ...story, title: freshPayload.title }
      : story);
    const staleSettings = { ...source.settings, model: "stale explicit model" };
    const freshSettings = { ...source.settings, model: "fresh explicit model" };
    const alreadyFiredProbe = deferred<StorySummary[]>();
    const staleLoad = deferred<StoryPayload>();
    const freshLoad = deferred<StoryPayload>();
    const staleEntered = deferred<void>();
    const freshEntered = deferred<void>();
    let catalogLoads = 0;
    let settingsLoads = 0;
    let storyLoads = 0;
    raw.listStories = async () => {
      catalogLoads += 1;
      if (catalogLoads === 1) throw new Error("initial monitor outage");
      if (catalogLoads === 2) return alreadyFiredProbe.promise;
      if (catalogLoads === 4) return staleStories;
      if (catalogLoads === 5) throw new Error("current monitor outage");
      if (catalogLoads >= 6) return freshStories;
      return originalStories;
    };
    raw.getSettings = async () => {
      settingsLoads += 1;
      return {
        ...source.settingsView,
        effective: settingsLoads === 1 ? staleSettings : freshSettings,
        effectiveProse: settingsLoads === 1 ? staleSettings : freshSettings
      };
    };
    raw.loadStory = async () => {
      storyLoads += 1;
      if (storyLoads === 1) {
        staleEntered.resolve();
        return staleLoad.promise;
      }
      freshEntered.resolve();
      return freshLoad.promise;
    };
    const monitor = createConnectionMonitor(raw);
    source.connection = monitor;
    source.api = monitor.api;
    await source.api.listStories().catch(() => undefined);
    expect(monitor.state().down).toBeTrue();
    const obsoleteProbeResult = monitor.retryNow();

    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache,
      repaint: () => undefined
    });
    const retry = handleOverlayAction({ action: "retry" }, state, source, {
      backend,
      cache,
      repaint: () => undefined,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    });

    await staleEntered.promise;
    alreadyFiredProbe.reject(new Error("obsolete probe failed after reconnect"));
    expect(await obsoleteProbeResult).toBeTrue();
    expect(monitor.state().down).toBeFalse();
    expect(await monitor.retryNow()).toBeFalse();
    staleLoad.resolve(stalePayload);
    await freshEntered.promise;

    expect(state.payload).toBe(originalPayload);
    expect(source.stories).toBe(originalStories);
    expect(source.settings).toBe(originalSettings);
    expect(state.backendTask?.kind).toBe("explicit-retry");
    let competingMutationRan = false;
    const admitted = await backend.run("competing mutation", async () => {
      competingMutationRan = true;
    });
    expect(admitted).toBeFalse();
    expect(competingMutationRan).toBeFalse();
    expect(state.backendTask?.kind).toBe("explicit-retry");

    freshLoad.resolve(freshPayload);
    await retry;

    expect(catalogLoads).toBe(6);
    expect(settingsLoads).toBe(2);
    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(freshPayload);
    expect(source.stories).toBe(freshStories);
    expect(source.settings).toBe(freshSettings);
    expect(state.backendTask).toBe(null);
    stop();
    monitor.dispose();
  });

  test("an online explicit retry drains a boundary recovery under the same owner", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, connectionSucceeded());
    source.connection = connection.monitor;
    const stalePayload = { ...source.payload, title: "stale online explicit snapshot" };
    const freshPayload = { ...source.payload, title: "fresh online explicit snapshot" };
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
    const backend = new ActionRuntime(state, () => undefined);
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
      repaint: () => undefined
    });

    let retrySettled = false;
    const retry = stop.retry().then(() => { retrySettled = true; });
    await freshEntered.promise;

    expect(firstOwnerId).not.toBe(null);
    expect(state.backendTask).toMatchObject({ id: firstOwnerId, kind: "explicit-retry" });
    expect(retrySettled).toBeFalse();
    let competingMutationRan = false;
    expect(await backend.run("competing mutation", async () => {
      competingMutationRan = true;
    })).toBeFalse();
    expect(competingMutationRan).toBeFalse();

    freshLoad.resolve(freshPayload);
    await retry;

    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(freshPayload);
    expect(state.backendTask).toBe(null);
    stop();
  });

  test("an online explicit probe leaves a changed-story boundary recovery to automatic ownership", async () => {
    const source = demoAppSource();
    const connection = controlledMonitor(source.api, connectionSucceeded());
    source.connection = connection.monitor;
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const stalePayload = { ...source.payload, id: fallback.id, title: "stale explicit fallback" };
    const freshPayload = { ...stalePayload, title: "fresh automatic fallback" };
    source.api.listStories = async () => [fallback];
    const freshLoad = deferred<StoryPayload>();
    const freshEntered = deferred<void>();
    let storyLoads = 0;
    source.api.loadStory = async (storyId) => {
      expect(storyId).toBe(fallback.id);
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
    let invalidations = 0;
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: reconcileSpyCache(() => {
        invalidations += 1;
        if (invalidations === 1) {
          queueMicrotask(() => {
            connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "boundary outage" });
            connection.publish(connectionSucceeded());
          });
        }
      }),
      repaint
    });

    await stop.retry();
    await freshEntered.promise;

    expect(state.payload).toBe(stalePayload);
    expect(state.backendTask).toMatchObject({ kind: "connection-reconcile", storyId: fallback.id });
    freshLoad.resolve(freshPayload);
    await adopted.promise;

    expect(storyLoads).toBe(2);
    expect(state.payload).toBe(freshPayload);
    expect(state.connection.down).toBeFalse();
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
