import { recordSessionNotices } from "./notice-log.js";
import type { ActionContext } from "./story-actions.js";
import type { RuntimeState } from "./state.js";

export function finalizeDispatch(
  previousMode: RuntimeState["mode"],
  state: RuntimeState,
  renderer: ActionContext["renderer"],
  repaint: () => void
): void {
  if (previousMode === "FACTS" && state.mode !== "FACTS" && state.mode !== "COMMANDS"
    && state.facts !== null
    && "storySelection" in state.facts) {
    state.facts.storySelection = null;
  }
  // Native buffer offsets must not leak between the story, Direct, and the
  // full-screen editor when their rendered document changes.
  const previousTextSurface = previousMode === "COMPOSE"
    || previousMode === "EDITOR"
    || previousMode === "ASIDE";
  const currentTextSurface = state.mode === "COMPOSE"
    || state.mode === "EDITOR"
    || state.mode === "ASIDE";
  if (state.mode !== previousMode && (previousTextSurface || currentTextSurface)) {
    renderer?.clearSelection();
  }
  recordSessionNotices(state);
  repaint();
}
