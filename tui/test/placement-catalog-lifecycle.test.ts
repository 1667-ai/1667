/**
 * Authoritative catalog publication clears a Placement guard only when the
 * catalog proves the guarded story is gone. Ordinary navigation does not.
 */
import { describe, expect, test } from "bun:test";
import type { StorySummary } from "../../shared/types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { createAsideSurface } from "../src/aside-surface.js";
import {
  FROM_ASIDE_INSTRUCTION,
  openPlacementFromAside
} from "../src/aside-placement.js";
import { openAsideUseMenu } from "../src/aside-use.js";
import {
  connectionSucceeded,
  type ConnectionMonitor
} from "../src/connection.js";
import { demoAppSource } from "../src/demo.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { publishStories } from "../src/overlay-publication.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { adoptStoryState } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function overlayContext(
  state: ReturnType<typeof initialState>,
  width = 80,
  height = 24
) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: { width, height } as never,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
}

function seedUnresolvedGuard(
  state: ReturnType<typeof initialState>,
  storyId: string,
  text = "guarded placement text"
): void {
  state.unresolvedPlacement = {
    storyId,
    submission: {
      knownNodeIds: new Set(state.payload.nodes.map(({ id }) => id)),
      parentId: state.payload.path.at(-1)?.parentId ?? null,
      instruction: FROM_ASIDE_INSTRUCTION,
      text,
      partNumber: state.payload.path.length + 1
    }
  };
}

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

describe("Placement guard catalog lifecycle", () => {
  test("authoritative catalog that omits the guarded story clears the guard and permits Placement on a survivor", async () => {
    const source = demoAppSource();
    const originId = source.payload.id;
    const survivorSummary = source.stories.find((story) => story.id !== originId)!;
    const survivorPayload = {
      ...structuredClone(source.payload),
      id: survivorSummary.id,
      title: survivorSummary.title
    };
    source.api.listStories = async () => [survivorSummary];
    source.api.loadStory = async (storyId) => {
      expect(storyId).toBe(survivorSummary.id);
      return survivorPayload;
    };
    source.api.getSettings = async () => source.settingsView;
    source.connection = onlineMonitor(source.api, async () => true);

    const state = initialState(source, false);
    seedUnresolvedGuard(state, originId);
    expect(state.unresolvedPlacement?.storyId).toBe(originId);

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
    await backend.whenIdle();

    expect(state.payload.id).toBe(survivorSummary.id);
    expect(source.stories).toEqual([survivorSummary]);
    expect(state.unresolvedPlacement).toBeNull();

    const surface = createAsideSurface(
      survivorSummary.id,
      survivorPayload.title,
      [{ question: "Q?", answer: "place on survivor after catalog omit" }],
      null,
      survivorPayload.path.at(-1)?.id ?? null
    );
    expect(openAsideUseMenu(surface, 0, 0)).toBeTrue();
    state.aside = surface;
    state.mode = "ASIDE";
    expect(openPlacementFromAside(state)).toBeTrue();
    expect(state.mode).toBe("PLACE");
    expect(state.placement).not.toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    stop();
  });

  test("ordinary A→B navigation without catalog publication preserves the guard", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originId = state.payload.id;
    seedUnresolvedGuard(state, originId);
    const context = overlayContext(state);

    const other = source.stories.find((story) => story.id !== originId);
    expect(other).toBeDefined();
    const otherPayload = await source.api.loadStory(other!.id);
    adoptStoryState(state, otherPayload, context.cache);

    expect(state.payload.id).toBe(other!.id);
    expect(state.unresolvedPlacement?.storyId).toBe(originId);
    expect(state.placement).toBeNull();
  });

  test("authoritative catalog that still contains the guarded story preserves the guard", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originId = state.payload.id;
    seedUnresolvedGuard(state, originId);
    state.library = {
      stories: source.stories,
      cursor: 0,
      query: "",
      prompt: null
    };

    const catalog: StorySummary[] = source.stories.map((story) => ({ ...story }));
    expect(catalog.some(({ id }) => id === originId)).toBeTrue();
    publishStories(state, source, catalog);

    expect(state.unresolvedPlacement?.storyId).toBe(originId);
    expect(source.stories).toBe(catalog);
  });

  test("publishStories clears the guard even when Library is closed", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originId = state.payload.id;
    seedUnresolvedGuard(state, originId);
    expect(state.library).toBeNull();

    const survivor = source.stories.find((story) => story.id !== originId)!;
    publishStories(state, source, [survivor]);

    expect(state.unresolvedPlacement).toBeNull();
    expect(source.stories).toEqual([survivor]);
  });
});
