import { subtreePruneCore } from "../../shared/prune-plan.js";
import { unusedTakePruneSelection } from "../../shared/story-tree.js";
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
  const core = subtreePruneCore(payload, nodeId);
  if (core === null) return null;
  const dyingStates = core.dyingStates.map((dying): PrunedFactState => ({
    factName: factName(dying.fact),
    stateOrdinal: dying.stateOrdinal,
    stateCount: dying.stateCount
  }));
  return {
    kind: "subtree",
    nodeId,
    part: core.part,
    take: core.take,
    takeCount: core.takeCount,
    parts: core.parts,
    lines: core.lines,
    tags: [...core.tags],
    states: dyingStates.length,
    factsLosingLastState: core.factsLosingLastState.length,
    dyingStates,
    factsLosingLastStateNames: core.factsLosingLastState.map((fact) => factName(fact))
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
