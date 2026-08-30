import {
  canonicalFactStates,
  isFactEndState,
  resolveFactState,
  type FactState
} from "../../shared/fact-state.js";
import { createStoryIndex, type StoryIndex } from "../../shared/story-model.js";
import { pathTo } from "../../shared/story-tree.js";
import type { StoryFact, StoryPayload } from "../../shared/types.js";

/** Presentation status for one node in the existing map tree. It is derived
 * from the request resolver for the selected Fact on every frame. */
export type FactLensNodeKind = "active" | "later" | "off-path" | "ended" | "dead";

export interface FactLensNode {
  kind: FactLensNodeKind;
  stateIndex: number | null;
  /** Any state anchored here gets a marker, even when a deeper state wins. */
  anchor: boolean;
  /** This row carries an End State anchor (or an unanchored End at a root). */
  end: boolean;
}

/** Resolve one map node against one Fact. No result is persisted or reused by
 * the map action path; this keeps the lens a view over the canonical resolver. */
export function factLensNode(
  fact: StoryFact,
  index: StoryIndex,
  nodeId: string
): FactLensNode | null {
  const states = canonicalFactStates(fact);
  const anchor = states.some((state) => state.anchorPartId === nodeId);
  let path: StoryPayload["nodes"];
  try {
    path = pathTo(index.tree, nodeId);
  } catch {
    // A projected/partial frame can briefly carry a row without its ancestry.
    // It has no honest reach result until the next complete frame.
    return null;
  }
  const end = states.some((state) => state.anchorPartId === nodeId && isFactEndState(state))
    || path.length === 1 && states.some((state) => state.anchorPartId === undefined && isFactEndState(state));
  const resolution = resolveFactState(fact, path);
  if (resolution.kind === "off-path") return { kind: "off-path", stateIndex: null, anchor, end };
  const stateIndex = states.findIndex((state) => state.id === resolution.state.id);
  if (resolution.kind === "ended") {
    return { kind: end ? "ended" : "dead", stateIndex, anchor, end };
  }
  return { kind: stateIndex > 0 ? "later" : "active", stateIndex, anchor, end: false };
}

export interface FactLensAnchor {
  nodeId: string;
  state: FactState;
}

/** Return the selected visible anchor, preferring the tree cursor. */
export function factLensAnchorForRows(
  fact: StoryFact,
  rows: readonly { id: string }[],
  cursorId: string | null
): FactLensAnchor | null {
  const states = canonicalFactStates(fact);
  const cursorIsVisible = cursorId !== null && rows.some((row) => row.id === cursorId);
  const ordered = !cursorIsVisible
    ? rows
    : [{ id: cursorId! }, ...rows.filter((row) => row.id !== cursorId)];
  for (const row of ordered) {
    const state = states.find((candidate) => candidate.anchorPartId === row.id);
    if (state !== undefined) return { nodeId: row.id, state };
  }
  return null;
}

/** Resolve the state a cursor row currently carries. Anchored rows win over
 * the effective state so `e` edits the state whose ◆ the cursor sits on. */
export function factLensStateAtNode(
  fact: StoryFact,
  payload: StoryPayload,
  nodeId: string | null
): FactState | null {
  const states = canonicalFactStates(fact);
  if (nodeId !== null) {
    const anchor = states.find((state) => state.anchorPartId === nodeId);
    if (anchor !== undefined) return anchor;
    try {
      const resolution = resolveFactState(fact, pathTo(createStoryIndex(payload).tree, nodeId));
      if (resolution.kind === "off-path") return null;
      return resolution.state;
    } catch {
      // Fall through to the first state while the tree projection settles.
    }
  }
  return states[0] ?? null;
}
