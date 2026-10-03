import { factRows } from "../../../shared/fact-view.js";
import type { StoryFact, StoryPayload } from "../../../shared/types.js";
import type { FactsFilter } from "./state.js";

/** The facts the list shows: the filter applied at the line being read. */
export function visibleFacts(payload: StoryPayload, filter: FactsFilter): StoryFact[] {
  return factRows(payload.facts, filter.tag, filter.query, payload.path.map((node) => node.id), filter.scope);
}

/** True while a scope, tag or text filter hides some facts. */
export function filterActive(filter: FactsFilter): boolean {
  return filter.scope !== "everywhere" || filter.tag !== null || filter.query.length > 0;
}
