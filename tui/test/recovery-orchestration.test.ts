import { describe, expect, test } from "bun:test";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { ApiHttpError } from "../src/api.js";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
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
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { createPrunePlan, createUnusedTakesPrunePlan } from "../src/prune-model.js";
import { nextRequestContext } from "../src/request-context.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect(state.focusIndex).toBe(0);
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
      invalidateCache: () => cache.invalidate(),
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
        effective: settingsLoads === 1 ? staleSettings : freshSettings
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
      invalidateCache: () => cache.invalidate(),
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
      invalidateCache: () => {
        invalidations += 1;
        if (invalidations === 1) {
          firstOwnerId = state.backendTask?.id ?? null;
          queueMicrotask(() => {
            connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "boundary outage" });
            connection.publish(connectionSucceeded());
          });
        }
      },
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
      invalidateCache: () => {
        invalidations += 1;
        if (invalidations === 1) {
          queueMicrotask(() => {
            connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "boundary outage" });
            connection.publish(connectionSucceeded());
          });
        }
      },
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
      effective: recoveredSettings
    };
    let settingsLoads = 0;
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
      invalidateCache: () => undefined,
      repaint
    });

    connection.publish(connectionSucceeded());
    await settled.promise;

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
        effective: settingsLoads === 1 ? staleSettings : freshSettings
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
      invalidateCache: () => undefined,
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
      invalidateCache: () => {
        invalidations += 1;
        if (invalidations === 1) {
          firstOwnerId = state.backendTask?.id ?? null;
          queueMicrotask(() => {
            connection.publish({ down: true, attempt: 1, nextRetryAt: null, error: "boundary outage" });
            connection.publish(connectionSucceeded());
          });
        }
      },
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
      invalidateCache: () => undefined,
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
        effective: settingsLoads === 1 ? staleSettings : freshSettings
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
      invalidateCache: () => undefined,
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
      invalidateCache: () => undefined,
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
      invalidateCache: () => undefined,
      repaint
    });

    feed.publish([], true);
    await settled.promise;

    expect(reloads).toBe(1);
    expect(state.toast).toBe(null);
    stop();
  });

  test("same-story warnings remain visible and acknowledge after local input", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    source.backendRecovery = feed;
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    let reloads = 0;
    source.api.loadStory = async () => {
      reloads += 1;
      entered.resolve();
      return reload.promise;
    };
    const warning: WorkerRecoveryWarning = {
      mutationId: "m1-local-input",
      method: "renameStory",
      storyId: source.payload.id,
      resolution: "archived",
      error: new WorkerApiError(createFailureEnvelope({
        code: "mutation_outcome_unknown",
        message: "Reload state.",
        status: 409
      }))
    };
    const state = initialState(source, false);
    const cache = createWrapCache();
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.toast?.includes("renameStory archived")) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      invalidateCache: () => cache.invalidate(),
      repaint
    });

    expect(feed.publish([warning])).toBeTrue();
    await entered.promise;
    beginInteraction(state);
    reload.resolve(source.payload);
    await settled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.toast).toContain("renameStory archived");
    expect(reloads).toBe(1);
    expect(feed.publish([warning])).toBeFalse();
    stop();
  });

  test("same-story recovery closes invalid newer targets but preserves a draft and focus", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    const deletedLeaf = createDemoController().deleteNode("p13", 1);
    const recoveredPayload = {
      ...deletedLeaf,
      title: "authoritative title",
      chapterBreaks: deletedLeaf.chapterBreaks.filter(({ id }) => id !== "chapter-break-1"),
      facts: deletedLeaf.facts.filter(({ id }) => id !== "fact-1")
    };
    source.backendRecovery = feed;
    source.api.loadStory = async () => { entered.resolve(); return reload.promise; };
    const state = initialState(source, false);
    const focusId = "p12";
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), focusId);
    state.mode = "COMPOSE";
    state.composer = createComposer("keep this draft");
    state.viewScroll = 7;
    state.lastViewportStart = 7;
    const cache = createWrapCache();
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      invalidateCache: () => cache.invalidate(),
      repaint
    });

    feed.publish([], true);
    await entered.promise;
    state.undo = [{ kind: "create-break", breakId: "chapter-break-1" }];
    state.prune = {
      kind: "subtree", nodeId: "p13", part: 13, take: 1,
      takeCount: 1, parts: 1, lines: 1, tags: []
    };
    state.tag = {
      nodeId: "p13", name: "newer prompt", statusIndex: 0,
      choosingStatus: false, existing: false, returnMode: "NAV"
    };
    state.chapterDeleteArmedId = "chapter-break-1";
    state.chapters = {
      cursor: 1,
      rename: { breakId: "chapter-break-1", value: "newer title" },
      deleteArmedId: "chapter-break-1"
    };
    state.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false,
      expandedId: null, deleteArmedId: "fact-1"
    };

    reload.resolve(recoveredPayload);
    await settled.promise;

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this draft");
    expect(rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id).toBe(focusId);
    expect(state.viewScroll).toBe(7);
    expect(state.lastViewportStart).toBe(7);
    expect(state.undo).toEqual([]);
    expect(state.prune).toBe(null);
    expect(state.tag).toBe(null);
    expect(state.chapterDeleteArmedId).toBe(null);
    expect(state.chapters?.rename).toBe(null);
    expect(state.chapters?.deleteArmedId).toBe(null);
    expect(state.facts?.deleteArmedId).toBe(null);
    stop();
  });

  test("same-story recovery preserves target-valid prompts opened while loading", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    const prunedLeaf = createDemoController().deleteNode("p13", 1);
    const recoveredPayload = {
      ...prunedLeaf,
      title: "authoritative title",
      tags: [...prunedLeaf.tags, {
        ...source.payload.tags[0]!,
        nodeId: "p12-t4",
        name: "remote tag"
      }]
    };
    source.backendRecovery = feed;
    source.api.loadStory = async () => { entered.resolve(); return reload.promise; };
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
      invalidateCache: () => undefined,
      repaint
    });

    feed.publish([], true);
    await entered.promise;
    const prune = createPrunePlan(state.payload, "p12")!;
    const tag = {
      nodeId: "p12-t4", name: "typed while loading", statusIndex: 2,
      choosingStatus: true, existing: false, returnMode: "NAV" as const
    };
    const rename = { breakId: "chapter-break-1", value: "typed chapter title" };
    state.undo = [{ kind: "create-break", breakId: "chapter-break-1" }];
    state.prune = prune;
    state.tag = tag;
    state.mode = "TAG";
    state.chapters = { cursor: 1, rename, deleteArmedId: "chapter-break-2" };
    state.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false,
      expandedId: null, deleteArmedId: "fact-1"
    };

    reload.resolve(recoveredPayload);
    await settled.promise;

    expect(state.undo).toEqual([]);
    expect(state.prune).toBe(prune);
    expect(state.prune).toMatchObject({ kind: "subtree", nodeId: "p12", parts: 1 });
    expect(state.tag).toBe(tag);
    expect(state.tag).toMatchObject({
      name: "typed while loading", choosingStatus: true, existing: true
    });
    expect(state.mode).toBe("TAG");
    expect(state.chapters?.rename).toBe(rename);
    expect(state.chapters?.deleteArmedId).toBe("chapter-break-2");
    expect(state.facts?.deleteArmedId).toBe("fact-1");
    stop();
  });

  test("same-story recovery reconciles a semantic panel and keeps its valid confirmation", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const selectedId = source.payload.facts[1]!.id;
    const recoveredPayload = { ...source.payload, facts: [...source.payload.facts].reverse() };
    source.backendRecovery = feed;
    source.api.loadStory = async () => recoveredPayload;
    const state = initialState(source, false);
    const facts = {
      cursor: 1, query: "", chip: 0, selectedTag: null, filtering: false,
      expandedId: selectedId, deleteArmedId: selectedId
    };
    state.mode = "FACTS";
    state.facts = facts;
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      invalidateCache: () => undefined,
      repaint
    });

    feed.publish([], true);
    await settled.promise;

    expect(state.mode).toBe("FACTS");
    expect(state.facts).toBe(facts);
    expect(factRows(state.payload.facts, null, "")[state.facts!.cursor]?.id).toBe(selectedId);
    expect(state.facts!.expandedId).toBe(selectedId);
    expect(state.facts!.deleteArmedId).toBe(selectedId);
    stop();
  });

  test("reconciliation refreshes whole-story prune safety metadata and closes an empty preview", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const preview = createUnusedTakesPrunePlan(state.payload)!;
    const reducedPayload = createDemoController().deleteNode("p12-t1", 1);
    state.prune = preview;

    adoptReconciliationSnapshot(state, reducedPayload);

    expect(state.prune).toBe(preview);
    expect(state.prune).toMatchObject({ kind: "unused-takes", takes: 4, parts: 4 });

    const emptyState = initialState(demoAppSource(), false);
    emptyState.prune = createUnusedTakesPrunePlan(emptyState.payload);
    const activeIds = new Set(emptyState.payload.path.map(({ id }) => id));
    const activeLineOnly = {
      ...emptyState.payload,
      nodes: emptyState.payload.nodes.filter(({ id }) => activeIds.has(id)),
      tags: emptyState.payload.tags.filter(({ nodeId }) => activeIds.has(nodeId))
    };
    adoptReconciliationSnapshot(emptyState, activeLineOnly);
    expect(emptyState.prune).toBe(null);
  });

  test("direct chapter deletion remains armed only on the surviving focused divider", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) =>
      row.kind === "chapter-divider" && row.break.id === "chapter-break-1");
    state.chapterDeleteArmedId = "chapter-break-1";

    adoptReconciliationSnapshot(state, { ...state.payload, title: "refreshed" });
    expect(state.chapterDeleteArmedId).toBe("chapter-break-1");

    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    adoptReconciliationSnapshot(state, { ...state.payload, title: "refreshed again" });
    expect(state.chapterDeleteArmedId).toBe(null);
  });

  test("reconciliation repairs removed map and action targets without leaving a dead mode", () => {
    const recoveredPayload = createDemoController().deleteNode("p13", 1);

    const tagState = initialState(demoAppSource(), false);
    tagState.mode = "TAG";
    tagState.map = {
      view: "path", pathCursorId: "p13", pathShowAllTakes: true, treeCursorId: "p13", rowIds: [],
      showSketches: false, openedColdFolds: new Set(), massSort: "size"
    };
    tagState.tag = {
      nodeId: "p13", name: "stale", statusIndex: 0,
      choosingStatus: false, existing: false, returnMode: "MAP"
    };
    adoptReconciliationSnapshot(tagState, recoveredPayload);
    expect(tagState.tag).toBe(null);
    expect(tagState.mode).toBe("MAP");
    expect(tagState.map?.pathCursorId).toBe(recoveredPayload.path.at(-1)?.id);

    const actionsState = initialState(demoAppSource(), false);
    actionsState.mode = "ACTIONS";
    actionsState.actions = {
      cursor: 0,
      partId: "p13",
      selectionText: null
    };
    adoptReconciliationSnapshot(actionsState, recoveredPayload);
    expect(actionsState.actions).toBe(null);
    expect(actionsState.mode).toBe("NAV");
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
