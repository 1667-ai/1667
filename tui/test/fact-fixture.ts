import type { FactState } from "../../shared/fact-state.js";
import { firstFactText, isFactEndState } from "../../shared/fact-state.js";
import type { StoryFact } from "../../shared/types.js";

/** Build a canonical Fact fixture without repeating the state envelope in
 * every TUI test. The helper keeps metadata from the source Fact. */
export function factWithText(
  source: StoryFact,
  text: string,
  overrides: Partial<StoryFact> = {}
): StoryFact {
  const current = source.states.find((state) => !isFactEndState(state));
  const state: FactState = {
    id: current?.id ?? `${source.id}-state`,
    ...(current?.anchorPartId === undefined ? {} : { anchorPartId: current.anchorPartId }),
    text,
    createdAt: current?.createdAt ?? source.createdAt,
    updatedAt: current?.updatedAt ?? source.updatedAt
  };
  return { ...source, ...overrides, states: [state] };
}

export function factText(fact: StoryFact): string {
  return firstFactText(fact);
}

/** Small standalone Fact fixture for model tests that do not need a demo
 * payload. */
export function makeFact(
  id: string,
  text: string,
  tag: string | null = null,
  overrides: Partial<StoryFact> = {}
): StoryFact {
  const stamp = "2026-07-18T10:00:00Z";
  return {
    id,
    tag,
    states: [{ id, text, createdAt: stamp, updatedAt: stamp }],
    activation: "always",
    keys: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides
  };
}
