/**
 * Placement mode: put a complete Side Note answer into the active story line.
 * Stage 2: Take stops for each Part, plus one gap after the active leaf.
 */
import type { ActionContext } from "./action-context.js";
import {
  ApiError,
  ApiHttpError,
  apiErrorCode,
  isExplicitMutationUnsent
} from "./api-error.js";
import type { AppSource } from "./app.js";
import type { AsideSurfaceState } from "./aside-surface.js";
import {
  buildPlacementStops,
  firstWords,
  initialPlacementCursor,
  type PlacementPendingSubmission,
  type PlacementStop
} from "./aside-placement-model.js";
import { completePlacementLanding } from "./aside-placement-settle.js";
import { findCreatedTake } from "./created-take.js";
import { generationBusy } from "./generation-action.js";
import {
  createStoryViewModel,
  rowIndexForNode
} from "./model.js";
import { rememberFocus } from "./reading-position-persist.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import type { RuntimeState } from "./state.js";
import { followStoryViewport } from "./viewport-intent.js";
import { WorkerApiError } from "./worker-error.js";

export {
  buildPlacementStops,
  firstWords,
  initialPlacementCursor,
  rebasePlacementStops,
  type PlacementPendingSubmission,
  type PlacementStop,
  type UnresolvedPlacementSubmission
} from "./aside-placement-model.js";

export { trySettlePlacementFromPayload } from "./aside-placement-settle.js";

export const FROM_ASIDE_INSTRUCTION = "» from aside";

/**
 * Failure codes that explicitly mean the write may have committed.
 * Do not invent codes; only those declared on the failure envelope.
 */
const UNCERTAIN_PLACEMENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "mutation_outcome_unknown",
  "operation_unknown"
]);

export interface PlacementState {
  /** Complete Side Note answer to place. */
  answer: string;
  stops: PlacementStop[];
  cursor: number;
  /**
   * Exact Aside surface restored on cancel, including focus, note cursor, and
   * open use menu. openPlacementFromAside does not mutate this retained surface.
   */
  returnAside: AsideSurfaceState;
  /**
   * Backend task id for this Placement's in-flight createNode.
   * Null when no createNode from this Placement is running.
   * Unresolved submission identity lives only on RuntimeState.unresolvedPlacement.
   */
  placingTaskId: number | null;
  /**
   * Use-menu session copied at open. Enter-place hits bind to it so a queued
   * click from Placement A cannot createNode after cancel + open Placement B
   * at the same stop. Survives repaint; new menu open → new Placement id.
   */
  interactionId: string;
}

export function placementBlockedReason(
  state: Pick<RuntimeState, "stream" | "abort" | "backendTask" | "aside">
): string | null {
  if (generationBusy(state)) return "stream running · esc stops it first";
  if (state.backendTask !== null) {
    return `busy · ${state.backendTask.label} still running`;
  }
  if (state.aside?.busy === true) {
    return state.aside.inflightQuestion !== null
      ? "Aside is answering · wait or stop first"
      : "Aside is clearing · wait first";
  }
  return null;
}

/**
 * True only while this Placement owns its createNode task.
 * Unrelated backend work (reconnect/recovery) must not lock Placement.
 */
export function placementInputLocked(
  state: Pick<RuntimeState, "backendTask" | "mode" | "placement">
): boolean {
  const placement = state.placement;
  if (state.mode !== "PLACE" || placement === null) return false;
  const taskId = placement.placingTaskId;
  if (taskId === null) return false;
  return state.backendTask?.id === taskId;
}

/**
 * True after an uncertain createNode error while Placement is open: the
 * singular story-bound guard remains and placingTaskId is null, so Enter is
 * blocked until recovery settles or a definite failure clears the guard.
 */
export function placementOutcomeUnknown(
  state: Pick<RuntimeState, "payload" | "placement" | "unresolvedPlacement">
): boolean {
  const placement = state.placement;
  if (placement === null || placement.placingTaskId !== null) return false;
  return state.unresolvedPlacement?.storyId === state.payload.id;
}

/**
 * True when any unresolved Placement create blocks a new mutation.
 * The singular story-bound guard blocks placement for every story until
 * recovery settles it or a definite failure proves absence.
 * In-flight createNode is owned by placementInputLocked instead.
 */
export function storyPlacementMutationBlocked(
  state: Pick<RuntimeState, "placement" | "unresolvedPlacement">
): boolean {
  if (state.placement !== null && state.placement.placingTaskId !== null) {
    return false;
  }
  return state.unresolvedPlacement !== null;
}

