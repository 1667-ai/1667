/**
 * Detached Placement guard settlement ownership and exact-path identity.
 */
import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { FROM_ASIDE_INSTRUCTION } from "../src/aside-placement.js";
import { findSubmittedPlacementNode } from "../src/aside-placement-model.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import type { StoryApi } from "../src/api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { openDirectComposer } from "../src/composer-ownership.js";
import { setComposerText } from "../src/composer-model.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";
import { findCreatedTake } from "../src/created-take.js";
import { countWords } from "../../shared/story-text.js";
import { nodeStubPreviewText } from "../../shared/node-stub.js";
import type { StoryPayload } from "../../shared/types.js";

function overlayContext(
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
    previewTheme: () => undefined,
    updateChecks: INERT_UPDATE_CHECK_LIFECYCLE
  };
}

async function openPlacementOnStoryAction(
  state: ReturnType<typeof initialState>,
  source: ReturnType<typeof demoAppSource>,
  context: ReturnType<typeof overlayContext>
): Promise<void> {
  await handleOverlayAction({ action: "cycle" }, state, source, context);
  await handleOverlayAction({ action: "open-selected" }, state, source, context);
  await handleOverlayAction({ action: "focus-next" }, state, source, context);
  await handleOverlayAction({ action: "apply" }, state, source, context);
  expect(state.mode).toBe("PLACE");
}

describe("Aside Placement detached settlement", () => {
  test("detached guard settlement preserves COMPOSE draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "detached settle compose draft";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let committed: typeof state.payload | null = null;
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        committed = await source.api.createNode(storyId, body);
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(committed).not.toBeNull();

    // Leave Placement and Aside, open Compose with a draft.
    await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    while (state.mode === "ASIDE") {
      await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    }
    expect(openDirectComposer(state)).toBeTrue();
    setComposerText(state.composer, "keep this compose draft");
    const focusBefore = state.focusIndex;

    adoptSameStoryPayload(state, committed!, context.cache);
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this compose draft");
    expect(state.focusIndex).toBe(focusBefore);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("detached guard settlement preserves SETTINGS overlay", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "detached settle settings surface";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let committed: typeof state.payload | null = null;
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        committed = await source.api.createNode(storyId, body);
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(committed).not.toBeNull();

    await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    while (state.mode === "ASIDE") {
      await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    }
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.mode = "SETTINGS";
    const settings = state.settings;
    const focusBefore = state.focusIndex;

    adoptSameStoryPayload(state, committed!, context.cache);
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.focusIndex).toBe(focusBefore);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("uncertain settlement requires exact path text and instruction", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "exact path identity for guard settlement";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    const submission = state.unresolvedPlacement!.submission;

    // Off-path stub collides on parent/preview/words/instruction-presence only.
    const collidingStub = {
      id: "colliding-stub-id",
      parentId: submission.parentId,
      preview: nodeStubPreviewText(submission.text),
      words: countWords(submission.text),
      hasInstruction: true,
      lastTouched: new Date().toISOString(),
      activeChildId: null as string | null,
      human: true as const
    };
    const ambiguous = {
      ...state.payload,
      // Path keeps no exact match; only an approximate stub exists.
      nodes: [...state.payload.nodes, collidingStub]
    } as StoryPayload;
    expect(findCreatedTake(
      ambiguous,
      submission.knownNodeIds,
      submission.parentId,
      submission.instruction,
      submission.text
    )?.id).toBe("colliding-stub-id");
    expect(findSubmittedPlacementNode(ambiguous, submission)).toBe(undefined);

    adoptSameStoryPayload(state, ambiguous, context.cache);
    // Approximate stub must not clear the guard.
    expect(state.unresolvedPlacement).not.toBeNull();
    expect(state.unresolvedPlacement!.submission.text).toBe(answer.trim());

    // Exact active-path identity settles.
    const exactNode = {
      id: "exact-path-place-id",
      parentId: submission.parentId,
      instruction: submission.instruction,
      text: submission.text,
      model: "human",
      createdAt: new Date().toISOString(),
      activeChildId: null as string | null,
      human: true as const
    };
    const exactPayload = {
      ...state.payload,
      path: [...state.payload.path, exactNode],
      nodes: [
        ...state.payload.nodes,
        {
          id: exactNode.id,
          parentId: exactNode.parentId,
          preview: nodeStubPreviewText(exactNode.text),
          words: countWords(exactNode.text),
          hasInstruction: true,
          lastTouched: exactNode.createdAt,
          activeChildId: null,
          human: true as const
        }
      ]
    } as StoryPayload;
    expect(findSubmittedPlacementNode(exactPayload, submission)?.id)
      .toBe("exact-path-place-id");
    adoptSameStoryPayload(state, exactPayload, context.cache);
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });
});
