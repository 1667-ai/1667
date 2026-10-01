import { subtreePruneCore } from "../../../shared/prune-plan.js";
import type { StoryPayload } from "../../../shared/types.js";

/** What one confirmed delete removes, read from the story when `D` is
 * pressed. `parts` counts the part itself and everything below it — the same
 * number the server checks (`expectedSubtreeCount`). */
export interface DeletePlan {
  readonly storyId: string;
  readonly nodeId: string;
  readonly partNumber: number;
  readonly take: number;
  readonly takeCount: number;
  readonly parts: number;
  readonly lines: number;
  readonly tags: readonly string[];
  readonly factStates: number;
}

/** The web wording of the shared prune core (`shared/prune-plan.ts`). */
export function createDeletePlan(payload: StoryPayload, nodeId: string): DeletePlan | null {
  const core = subtreePruneCore(payload, nodeId);
  if (core === null) return null;
  return {
    storyId: payload.id,
    nodeId,
    partNumber: core.part,
    take: core.take,
    takeCount: core.takeCount,
    parts: core.parts,
    lines: core.lines,
    tags: core.tags.map((tag) => tag.name),
    factStates: core.dyingStates.length
  };
}

/** Plain wording of what a delete removes, from the plan the `D` key made. */
export function deleteQuestion(plan: DeletePlan): string {
  const below = plan.parts - 1;
  if (below === 0) return `Delete part ${plan.partNumber}?`;
  return `Delete part ${plan.partNumber} and the ${below} ${below === 1 ? "part" : "parts"} below it?`;
}