/**
 * Authoritative application failure or provably unsent failure.
 * Worker transport settlement owns mutation truth when present. Explicit
 * uncertain HTTP codes (mutation_outcome_unknown, operation_unknown) win over
 * requestSent=false — those codes mean the write may still have committed.
 * Explicit-unsent is orthogonal to ApiError vs transport Error class.
 */
export function isDefinitePlacementFailure(error: unknown): boolean {
  // Marker proves the mutation never left the client (app or transport).
  if (isExplicitMutationUnsent(error)) return true;
  if (!(error instanceof ApiError)) return false;
  // Transport-owned settlement outcome is authoritative for worker mutations.
  if (error instanceof WorkerApiError) {
    if (error.mutationOutcome === "uncertain") return false;
    if (error.mutationOutcome === "terminal") return true;
    // Legacy/synthetic WorkerApiError without settlement: keep the guard.
    // Do not guess definite absence from failure codes alone.
    return false;
  }
  const code = apiErrorCode(error);
  // Explicit uncertain outcome codes always keep the submission identity.
  if (code !== null && UNCERTAIN_PLACEMENT_FAILURE_CODES.has(code)) return false;
  // Other ApiHttpError with request never sent: provably did not commit.
  // ApiRecoveryRequiredError and other authoritative ApiErrors stay definite.
  if (error instanceof ApiHttpError && !error.requestSent) return true;
  return true;
}

function retainUnresolvedPlacement(
  state: RuntimeState,
  storyId: string,
  submission: PlacementPendingSubmission
): void {
  state.unresolvedPlacement = { storyId, submission };
}

function clearUnresolvedPlacement(
  state: RuntimeState,
  storyId: string
): void {
  if (state.unresolvedPlacement?.storyId === storyId) {
    state.unresolvedPlacement = null;
  }
}

/**
 * Close Aside and open Placement over the active story line.
 * Refuses while generation, Aside work, or another backend task is active.
 */
export function openPlacementFromAside(state: RuntimeState): boolean {
  const surface = state.aside;
  if (surface === null || surface.useMenu === null) return false;
  const blocked = placementBlockedReason(state);
  if (blocked !== null) {
    state.toast = blocked;
    return false;
  }
  // A guard for another story blocks every new Placement until recovery settles it.
  const guard = state.unresolvedPlacement;
  if (guard !== null && guard.storyId !== state.payload.id) {
    state.toast = PLACEMENT_UNCERTAIN_TOAST;
    return false;
  }
  const note = surface.notes[surface.useMenu.noteIndex];
  if (note === undefined || note.answer.trim().length === 0) {
    state.toast = "this Side Note has no answer to place";
    return false;
  }
  const stops = buildPlacementStops(state.payload);
  if (stops.length === 0) {
    state.toast = "no story line to place into";
    return false;
  }
  // Keep returnAside intact (focus, noteCursor, useMenu). Esc reattaches it.
  // Uncertain state is derived from the singular guard — no copy onto Placement.
  const sameStoryGuard = guard !== null && guard.storyId === state.payload.id;
  const placement: PlacementState = {
    answer: note.answer,
    stops,
    cursor: initialPlacementCursor(stops, surface.openingPartId),
    returnAside: surface,
    placingTaskId: null,
    // Bind Enter-place to this menu open, not only the destination stop.
    interactionId: surface.useMenu.sessionId
  };
  state.aside = null;
  state.placement = placement;
  state.mode = "PLACE";
  focusPlacementStop(state, placement);
  state.toast = sameStoryGuard ? PLACEMENT_UNCERTAIN_TOAST : null;
  return true;
}

export function cancelPlacement(state: RuntimeState): void {
  if (placementInputLocked(state)) return;
  const placement = state.placement;
  if (placement === null) return;
  // Esc reattaches the retained surface as-is. Submission identity stays on
  // unresolvedPlacement only; Esc does not invent focus or menu state.
  state.placement = null;
  state.aside = placement.returnAside;
  state.mode = "ASIDE";
  state.toast = null;
}

export function movePlacementCursor(state: RuntimeState, delta: number): void {
  if (placementInputLocked(state)) return;
  const placement = state.placement;
  if (placement === null || placement.stops.length === 0) return;
  placement.cursor = Math.max(
    0,
    Math.min(placement.stops.length - 1, placement.cursor + delta)
  );
  focusPlacementStop(state, placement);
}

export function focusPlacementStop(
  state: Pick<RuntimeState, "payload" | "stream" | "focusIndex" | "viewScroll" | "viewScrollDelta">,
  placement: PlacementState
): void {
  const stop = placement.stops[placement.cursor];
  if (stop === undefined) return;
  const view = createStoryViewModel(state.payload, state.stream);
  const partId = stop.kind === "take" ? stop.partId : stop.leafId;
  const index = rowIndexForNode(view, partId);
  if (index >= 0) {
    state.focusIndex = index;
    followStoryViewport(state);
  }
}

