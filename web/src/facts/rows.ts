import { canonicalFactStates } from "../../../shared/fact-state.js";
import { factRows } from "../../../shared/fact-view.js";
import type { StoryFact, StoryPayload } from "../../../shared/types.js";
import type { FactsFilter } from "./state.js";

/** The fact states anchored at a part, as the number of states (the ◆ mark). */
export function anchoredStateCount(payload: StoryPayload, partId: string): number {
  return payload.facts.reduce(
    (total, fact) => total + canonicalFactStates(fact).filter((state) => state.anchorPartId === partId).length,
    0
  );
}

/** The facts the list shows: the filter applied at the line being read. */
export function visibleFacts(payload: StoryPayload, filter: FactsFilter): StoryFact[] {
  const rows = factRows(payload.facts, filter.tag, filter.query, payload.path.map((node) => node.id), filter.scope);
  const anchor = filter.anchorPartId;
  return anchor === null
    ? rows
    : rows.filter((fact) => canonicalFactStates(fact).some((state) => state.anchorPartId === anchor));
}

/** True while a scope, tag, text or part filter hides some facts. */
export function filterActive(filter: FactsFilter): boolean {
  return filter.scope !== "everywhere" || filter.tag !== null || filter.query.length > 0 || filter.anchorPartId !== null;
}
