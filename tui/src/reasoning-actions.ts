import type { ReasoningRecord } from "../../shared/reasoning.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import type { StoryPart } from "./model.js";
import { partHasThought, thoughtUnfolded } from "./reasoning-model.js";
import { streamForPart } from "./stream-text.js";
import type { RuntimeState } from "./state.js";

/** Start loading `part`'s stored thought when the row layout is about to need
 *  it and nothing has asked for it yet — mirrors `getTokenProbabilities`'s
 *  on-demand fetch (token-probabilities-actions.ts), with one difference:
 *  this is a passive, ambient fetch triggered by focus moving or a fold
 *  toggling, not a deliberate "open the viewer" action, so it must never
 *  contend for `ActionRunner.run`'s single exclusive slot the way
 *  `loadTokenProbabilities` does. `backend.observe` is the established
 *  escape hatch for exactly that (see `resolveSamplingBias`,
 *  sampling-bias-resolution.ts): it surfaces a genuine failure without
 *  claiming the slot a writer's next real action might need.
 *
 * A no-op unless every one of these holds: reasoning display is not `off`,
 * the part actually has a thought, that thought is not already sitting live
 * in `state.stream` (nothing to fetch), the part is currently rendered
 * unfolded (nothing to show otherwise), and no fetch for this exact node id
 * has ever been started (`state.thoughts` entries are permanent once
 * written — a node id names one immutable take, never re-fetched). */
export function ensureThoughtLoaded(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  part: StoryPart
): void {
  if (state.reasoning === "off") return;
  if (!partHasThought(part, state)) return;
  if (streamForPart(state.stream, part.id) !== null) return;
  if (!thoughtUnfolded(state, part)) return;
  if (state.thoughts.has(part.id)) return;
  state.thoughts.set(part.id, { status: "loading" });
  context.repaint();
  context.backend.observe(loadThought(state, source, context, state.payload.id, part.id));
}

async function loadThought(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  storyId: string,
  nodeId: string
): Promise<void> {
  let record: ReasoningRecord | null = null;
  try {
    record = await source.api.getReasoning(storyId, nodeId);
  } catch {
    // A stub said the take had one; a 404 here is a race (pruned, or the
    // object failed to write) rather than a capability question — the same
    // reasoning `loadTokenProbabilities` documents for its own catch.
    record = null;
  }
  state.thoughts.set(nodeId, record === null ? { status: "error" } : { status: "ready", record });
  context.repaint();
}