export function placementStopLabel(
  stop: PlacementStop,
  answer: string
): string {
  if (stop.kind === "take") {
    return `new take on ¶ ${stop.partNumber}`;
  }
  const preview = firstWords(answer, 8);
  return preview.length === 0
    ? `new Part after ¶ ${stop.partNumber - 1}`
    : `after leaf · ${preview}`;
}

export async function confirmPlacement(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const placement = state.placement;
  if (placement === null) return;
  if (placementInputLocked(state)) return;
  // Refuse before any submission identity is created or createNode is called.
  if (state.connection.down) {
    state.toast = "offline · reading still works";
    return;
  }
  // Singular guard blocks retry until recovery settles or a definite failure.
  if (storyPlacementMutationBlocked(state)) {
    state.toast = PLACEMENT_UNCERTAIN_TOAST;
    return;
  }
  const blocked = placementBlockedReason(state);
  if (blocked !== null) {
    state.toast = blocked;
    return;
  }
  const stop = placement.stops[placement.cursor];
  if (stop === undefined) return;
  const answer = placement.answer;
  const parentId = stop.kind === "take" ? stop.parentId : stop.leafId;
  const partNumber = stop.partNumber;
  const knownNodeIds = new Set(state.payload.nodes.map(({ id }) => id));
  const submission: PlacementPendingSubmission = {
    knownNodeIds,
    parentId,
    instruction: FROM_ASIDE_INSTRUCTION,
    text: answer.trim(),
    partNumber
  };
  await context.backend.run("placing Side Note", async (task) => {
    if (state.placement !== placement) return;
    // Guard or concurrent placing task must not be overwritten.
    if (storyPlacementMutationBlocked(state) || placement.placingTaskId !== null) {
      return;
    }
    // Singular guard + placing ownership before createNode.
    retainUnresolvedPlacement(state, task.storyId, submission);
    placement.placingTaskId = task.id;
    try {
      const payload = await source.api.createNode(task.storyId, {
        parentId,
        text: answer,
        instruction: FROM_ASIDE_INSTRUCTION
      });
      // Committed create: drop the singular guard even if Placement/story
      // ownership was lost mid-flight so later placements are not blocked.
      if (!task.storyCurrent()) {
        clearUnresolvedPlacement(state, task.storyId);
        return;
      }
      // Adopt and land only while this task still owns the current story.
      adoptSameStoryPayload(state, payload, context.cache);
      // Adoption settles when the singular guard matches the payload.
      if (state.placement !== placement) {
        rememberFocus(state, source);
        return;
      }
      const landed = findCreatedTake(
        payload,
        knownNodeIds,
        parentId,
        FROM_ASIDE_INSTRUCTION,
        answer.trim()
      );
      const landedId = landed?.id ?? payload.path.at(-1)?.id ?? null;
      completePlacementLanding(state, payload, landedId, partNumber);
      if (landedId !== null) rememberFocus(state, source);
    } catch (error) {
      // Definite failures clear the singular guard even when Placement ownership
      // was lost mid-flight so later placements are not permanently blocked.
      if (isDefinitePlacementFailure(error)) {
        clearUnresolvedPlacement(state, task.storyId);
      }
      // Current-story UI/toast stay ownership-gated.
      if (!task.storyCurrent() || state.placement !== placement) return;
      if (isDefinitePlacementFailure(error)) {
        state.toast = error instanceof Error ? error.message : String(error);
        return;
      }
      // Uncertain outcome: guard remains; placingTaskId clears in finally.
      const detail = error instanceof Error ? error.message : String(error);
      state.toast = `${detail} · ${PLACEMENT_UNCERTAIN_TOAST}`;
    } finally {
      if (state.placement === placement && placement.placingTaskId === task.id) {
        placement.placingTaskId = null;
      }
    }
  });
}

export const PLACEMENT_STATUS_TEXT = "nothing is written until Enter";
export const PLACEMENT_KEYLINE = "Up/Down where · Enter place · Esc back to Aside";
/** Status while Placement owns the placing backend task. */
export const PLACEMENT_PLACING_STATUS = "placing Side Note · wait";
/** Keyline while input is locked; no Esc/arrow/Enter hints. */
export const PLACEMENT_PLACING_KEYLINE = "placing…";
/** Status after an uncertain createNode outcome. */
export const PLACEMENT_UNCERTAIN_STATUS = "outcome unknown · wait for recovery";
/** Toast when Enter is blocked on an unresolved uncertain submission. */
export const PLACEMENT_UNCERTAIN_TOAST = "outcome unknown · wait for recovery";
