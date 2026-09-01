import { factRows } from "./facts-model.js";
import { mapCursorNodeId } from "./map-actions.js";
import { createStoryViewModel, rowPart } from "./model.js";
import type { RuntimeState } from "./state.js";

type FactsAnchorState = Pick<RuntimeState, "payload" | "stream" | "mode" | "commands" | "focusIndex" | "now">
  & {
    map?: RuntimeState["map"];
    probs?: { nodeId: string } | null;
    record?: { nodeId: string } | null;
  };

/** Resolve the story part that an anchored Fact command would use.
 *
 * The command palette, its renderer, mouse reconciliation, and the command
 * runner all call this function. MAP, PROBS, and RECORD own cursors that are
 * different from NAV focus, so resolve their displayed node first. Non-MAP
 * structural rows (chapter summaries and dividers) are not valid Fact anchors
 * and fail closed. */
export function factsOpeningPartId(state: FactsAnchorState): string | null {
  const owner = state.mode === "COMMANDS"
    ? state.commands?.returnMode
    : state.mode;
  const candidateId = owner === "MAP"
    ? mapCursorNodeId(state)
    : owner === "PROBS"
      ? state.probs?.nodeId ?? null
      : owner === "RECORD"
        ? state.record?.nodeId ?? null
        : focusedStoryPartId(state);
  if (candidateId === null) return null;
  const node = state.payload.nodes.find(({ id }) => id === candidateId);
  return node === undefined || node.role === "summary" ? null : node.id;
}

function focusedStoryPartId(state: FactsAnchorState): string | null {
  const view = createStoryViewModel(state.payload, state.stream);
  const row = view.rows[state.focusIndex];
  if (row !== undefined) return rowPart(view, state.focusIndex)?.node.id ?? null;
  return state.payload.path.at(-1)?.id ?? null;
}

/** Context for commands that operate the already-open Facts or Map surface.
 *  The command only selects the canonical reducer; it never creates a second
 *  target picker or a parallel mutation path. */
export function factsPaletteContext(state: {
  facts: RuntimeState["facts"];
  payload: RuntimeState["payload"];
  map?: RuntimeState["map"];
  mode: RuntimeState["mode"];
  commands?: RuntimeState["commands"];
}): {
  factsPanel: boolean;
  factsDossier: boolean;
  factsFiltering: boolean;
  factsHasFilter: boolean;
  factsSelected: boolean;
  factsCanMoveUp: boolean;
  factsCanMoveDown: boolean;
  mapTree: boolean;
  mapFactLens: boolean;
} {
  const owner = state.commands?.returnMode ?? state.mode;
  const mapTree = owner === "MAP" && state.map?.view === "tree";
  const mapFactLens = mapTree && state.map?.factLensFactId != null;
  const overlay = owner === "FACTS" ? state.facts : null;
  if (overlay === null) {
    return {
      factsPanel: false,
      factsDossier: false,
      factsFiltering: false,
      factsHasFilter: false,
      factsSelected: false,
      factsCanMoveUp: false,
      factsCanMoveDown: false,
      mapTree,
      mapFactLens
    };
  }
  const factsDossier = overlay.dossier != null;
  if (factsDossier) {
    return {
      factsPanel: true,
      factsDossier: true,
      factsFiltering: false,
      factsHasFilter: false,
      factsSelected: state.payload.facts.some(({ id }) => id === overlay.dossier?.factId),
      factsCanMoveUp: false,
      factsCanMoveDown: false,
      mapTree,
      mapFactLens
    };
  }
  const rows = factRows(
    state.payload.facts,
    overlay.selectedTag,
    overlay.query,
    state.payload.path.map(({ id }) => id),
    overlay.scopeFilter ?? "everywhere"
  );
  const selected = rows[overlay.cursor];
  const selectedIndex = selected === undefined
    ? -1
    : state.payload.facts.findIndex(({ id }) => id === selected.id);
  const canReorder = !overlay.filtering && overlay.query.length === 0 && overlay.selectedTag === null;
  return {
    factsPanel: true,
    factsDossier: false,
    factsFiltering: overlay.filtering,
    factsHasFilter: overlay.query.length > 0 || overlay.selectedTag !== null,
    factsSelected: selected !== undefined,
    factsCanMoveUp: canReorder && selectedIndex > 0,
    factsCanMoveDown: canReorder && selectedIndex >= 0 && selectedIndex < state.payload.facts.length - 1,
    mapTree,
    mapFactLens
  };
}
