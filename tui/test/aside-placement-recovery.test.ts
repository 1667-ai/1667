/**
 * Uncertain createNode settlement while Placement is open: preserve submission,
 * block retry, settle on recovery; definite ApiError restores retry.
 */
import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { createAsideSurface } from "../src/aside-surface.js";
import {
  FROM_ASIDE_INSTRUCTION,
  PLACEMENT_UNCERTAIN_STATUS,
  PLACEMENT_UNCERTAIN_TOAST,
  isDefinitePlacementFailure,
  placementInputLocked,
  placementOutcomeUnknown
} from "../src/aside-placement.js";
import { ApiError, ApiRecoveryRequiredError } from "../src/api-error.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import type { StoryApi } from "../src/api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { WorkerApiError } from "../src/worker-error.js";

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

function frameText(
  state: ReturnType<typeof initialState>,
  width = 80,
  height = 24
): string {
  return renderStoryScreen(state, { width, height })
    .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
}

describe("Aside Placement uncertain recovery", () => {
  test("first uncertain submission is preserved; second Enter does not createNode", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "first uncertain place answer";
    const opening = state.payload.path[Math.max(0, state.payload.path.length - 2)]!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      opening.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    let firstBody: { parentId: string | null; text: string } | null = null;
    const api: StoryApi = {
      ...source.api,
      createNode: async (_storyId, body) => {
        createCalls += 1;
        if (firstBody === null) {
          firstBody = { parentId: body.parentId ?? null, text: body.text };
        }
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    const firstStop = state.placement!.stops[state.placement!.cursor]!;
    expect(firstStop.kind).toBe("take");
    if (firstStop.kind !== "take") throw new Error("expected take stop");

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.mode).toBe("PLACE");
    expect(placementOutcomeUnknown(state)).toBeTrue();
    expect(state.placement!.placingTaskId).toBeNull();
    const pending = state.unresolvedPlacement!;
    expect(pending.storyId).toBe(state.payload.id);
    expect(pending.submission.parentId).toBe(firstStop.parentId);
    expect(pending.submission.text).toBe(answer.trim());
    expect(state.toast).toContain("response lost");
    expect(state.toast).toContain(PLACEMENT_UNCERTAIN_TOAST);

    // Status shows uncertain guidance; toast briefly owns the keyline slot.
    expect(frameText(state)).toContain(PLACEMENT_UNCERTAIN_STATUS);
    state.toast = null;
    const uncertainFrame = frameText(state);
    expect(uncertainFrame).toContain(PLACEMENT_UNCERTAIN_STATUS);
    expect(uncertainFrame).toContain("Up/Down where");
    expect(uncertainFrame).toContain("Esc back to Aside");
    expect(uncertainFrame).not.toContain("Enter place");

    // Move to another stop; first submission must stay authoritative.
    await handleOverlayAction({ action: "focus-next" }, state, uncertain, context);
    const movedCursor = state.placement!.cursor;
    expect(movedCursor).not.toBe(
      state.placement!.stops.findIndex(
        (stop) => stop.kind === "take" && stop.partId === firstStop.partId
      )
    );

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.unresolvedPlacement).toBe(pending);
    expect(state.unresolvedPlacement!.submission.parentId).toBe(firstStop.parentId);
    expect(state.unresolvedPlacement!.submission.text).toBe(answer.trim());
    expect(state.toast).toBe(PLACEMENT_UNCERTAIN_TOAST);
    expect(firstBody).toEqual({
      parentId: firstStop.parentId,
      text: answer
    });
  });

  test("uncertain Take create settles Placement when recovery finds the node", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "uncertain take recovery prose";
    const opening = state.payload.path[Math.max(0, state.payload.path.length - 2)]!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      opening.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let committed: typeof state.payload | null = null;
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        createCalls += 1;
        // Commit, then lose the terminal response (uncertain outcome).
        committed = await source.api.createNode(storyId, body);
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    const stop = state.placement!.stops[state.placement!.cursor]!;
    expect(stop.kind).toBe("take");
    if (stop.kind !== "take") throw new Error("expected take stop");
    expect(stop.partId).toBe(opening.id);

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.mode).toBe("PLACE");
    expect(state.unresolvedPlacement).not.toBeNull();
    expect(placementOutcomeUnknown(state)).toBeTrue();
    expect(committed).not.toBeNull();

    // Second Enter must not fire another create before recovery.
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);

    // Authoritative same-story recovery carries the committed Take.
    adoptSameStoryPayload(state, committed!, context.cache);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed).not.toBeNull();
    expect(placed!.node.text).toBe(answer);
    expect(placed!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(placed!.node.parentId).toBe(opening.parentId);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
    expect(state.backendTask).toBeNull();
  });

  test("active recovery settlement persists the landed reading position", async () => {
    const source = demoAppSource();
    // Non-demo so rememberFocus writes the reading-position map.
    source.demo = false;
    source.readingPositions = {};
    const state = initialState(source, false);
    state.demo = false;
    state.readingPositions = {};
    const answer = "recovery settle persist focus";
    const opening = state.payload.path[Math.max(0, state.payload.path.length - 2)]!;
    const storyId = state.payload.id;
    const surface = createAsideSurface(
      storyId,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      opening.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let committed: typeof state.payload | null = null;
    const api: StoryApi = {
      ...source.api,
      createNode: async (id, body) => {
        committed = await source.api.createNode(id, body);
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api, demo: false, readingPositions: state.readingPositions };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("PLACE");
    expect(committed).not.toBeNull();
    expect(state.readingPositions[storyId]).toBe(undefined);

    // Recovery adoption settles active Placement and must persist focus.
    adoptSameStoryPayload(state, committed!, context.cache);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed).not.toBeNull();
    expect(placed!.node.text).toBe(answer);
    expect(placed!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(state.readingPositions[storyId]).toBe(placed!.node.id);
    expect(state.focusIndex).toBe(
      createStoryViewModel(state.payload).rows.findIndex((row) => row.id === placed!.node.id)
    );
  });

  test("uncertain leaf-gap create settles Placement when recovery finds the node", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "uncertain leaf gap recovery";
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
        throw new Error("response lost");
      }
    };
    const uncertain = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, uncertain, context);
    while (state.placement!.stops[state.placement!.cursor]?.kind !== "leaf-gap") {
      await handleOverlayAction({ action: "focus-next" }, state, uncertain, context);
    }

    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("PLACE");
    expect(state.unresolvedPlacement?.submission.parentId).toBe(leaf.id);
    expect(committed).not.toBeNull();

    adoptSameStoryPayload(state, committed!, context.cache);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed).not.toBeNull();
    expect(placed!.node.parentId).toBe(leaf.id);
    expect(placed!.node.text).toBe(answer);
    expect(placed!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("recovery does not settle Placement without a matching submitted node", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "pending place answer";
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
    expect(state.mode).toBe("PLACE");
    expect(state.unresolvedPlacement).not.toBeNull();

    // Authoritative payload gains an unrelated node — not the submission.
    const unrelated = await source.api.createNode(state.payload.id, {
      parentId: state.payload.path.at(-1)!.id,
      text: "unrelated recovery prose",
      instruction: "» continue"
    });
    adoptSameStoryPayload(state, unrelated, context.cache);
    expect(state.mode).toBe("PLACE");
    expect(state.placement).not.toBeNull();
    expect(state.unresolvedPlacement).not.toBeNull();
    expect(state.unresolvedPlacement!.submission.text).toBe(answer.trim());
  });

  test("definite ApiError clears pending and restores normal placement retry", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "retry after definite failure" }],
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
        if (createCalls === 1) throw new ApiError("provider unavailable");
        return source.api.createNode(state.payload.id, {
          parentId: state.payload.path.at(-1)!.parentId,
          text: "retry after definite failure",
          instruction: FROM_ASIDE_INSTRUCTION
        });
      }
    };
    const failing = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, failing, context);
    const cursor = state.placement!.cursor;

    await handleOverlayAction({ action: "apply" }, state, failing, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.mode).toBe("PLACE");
    expect(state.unresolvedPlacement).toBeNull();
    expect(placementOutcomeUnknown(state)).toBeFalse();
    expect(placementInputLocked(state)).toBeFalse();
    expect(state.toast).toBe("provider unavailable");

    state.toast = null;
    const restored = frameText(state);
    expect(restored).toContain("nothing is written until Enter");
    expect(restored).toContain("Enter place");
    expect(restored).not.toContain(PLACEMENT_UNCERTAIN_STATUS);

    await handleOverlayAction({ action: "focus-next" }, state, failing, context);
    expect(state.placement!.cursor).not.toBe(cursor);
    // Return to original stop and retry successfully.
    await handleOverlayAction({ action: "focus-previous" }, state, failing, context);
    await handleOverlayAction({ action: "apply" }, state, failing, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(2);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
  });

  test("pre-send ApiRecoveryRequiredError clears guard, stays in PLACE, and permits Enter retry", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "retry after pre-send recovery fence";
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
    const fenceMessage =
      "1667 is reloading saved state. Try again when the reload is complete.";
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new ApiRecoveryRequiredError(fenceMessage);
        }
        return source.api.createNode(storyId, body);
      }
    };
    const recovering = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, recovering, context);

    await handleOverlayAction({ action: "apply" }, state, recovering, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.mode).toBe("PLACE");
    expect(state.placement).not.toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(placementOutcomeUnknown(state)).toBeFalse();
    expect(placementInputLocked(state)).toBeFalse();
    expect(state.toast).toBe(fenceMessage);

    state.toast = null;
    const restored = frameText(state);
    expect(restored).toContain("nothing is written until Enter");
    expect(restored).toContain("Enter place");
    expect(restored).not.toContain(PLACEMENT_UNCERTAIN_STATUS);

    await handleOverlayAction({ action: "apply" }, state, recovering, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(2);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("WorkerApiError internal + uncertain keeps Placement blocked", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "internal uncertain keeps guard";
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
    const failure = new WorkerApiError(createFailureEnvelope({
      code: "internal",
      message: "worker failed after possible commit",
      status: 500
    }), "uncertain");
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
    expect(state.unresolvedPlacement?.storyId).toBe(state.payload.id);
    expect(placementOutcomeUnknown(state)).toBeTrue();
    await handleOverlayAction({ action: "apply" }, state, uncertain, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
  });

  test("WorkerApiError internal + terminal clears guard and permits retry", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "internal terminal permits retry";
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
    const failure = new WorkerApiError(createFailureEnvelope({
      code: "internal",
      message: "worker failed without commit",
      status: 500
    }), "terminal");
    expect(isDefinitePlacementFailure(failure)).toBeTrue();
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        createCalls += 1;
        if (createCalls === 1) throw failure;
        return source.api.createNode(storyId, body);
      }
    };
    const terminal = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, terminal, context);
    await handleOverlayAction({ action: "apply" }, state, terminal, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.unresolvedPlacement).toBeNull();
    expect(placementOutcomeUnknown(state)).toBeFalse();
    expect(state.mode).toBe("PLACE");
    await handleOverlayAction({ action: "apply" }, state, terminal, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(2);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
  });

  test("legacy WorkerApiError without settlement outcome keeps the guard", async () => {
    const failure = new WorkerApiError(createFailureEnvelope({
      code: "internal",
      message: "synthetic without transport outcome",
      status: 500
    }));
    expect(failure.mutationOutcome).toBeNull();
    expect(isDefinitePlacementFailure(failure)).toBeFalse();
  });

  test("same-story title adoption refreshes Placement returnAside; Esc shows new title", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "title adoption while placing";
    const opening = state.payload.path.at(-1)!;
    const surface = createAsideSurface(
      state.payload.id,
      "Old title",
      [{ question: "Q?", answer }],
      null,
      opening.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    expect(state.mode).toBe("PLACE");
    expect(state.aside).toBeNull();
    expect(state.placement!.returnAside).toBe(surface);
    expect(surface.storyTitle).toBe("Old title");

    // Same-story rename while Placement owns the retained Aside surface.
    adoptSameStoryPayload(
      state,
      { ...state.payload, title: "Renamed while placing" },
      context.cache
    );
    expect(state.payload.title).toBe("Renamed while placing");
    expect(state.mode).toBe("PLACE");
    expect(state.placement).not.toBeNull();
    expect(state.placement!.returnAside.storyTitle).toBe("Renamed while placing");
    expect(surface.storyTitle).toBe("Renamed while placing");

    // Esc restores the same menu/note with the updated title on the header.
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(surface);
    expect(state.aside!.storyTitle).toBe("Renamed while placing");
    expect(surface.useMenu).toMatchObject({ noteIndex: 0, cursor: 1 });
    expect(typeof surface.useMenu?.sessionId).toBe("string");
    expect(frameText(state)).toContain("ASIDE · Renamed while placing · non-canon");
  });
});
