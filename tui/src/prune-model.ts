import { createStoryIndex } from "../../shared/story-model.js";
import { subtreeIds, takeIndex, unusedTakePruneSelection } from "../../shared/story-tree.js";
import { canonicalFactStates } from "../../shared/fact-state.js";
import type { Tag, StoryPayload } from "../../shared/types.js";
import { factName } from "./facts-model.js";
import { tagGlyph } from "./tag-presentation.js";

export interface PrunedFactState {
  factName: string;
  stateOrdinal: number;
  stateCount: number;
}

export interface SubtreePrunePlan {
  kind: "subtree";
  nodeId: string;
  part: number;
  take: number;
  takeCount: number;
  parts: number;
  lines: number;
  tags: Array<Pick<Tag, "name" | "status">>;
  /** States anchored in the removed subtree. They do not move to a new
   * anchor; the deletion removes their scope with the part. */
  states?: number;
  /** Facts whose final state is anchored in the removed subtree. */
  factsLosingLastState?: number;
  /** Names shown in the deletion receipt. Derived from the current payload. */
  dyingStates?: PrunedFactState[];
  /** Names of Facts that have no state left after this deletion. */
  factsLosingLastStateNames?: string[];
}

export interface UnusedTakesPrunePlan {
  kind: "unused-takes";
  storyRevision: string;
  takes: number;
  parts: number;
  /** Unused-take pruning protects anchored Fact states. */
  states?: number;
  factsLosingLastState?: number;
}

export type PrunePlan = SubtreePrunePlan | UnusedTakesPrunePlan;

export function createPrunePlan(payload: StoryPayload, nodeId: string): SubtreePrunePlan | null {
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const ids = new Set(subtreeIds(index.tree, nodeId));
  const position = takeIndex(index.tree, nodeId);
  const affected = payload.facts.flatMap((fact) => canonicalFactStates(fact)
    .filter((state) => state.anchorPartId !== undefined && ids.has(state.anchorPartId))
    .map((state): PrunedFactState => {
      const states = canonicalFactStates(fact);
      return {
        factName: factName(fact),
        stateOrdinal: states.findIndex(({ id }) => id === state.id) + 1,
        stateCount: states.length
      };
    }));
  const factsLosingLastState = new Set(
    payload.facts
      .filter((fact) => canonicalFactStates(fact).every(
        (state) => state.anchorPartId !== undefined && ids.has(state.anchorPartId)
      ))
      .map((fact) => fact.id)
  );
  return {
    kind: "subtree",
    nodeId,
    part: index.depthByNodeId.get(nodeId) ?? 1,
    take: position.index,
    takeCount: position.count,
    parts: index.subtreeCountByNodeId.get(nodeId) ?? ids.size,
    lines: node.leafCount,
    tags: payload.tags
      .filter((tag) => ids.has(tag.nodeId))
      .map(({ name, status }) => ({ name, status })),
    states: affected.length,
    factsLosingLastState: factsLosingLastState.size,
    dyingStates: affected,
    factsLosingLastStateNames: payload.facts
      .filter((fact) => factsLosingLastState.has(fact.id))
      .map((fact) => factName(fact))
  };
}

export function createUnusedTakesPrunePlan(payload: StoryPayload): UnusedTakesPrunePlan | null {
  const selection = unusedTakePruneSelection(payload);
  if (selection.takeIds.length === 0) return null;
  return {
    kind: "unused-takes",
    storyRevision: payload.updatedAt,
    takes: selection.takeIds.length,
    parts: selection.nodeIds.length,
    states: 0,
    factsLosingLastState: 0
  };
}

export function pruneConfirmText(plan: PrunePlan): string {
  if (plan.kind === "unused-takes") {
    const takeWord = plan.takes === 1 ? "take" : "takes";
    const partWord = plan.parts === 1 ? "part" : "parts";
    return `${plan.takes} unused ${takeWord} → ${plan.parts} ${partWord} die · keeps continuations, named lines + one leaf/fork · D confirms · esc keeps`;
  }
  const tags = plan.tags.length === 0
    ? ""
    : `${plan.tags.map((tag) => `${tagGlyph(tag.status)} ${tag.name}`).join(", ")} · `;
  const partWord = plan.parts === 1 ? "part" : "parts";
  const lineWord = plan.lines === 1 ? "line" : "lines";
  const stateCount = plan.states ?? 0;
  const lostFactCount = plan.factsLosingLastState ?? 0;
  const dyingStates = plan.dyingStates ?? [];
  const lastStateNames = plan.factsLosingLastStateNames ?? [];
  const stateNote = stateCount === 0
    ? ""
    : ` · ◆ ${stateCount} ${stateCount === 1 ? "Fact state" : "Fact states"} die with it: ${dyingStates
      .map(({ factName: name, stateOrdinal, stateCount: total }) => `${name} st.${stateOrdinal}/${total}`)
      .join(", ")}${lostFactCount === 0
      ? ""
      : ` · ${lostFactCount} ${lostFactCount === 1 ? "Fact loses" : "Facts lose"} their last state (${lastStateNames.join(", ")})`} · never re-anchored · scope never widens silently`;
  return `${tags}¶ ${plan.part} take ${plan.take}/${plan.takeCount} → ${plan.parts} ${partWord} on ${plan.lines} ${lineWord} die${stateNote} · D confirms · esc keeps`;
}
