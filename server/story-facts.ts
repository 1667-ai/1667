import { randomUUID } from "node:crypto";
import type { Story } from "../shared/types.js";
import {
  createFacts as applyCreateFacts,
  createFactState as applyCreateFactState
} from "../shared/story-fact-mutations.js";
export * from "../shared/story-fact-mutations.js";

export function createFacts(
  story: Story,
  value: unknown,
  idForIndex: (index: number) => string = () => randomUUID()
): boolean {
  return applyCreateFacts(story, value, idForIndex);
}

export function createFactState(
  story: Story,
  factId: string,
  value: unknown,
  stateId: string = randomUUID()
): boolean {
  return applyCreateFactState(story, factId, value, stateId);
}
