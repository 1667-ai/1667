/**
 * Unresolved Placement identity: uncertainty-coded failures, Esc survival,
 * and recovery after leaving active Placement.
 */
import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { createAsideSurface } from "../src/aside-surface.js";
import {
  FROM_ASIDE_INSTRUCTION,
  PLACEMENT_UNCERTAIN_TOAST,
  isDefinitePlacementFailure
} from "../src/aside-placement.js";
import { ApiHttpError } from "../src/api-error.js";
import { WorkerApiError } from "../src/worker-error.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import type { StoryApi } from "../src/api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import {
  adoptSameStoryPayload,
  adoptStoryState
} from "../src/story-adoption.js";
import { libraryAction } from "../src/library-actions.js";

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

describe("Aside Placement unresolved identity", () => {
  test("WorkerApiError mutation_outcome_unknown retains the unresolved guard", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "worker uncertain place";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        createCalls += 1;
        throw new WorkerApiError(createFailureEnvelope({
          code: "mutation_outcome_unknown",
          message: "outcome unknown after possible commit",
          status: 409
        }));
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(isDefinitePlacementFailure(new WorkerApiError(createFailureEnvelope({
      code: "mutation_outcome_unknown",
      message: "x",
      status: 409
    })))).toBeFalse();
    expect(state.placement!.placingTaskId).toBeNull();
    expect(state.unresolvedPlacement?.storyId).toBe(state.payload.id);
    expect(state.unresolvedPlacement?.submission.text).toBe(answer.trim());

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
  });

  test("ApiHttpError operation_unknown retains the unresolved guard", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "http uncertain place";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        createCalls += 1;
        throw new ApiHttpError(createFailureEnvelope({
          code: "operation_unknown",
          message: "Something interrupted the last change. You can try again.",
          status: 410
        }), true);
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(isDefinitePlacementFailure(new ApiHttpError(createFailureEnvelope({
      code: "operation_unknown",
      message: "x",
      status: 410
    }), true))).toBeFalse();
    expect(state.placement!.placingTaskId).toBeNull();
    expect(state.unresolvedPlacement?.submission.text).toBe(answer.trim());

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
  });

  test("operation_unknown with requestSent=false stays uncertain and keeps the guard", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "operation unknown unsent flag";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    const failure = new ApiHttpError(createFailureEnvelope({
      code: "operation_unknown",
      message: "interrupted after possible commit",
      status: 410
    }), false);
    expect(isDefinitePlacementFailure(failure)).toBeFalse();
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        createCalls += 1;
        throw failure;
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.placement!.placingTaskId).toBeNull();
    expect(state.unresolvedPlacement?.storyId).toBe(state.payload.id);
    expect(state.unresolvedPlacement?.submission.text).toBe(answer.trim());

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
  });

  test("provably unsent ApiHttpError clears the guard and permits retry", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "unsent then retry" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new ApiHttpError(createFailureEnvelope({
            code: "invalid_request",
            message: "request never left",
            status: 400
          }), false);
        }
        return source.api.createNode(state.payload.id, {
          parentId: state.payload.path.at(-1)!.parentId,
          text: "unsent then retry",
          instruction: FROM_ASIDE_INSTRUCTION
        });
      }
    };
    const failing = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, failing, context);
    await handleOverlayAction({ action: "apply" }, state, failing, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.placement!.placingTaskId).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    await handleOverlayAction({ action: "apply" }, state, failing, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(2);
    expect(state.mode).toBe("NAV");
  });

  test("uncertain submission survives Esc; reopen cannot createNode again", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "esc retain place answer";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    let firstParent: string | null | undefined;
    const api: StoryApi = {
      ...source.api,
      createNode: async (_storyId, body) => {
        createCalls += 1;
        if (firstParent === undefined) firstParent = body.parentId ?? null;
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    const stop = state.placement!.stops[state.placement!.cursor]!;
    const expectedParent = stop.kind === "take" ? stop.parentId : stop.leafId;

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    const pending = state.unresolvedPlacement!;
    expect(pending.submission.text).toBe(answer.trim());

    // Esc restores Aside + use menu; guard identity is not copied.
    await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.placement).toBeNull();
    expect(state.aside).toBe(surface);
    expect(surface.useMenu).toMatchObject({ noteIndex: 0, cursor: 1 });
    expect(typeof surface.useMenu?.sessionId).toBe("string");
    expect(state.unresolvedPlacement).toBe(pending);

    // Closing the use menu and reopening must not drop the guard.
    await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    expect(surface.useMenu).toBeNull();
    expect(state.unresolvedPlacement).not.toBeNull();
    await handleOverlayAction({ action: "open-selected" }, state, uncertain, context);
    expect(surface.useMenu?.cursor).toBe(0);
    await handleOverlayAction({ action: "focus-next" }, state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    expect(state.mode).toBe("PLACE");
    expect(state.unresolvedPlacement).toBe(pending);
    expect(state.toast).toBe(PLACEMENT_UNCERTAIN_TOAST);

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(firstParent).toBe(expectedParent);
    expect(state.toast).toBe(PLACEMENT_UNCERTAIN_TOAST);
  });

  test("same-story adoption after Esc settles the first committed node", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "esc then recovery place";
    const leaf = state.payload.path.at(-1)!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      leaf.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let committed: typeof state.payload | null = null;
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        committed = await source.api.createNode(storyId, body);
        throw new WorkerApiError(createFailureEnvelope({
          code: "mutation_outcome_unknown",
          message: "response lost after commit",
          status: 409
        }));
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(committed).not.toBeNull();

    await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.unresolvedPlacement).not.toBeNull();

    // Close use menu; guard must still settle on adoption.
    await handleOverlayAction({ action: "cancel" }, state, uncertain, context);
    expect(surface.useMenu).toBeNull();

    adoptSameStoryPayload(state, committed!, context.cache);
    // Detached guard settlement keeps ASIDE ownership; only the guard clears.
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.placement).toBeNull();
    expect(state.aside).toBe(surface);
    expect(state.mode).toBe("ASIDE");
    expect(state.toast).toMatch(/^placed as Part \d+$/);
    expect(state.freshLandedAt.size).toBeGreaterThan(0);
  });

  test("normal Esc ladder is unchanged when no unresolved submission exists", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "clean cancel ladder" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.placement!.placingTaskId).toBeNull();

    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.placement).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.aside).toBe(surface);
    expect(surface.useMenu).toMatchObject({ noteIndex: 0, cursor: 1 });
    expect(typeof surface.useMenu?.sessionId).toBe("string");

    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(surface.useMenu).toBeNull();
    expect(surface.focus).toBe("notes");
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(surface.focus).toBe("composer");
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(state.mode).toBe("NAV");
    expect(state.aside).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
  });

  test("adoptStoryState away preserves the guard; return settles an exact node", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originStoryId = state.payload.id;
    const answer = "navigate away then settle";
    const surface = createAsideSurface(
      originStoryId,
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
        throw new WorkerApiError(createFailureEnvelope({
          code: "mutation_outcome_unknown",
          message: "response lost after commit",
          status: 409
        }));
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(committed).not.toBeNull();
    expect(state.unresolvedPlacement?.storyId).toBe(originStoryId);

    // Navigate to another story before recovery proves the outcome.
    const other = (await source.api.listStories()).find((story) => story.id !== originStoryId);
    expect(other).toBeDefined();
    const otherPayload = await source.api.loadStory(other!.id);
    adoptStoryState(state, otherPayload, context.cache);
    expect(state.payload.id).toBe(other!.id);
    expect(state.placement).toBeNull();
    expect(state.unresolvedPlacement?.storyId).toBe(originStoryId);
    expect(state.unresolvedPlacement?.submission.text).toBe(answer.trim());

    // Placement on the other story is refused while the origin guard stands.
    const otherSurface = createAsideSurface(
      other!.id,
      otherPayload.title,
      [{ question: "Q?", answer: "must not place while other guard" }],
      null,
      otherPayload.path.at(-1)?.id ?? null
    );
    state.aside = otherSurface;
    state.mode = "ASIDE";
    await handleOverlayAction({ action: "cycle" }, state, uncertain, context);
    await handleOverlayAction({ action: "open-selected" }, state, uncertain, context);
    await handleOverlayAction({ action: "focus-next" }, state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.placement).toBeNull();
    expect(state.toast).toBe(PLACEMENT_UNCERTAIN_TOAST);
    expect(state.unresolvedPlacement?.storyId).toBe(originStoryId);

    // Return to the origin story with the committed node: settle exactly.
    adoptStoryState(state, committed!, context.cache);
    expect(state.payload.id).toBe(originStoryId);
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.placement).toBeNull();
    expect(state.mode).toBe("NAV");
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed).not.toBeNull();
    expect(placed!.node.text).toBe(answer);
    expect(placed!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("adoptStoryState return without the node does not false-settle", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originStoryId = state.payload.id;
    const answer = "navigate without match";
    // Snapshot the origin payload before navigation; create never committed.
    const originSnapshot = state.payload;
    expect(originSnapshot.path.every((node) => node.text !== answer)).toBeTrue();
    const surface = createAsideSurface(
      originStoryId,
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
    const pendingText = state.unresolvedPlacement!.submission.text;

    const other = (await source.api.listStories()).find((story) => story.id !== originStoryId);
    expect(other).toBeDefined();
    adoptStoryState(state, await source.api.loadStory(other!.id), context.cache);
    expect(state.unresolvedPlacement?.storyId).toBe(originStoryId);

    // Return to origin without the submitted node: no false settle.
    adoptStoryState(state, originSnapshot, context.cache);
    expect(state.payload.id).toBe(originStoryId);
    expect(state.unresolvedPlacement).not.toBeNull();
    expect(state.unresolvedPlacement!.storyId).toBe(originStoryId);
    expect(state.unresolvedPlacement!.submission.text).toBe(pendingText);
    const mode = state.mode as string;
    expect(mode === "NAV" || mode === "COMPOSE").toBeTrue();
    expect(state.toast === null || !/^placed as Part /.test(state.toast)).toBeTrue();
  });

  test("deleting the guarded story clears the unresolved Placement guard", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originStoryId = state.payload.id;
    const originSummary = source.stories.find((story) => story.id === originStoryId)!;
    const answer = "delete guarded story place";
    const surface = createAsideSurface(
      originStoryId,
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
    expect(state.unresolvedPlacement?.storyId).toBe(originStoryId);

    // Ordinary navigation preserves the guard.
    const survivor = {
      ...originSummary,
      id: "survivor-story",
      title: "survivor story"
    };
    const survivorPayload = {
      ...state.payload,
      id: survivor.id,
      title: survivor.title,
      path: state.payload.path.map((node) => ({ ...node })),
      nodes: state.payload.nodes.map((node) => ({ ...node }))
    };
    adoptStoryState(state, survivorPayload, context.cache);
    expect(state.unresolvedPlacement?.storyId).toBe(originStoryId);
    expect(state.payload.id).toBe(survivor.id);

    // Successful library delete of the guarded story proves it is gone.
    let deleted = false;
    source.stories = [originSummary, survivor];
    source.api.deleteStory = async (storyId) => {
      expect(storyId).toBe(originStoryId);
      deleted = true;
      return { ok: true };
    };
    source.api.listStories = async () => deleted ? [survivor] : [originSummary, survivor];
    source.api.loadStory = async (storyId) => {
      if (storyId === survivor.id) return survivorPayload;
      throw new Error(`unexpected loadStory ${storyId}`);
    };
    state.library = {
      stories: source.stories,
      cursor: 0,
      query: "",
      prompt: {
        kind: "delete",
        value: originSummary.title,
        targetId: originStoryId
      }
    };
    state.mode = "LIBRARY";
    await libraryAction({ action: "open-selected" }, state, source, context);
    await context.backend.whenIdle();
    expect(deleted).toBeTrue();
    expect(state.unresolvedPlacement).toBeNull();

    // Placement on the survivor is no longer blocked by a dead-story guard.
    const survivorSurface = createAsideSurface(
      survivor.id,
      survivor.title,
      [{ question: "Q?", answer: "place on survivor after delete" }],
      null,
      survivorPayload.path.at(-1)?.id ?? null
    );
    state.aside = survivorSurface;
    state.mode = "ASIDE";
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    expect(state.placement).not.toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
  });
});
