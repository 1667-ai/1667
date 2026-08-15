/**
 * Placement settlement against an authoritative same-story payload.
 * Free of story-adoption imports so recovery and createNode share one path.
 */
import type { StoryPayload } from "../../shared/types.js";
import { findSubmittedPlacementNode } from "./aside-placement-model.js";
import {
  createStoryViewModel,
  rowIndexForNode,
  rowPart
} from "./model.js";
import type { RuntimeState } from "./state.js";
import { followStoryViewport } from "./viewport-intent.js";

/**
 * Active Placement success: close Placement, land focus, go to NAV.
 * Used only while the writer is still in PLACE owning the submission.
 */
export function completePlacementLanding(
  state: RuntimeState,
  payload: StoryPayload,
  landedId: string | null,
  partNumber: number
): void {
  state.placement = null;
  state.unresolvedPlacement = null;
  state.mode = "NAV";
  reportPlacedPart(state, payload, landedId, partNumber, true);
}

/**
 * Detached guard success: clear only the mutation guard and report placement.
 * Preserve the current mode and every owned surface/draft (COMPOSE, ASIDE,
 * SETTINGS, LIBRARY, …). Do not steal focus behind an active modal.
 */
export function completeDetachedPlacementSettlement(
  state: RuntimeState,
  payload: StoryPayload,
  landedId: string | null,
  partNumber: number
): void {
  state.unresolvedPlacement = null;
  reportPlacedPart(state, payload, landedId, partNumber, false);
}

function reportPlacedPart(
  state: RuntimeState,
  payload: StoryPayload,
  landedId: string | null,
  partNumber: number,
  moveFocus: boolean
): void {
  if (landedId === null) {
    state.toast = `placed as Part ${partNumber}`;
    return;
  }
  const view = createStoryViewModel(payload);
  const index = rowIndexForNode(view, landedId);
  if (moveFocus && index >= 0) {
    state.focusIndex = index;
    followStoryViewport(state);
  }
  state.freshLandedAt = new Map(state.freshLandedAt).set(landedId, Date.now());
  const number = index >= 0
    ? rowPart(view, index)?.number ?? partNumber
    : partNumber;
  state.toast = `placed as Part ${number}`;
}

/**
 * When the singular unresolved guard matches an authoritative same-story node
 * (exact path identity), settle active Placement or a detached guard.
 * Returns true when settlement ran.
 */
export function trySettlePlacementFromPayload(
  state: RuntimeState,
  payload: StoryPayload
): boolean {
  if (payload.id !== state.payload.id) return false;
  const guard = state.unresolvedPlacement;
  if (guard === null || guard.storyId !== payload.id) return false;
  const candidate = guard.submission;
  // Uncertain recovery: exact path text + instruction only (no stub approx).
  const landed = findSubmittedPlacementNode(payload, candidate);
  if (landed === undefined) return false;
  const activePlacement = state.mode === "PLACE" && state.placement !== null;
  if (activePlacement) {
    completePlacementLanding(state, payload, landed.id, candidate.partNumber);
  } else {
    completeDetachedPlacementSettlement(
      state,
      payload,
      landed.id,
      candidate.partNumber
    );
  }
  return true;
}
