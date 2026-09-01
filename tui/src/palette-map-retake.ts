import { rerouteToNode, runPartAction } from "./story-actions.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import type { PaletteSession } from "./palette-owner.js";
import type { RuntimeState } from "./state.js";

/** Run Retake for the row selected in a suspended Map palette. */
export async function runPaletteMapRetake(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  target: string | null | undefined,
  paletteSession: PaletteSession
): Promise<void> {
  if (target === null) {
    state.mode = "MAP";
    state.toast = "select a visible story part before retaking it";
    return;
  }
  if (target === undefined) {
    state.mode = "NAV";
    await runPartAction("retake", state, source, context);
    return;
  }

  // Map rows outside the active path expose stubs. Land the selected row
  // first so the canonical retake reducer receives the full StoryNode.
  const map = state.map;
  if (map === null) {
    state.mode = "MAP";
    state.toast = "select a visible story part before retaking it";
    return;
  }

  // Keep the exact Map/palette operation that selected this row. A reroute may
  // adopt its payload after Escape or a newer Ctrl-P has taken ownership.
  const interactionVersion = state.interactionVersion;
  const view = map.view;
  const cursorId = view === "path" ? map.pathCursorId : map.treeCursorId;
  let ownsLanding = state.payload.path.some(({ id }) => id === target);
  if (!ownsLanding) {
    await rerouteToNode(state, source, context, target, {
      owns: (ownedState) => ownedState.mode === "MAP"
        && ownedState.map !== null
        && ownedState.map.view === view
        && (ownedState.map.view === "path"
          ? ownedState.map.pathCursorId
          : ownedState.map.treeCursorId) === cursorId
        && ownedState.interactionVersion === interactionVersion
        && (ownedState.commands === null || ownedState.commands === paletteSession),
      release: (ownedState) => {
        ownsLanding = true;
        if (ownedState.map !== null
          && ownedState.map.view === view
          && (ownedState.map.view === "path"
            ? ownedState.map.pathCursorId
            : ownedState.map.treeCursorId) === cursorId) {
          ownedState.map = null;
        }
      }
    });
  }
  if (ownsLanding && state.payload.path.some(({ id }) => id === target)) {
    state.mode = "NAV";
    await runPartAction("retake", state, source, context, target);
  } else if (state.mode === "MAP") {
    state.toast ??= "select a visible story part before retaking it";
  }
}
