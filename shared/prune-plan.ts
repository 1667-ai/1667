import { canonicalFactStates } from "./fact-state.js";
import { createStoryIndex } from "./story-model.js";
import { subtreeIds, takeIndex } from "./story-tree.js";
import type { StoryPayload, Tag } from "./types.js";

type PayloadFact = StoryPayload["facts"][number];

/** What deleting one part and everything under it removes, as plain data.
 * The TUI (`tui/src/prune-model.ts`) and the web UI
 * (`web/src/story/part-commands.ts`) both read it and word it their own way. */
export interface SubtreePruneCore {
  readonly nodeId: string;
  /** The part's 1-based place on its line. */
  readonly part: number;
  /** The part's take among its siblings, and how many siblings there are. */
  readonly take: number;
  readonly takeCount: number;
  /** The part itself and every part below it: the number the server checks. */
  readonly parts: number;
  readonly lines: number;
  readonly tags: ReadonlyArray<Pick<Tag, "name" | "status">>;
  /** States anchored in the removed subtree. */
  readonly dyingStates: ReadonlyArray<{
    readonly fact: PayloadFact;
    readonly stateOrdinal: number;
    readonly stateCount: number;
  }>;
  /** Facts whose every state is anchored in the removed subtree. */
  readonly factsLosingLastState: readonly PayloadFact[];
}

export function subtreePruneCore(payload: StoryPayload, nodeId: string): SubtreePruneCore | null {
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const ids = new Set(subtreeIds(index.tree, nodeId));
  const position = takeIndex(index.tree, nodeId);
  const dyingStates = payload.facts.flatMap((fact) => {
    const states = canonicalFactStates(fact);
    return states
      .filter((state) => state.anchorPartId !== undefined && ids.has(state.anchorPartId))
      .map((state) => ({
        fact,
        stateOrdinal: states.findIndex(({ id }) => id === state.id) + 1,
        stateCount: states.length
      }));
  });
  return {
    nodeId,
    part: index.depthByNodeId.get(nodeId) ?? 1,
    take: position.index,
    takeCount: position.count,
    parts: index.subtreeCountByNodeId.get(nodeId) ?? ids.size,
    lines: node.leafCount,
    tags: payload.tags
      .filter((tag) => ids.has(tag.nodeId))
      .map(({ name, status }) => ({ name, status })),
    dyingStates,
    factsLosingLastState: payload.facts.filter((fact) => canonicalFactStates(fact).every(
      (state) => state.anchorPartId !== undefined && ids.has(state.anchorPartId)
    ))
  };
}
