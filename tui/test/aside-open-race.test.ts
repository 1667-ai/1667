import { describe, expect, test } from "bun:test";
import type { StoryPayload } from "../../shared/types.js";
import type { StoryApi } from "../src/api.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { openDirectComposer } from "../src/composer-ownership.js";
import { composeAction } from "../src/story-actions.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { setComposerText } from "../src/composer-model.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { openAside } from "../src/aside-actions.js";

function context(state: ReturnType<typeof initialState>) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
}

describe("Aside open ownership", () => {
  test("generic same-story reconciliation refreshes an open Aside title", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, "Old title");

    adoptReconciliationSnapshot(
      state,
      { ...state.payload, title: "Recovered title" },
      createWrapCache<ProseStyle>()
    );

    expect(state.payload.title).toBe("Recovered title");
    expect(state.aside.storyTitle).toBe("Recovered title");
  });

  test("uses the current same-story title after a delayed load", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let resolveAside!: (document: { notes: readonly { question: string; answer: string }[] }) => void;
    const pendingAside = new Promise<{ notes: readonly { question: string; answer: string }[] }>(
      (resolve) => { resolveAside = resolve; }
    );
    const api: StoryApi = {
      ...source.api,
      getAside: async () => pendingAside
    };
    const cache = createWrapCache<ProseStyle>();
    const opening = openAside(state, api, { entryPointsOpen: true });
    await Promise.resolve();

    adoptReconciliationSnapshot(
      state,
      { ...state.payload, title: "Current title" },
      cache
    );
    resolveAside({ notes: [] });

    expect(await opening).toBeTrue();
    expect(state.aside?.storyTitle).toBe("Current title");
  });

  test("discards an A response after recovery adopts B and keeps the Direct draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(openDirectComposer(state)).toBeTrue();
    const draft = "/aside ask about A";
    setComposerText(state.composer, draft);

    let requestedStoryId: string | null = null;
    let resolveAside!: (document: { notes: readonly { question: string; answer: string }[] }) => void;
    const pendingAside = new Promise<{ notes: readonly { question: string; answer: string }[] }>(
      (resolve) => { resolveAside = resolve; }
    );
    const askedStoryIds: string[] = [];
    const clearedStoryIds: string[] = [];
    const api: StoryApi = {
      ...source.api,
      getAside: async (storyId) => {
        requestedStoryId = storyId;
        return pendingAside;
      },
      askAside: async (storyId) => {
        askedStoryIds.push(storyId);
        return { notes: [] };
      },
      clearAside: async (storyId) => {
        clearedStoryIds.push(storyId);
        return state.payload;
      }
    };
    const openingContext = context(state);
    const opening = composeAction(
      { action: "send" },
      state,
      { ...source, api },
      openingContext,
      { asideEntryPointsOpen: true }
    );
    await Promise.resolve();
    expect(requestedStoryId).toBe(state.payload.id);

    const storyB: StoryPayload = {
      ...state.payload,
      id: "story-b",
      title: "B story"
    };
    adoptReconciliationSnapshot(state, storyB, openingContext.cache);
    expect(state.payload.id).toBe("story-b");
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe(draft);

    resolveAside({ notes: [{ question: "A only", answer: "A answer" }] });
    await opening;

    expect(state.payload.id).toBe("story-b");
    expect(state.payload.title).toBe("B story");
    expect(state.mode).toBe("COMPOSE");
    expect(state.aside).toBeNull();
    expect(state.composer.text).toBe(draft);
    expect(askedStoryIds).toEqual([]);
    expect(clearedStoryIds).toEqual([]);
    openingContext.backend.dispose();
  });

  test("busy backend admission keeps a real /aside question in Direct", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(openDirectComposer(state)).toBeTrue();
    const draft = "/aside ask about the occupied story";
    setComposerText(state.composer, draft);
    let reads = 0;
    const api: StoryApi = {
      ...source.api,
      getAside: async () => {
        reads += 1;
        return { notes: [] };
      }
    };
    const actionContext = context(state);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const busy = actionContext.backend.run("generating prose", async () => pending);

    await composeAction(
      { action: "send" },
      state,
      { ...source, api },
      actionContext,
      { asideEntryPointsOpen: true }
    );

    expect(reads).toBe(0);
    expect(state.mode).toBe("COMPOSE");
    expect(state.aside).toBeNull();
    expect(state.composer.text).toBe(draft);
    expect(state.toast).toBe("busy · generating prose still running");

    release();
    await busy;
    actionContext.backend.dispose();
  });

  test("does not apply a pending A clear after recovery adopts B", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const storyAId = state.payload.id;
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title, [
      { question: "A note", answer: "Keep this" }
    ]);
    let resolveClear!: (payload: StoryPayload) => void;
    const pendingClear = new Promise<StoryPayload>((resolve) => { resolveClear = resolve; });
    const clearStoryIds: string[] = [];
    const api: StoryApi = {
      ...source.api,
      clearAside: async (storyId) => {
        clearStoryIds.push(storyId);
        return pendingClear;
      }
    };
    const clearContext = context(state);
    setComposerText(state.aside.composer, "/clear");
    await handleOverlayAction({ action: "send" }, state, { ...source, api }, clearContext);
    expect(state.aside.confirmClear).toBeTrue();
    await handleOverlayAction({ action: "send" }, state, { ...source, api }, clearContext);
    await Promise.resolve();
    expect(state.aside.busy).toBeTrue();
    expect(clearStoryIds).toEqual([storyAId]);

    const storyB: StoryPayload = {
      ...state.payload,
      id: "story-b",
      title: "B story"
    };
    adoptReconciliationSnapshot(state, storyB, clearContext.cache);
    expect(state.payload.id).toBe("story-b");
    expect(state.aside).toBeNull();

    const staleA = { ...storyB, id: storyAId, title: "A story" };
    resolveClear(staleA);
    await clearContext.backend.whenIdle();

    expect(state.payload.id).toBe("story-b");
    expect(state.payload.title).toBe("B story");
    expect(clearStoryIds).toEqual([storyAId]);
    clearContext.backend.dispose();
  });
});
