import { describe, expect, test } from "bun:test";
import type { StoryPayload } from "../../shared/types.js";
import type { StoryApi } from "../src/api.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { asideConfirmClear, createAsideSurface } from "../src/aside-surface.js";
import { openDirectComposer } from "../src/composer-ownership.js";
import { composeAction } from "../src/story-actions.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { setComposerText } from "../src/composer-model.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { openAside } from "../src/aside-actions.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "../src/model.js";

function context(
  state: ReturnType<typeof initialState>,
  width?: number,
  height?: number
) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: width === undefined || height === undefined
      ? null
      : { width, height } as never,
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

  test("openingPartId is captured before a deferred getAside settles", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(state.payload.path.length).toBeGreaterThan(1);
    const openingPart = state.payload.path[0]!;
    const otherPart = state.payload.path.at(-1)!;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), openingPart.id);

    let resolveAside!: (document: { notes: readonly { question: string; answer: string }[] }) => void;
    const pendingAside = new Promise<{ notes: readonly { question: string; answer: string }[] }>(
      (resolve) => { resolveAside = resolve; }
    );
    const api: StoryApi = {
      ...source.api,
      getAside: async () => pendingAside
    };
    const opening = openAside(state, api, { entryPointsOpen: true });
    await Promise.resolve();

    // Writer moves focus while the Aside document is still loading.
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), otherPart.id);
    resolveAside({ notes: [] });

    expect(await opening).toBeTrue();
    expect(state.aside?.openingPartId).toBe(openingPart.id);
    expect(state.aside?.openingPartId).not.toBe(otherPart.id);
  });

  test("consumes a Direct /aside draft when loading finishes under the palette", async () => {
    for (const draft of ["/aside", "/aside ask about the open story"]) {
      const source = demoAppSource();
      const state = initialState(source, false);
      expect(openDirectComposer(state)).toBeTrue();
      setComposerText(state.composer, draft);

      let resolveAside!: (document: { notes: readonly { question: string; answer: string }[] }) => void;
      const pendingAside = new Promise<{ notes: readonly { question: string; answer: string }[] }>(
        (resolve) => { resolveAside = resolve; }
      );
      const api: StoryApi = {
        ...source.api,
        getAside: async () => pendingAside
      };
      const actionContext = context(state);
      const opening = composeAction(
        { action: "send" },
        state,
        { ...source, api },
        actionContext,
        { asideEntryPointsOpen: true }
      );
      await Promise.resolve();

      // Ctrl-P does not replace the submitted Direct owner. It only paints
      // the palette over the load, so the Aside settlement can retain it.
      await handleOverlayAction({ action: "open-commands" }, state, source, actionContext);
      expect(state.mode).toBe("COMMANDS");

      resolveAside({ notes: [] });
      await opening;

      expect(state.aside).not.toBeNull();
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.returnMode).toBe("ASIDE");
      expect(state.composer.text).toBe("");
      actionContext.backend.dispose();
    }
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
    expect(asideConfirmClear(state.aside!)).toBeTrue();
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

  test("Placement initial Take follows chapter-summary via openAside", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = createStoryViewModel(state.payload);
    const summaryIndex = view.rows.findIndex((row) => row.kind === "chapter-summary");
    expect(summaryIndex).toBeGreaterThan(-1);
    const summary = view.rows[summaryIndex]!;
    expect(summary.kind).toBe("chapter-summary");
    // Summary maps to the closed chapter's last Part (demo chapter 1 → p5).
    const expectedPartId = summary.kind === "chapter-summary"
      ? summary.chapter.parts.at(-1)!.id
      : null;
    expect(expectedPartId).toBe("p5");
    expect(rowPart(view, summaryIndex)).toBeNull();
    state.focusIndex = summaryIndex;

    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({
        notes: [{ question: "from summary?", answer: "summary placement prose" }]
      })
    };
    await openAside(state, api, { entryPointsOpen: true });
    expect(state.aside?.openingPartId).toBe(expectedPartId);

    const openContext = context(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, openContext);
    await handleOverlayAction({ action: "open-selected" }, state, source, openContext);
    await handleOverlayAction({ action: "focus-next" }, state, source, openContext);
    await handleOverlayAction({ action: "apply" }, state, source, openContext);

    expect(state.mode).toBe("PLACE");
    const stop = state.placement!.stops[state.placement!.cursor]!;
    expect(stop.kind).toBe("take");
    if (stop.kind === "take") expect(stop.partId).toBe(expectedPartId);
    // Without the summary mapping, cursor would fall back to the active leaf.
    const leafId = state.payload.path.at(-1)!.id;
    expect(expectedPartId).not.toBe(leafId);
  });

  test("Placement initial Take follows chapter-divider via openAside", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = createStoryViewModel(state.payload);
    const dividerIndex = view.rows.findIndex((row) => row.kind === "chapter-divider");
    expect(dividerIndex).toBeGreaterThan(-1);
    const divider = view.rows[dividerIndex]!;
    expect(divider.kind).toBe("chapter-divider");
    // Divider maps to the opening chapter's first Part (demo chapter 2 → p6).
    const expectedPartId = divider.kind === "chapter-divider"
      ? divider.openingChapter.parts[0]!.id
      : null;
    expect(expectedPartId).toBe("p6");
    expect(rowPart(view, dividerIndex)).toBeNull();
    state.focusIndex = dividerIndex;

    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({
        notes: [{ question: "from divider?", answer: "divider placement prose" }]
      })
    };
    await openAside(state, api, { entryPointsOpen: true });
    expect(state.aside?.openingPartId).toBe(expectedPartId);

    const openContext = context(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, openContext);
    await handleOverlayAction({ action: "open-selected" }, state, source, openContext);
    await handleOverlayAction({ action: "focus-next" }, state, source, openContext);
    await handleOverlayAction({ action: "apply" }, state, source, openContext);

    expect(state.mode).toBe("PLACE");
    const stop = state.placement!.stops[state.placement!.cursor]!;
    expect(stop.kind).toBe("take");
    if (stop.kind === "take") expect(stop.partId).toBe(expectedPartId);
    const leafId = state.payload.path.at(-1)!.id;
    expect(expectedPartId).not.toBe(leafId);
  });
});
