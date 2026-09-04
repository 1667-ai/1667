import type { ProjectedStorySelection } from "./selection-projection.js";
import type { RuntimeState } from "./state.js";

/** Open the canonical Facts surface at an optional payload fact index. */
export function openFactsAtIndex(
  state: RuntimeState,
  index?: number,
  storySelection?: ProjectedStorySelection | null
): void {
  state.facts = {
    cursor: 0,
    query: "",
    chip: 0,
    selectedTag: null,
    filtering: false,
    deleteArmedId: null,
    scopeFilter: "everywhere",
    dossier: null,
    storySelection: storySelection ?? null
  };
  if (index !== undefined) {
    state.facts.cursor = Math.max(0, Math.min(state.payload.facts.length - 1, index));
  }
  state.mode = "FACTS";
}
