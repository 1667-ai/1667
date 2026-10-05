import { continuationIntent } from "../../../shared/continuation-intent.js";
import type { GenerationTarget } from "../../../shared/stopped-generation.js";
import type { StoryNode, StoryPayload } from "../../../shared/types.js";
import { textHash } from "../../../client/api.js";
import { DEFAULT_INSTRUCTION } from "../../../shared/continuation-plan.js";
import { resolveDefaultContinueDirection } from "../../../shared/writing-prompt-runtime.js";

/**
 * What Continue is about to ask for, computed the exact same way the TUI's
 * own `generate()` does (`shared/continuation-intent.ts`, moved there in
 * step 5 precisely so both surfaces share it) — TUI parity is an owner
 * decision, not a coincidence. A typed instruction always opens a take; a
 * retake (`regenerateNode`) opens a sibling of that part.
 */
export interface GenerationPlan {
  readonly target: GenerationTarget;
  readonly seamPathIndex: number;
  /**
   * The instruction a saved new take records — `continuationIntent`'s own
   * resolved default direction (e.g. "Continue the story.") when the writer
   * typed nothing, exactly like the TUI's `stream.instruction` for a take.
   * For `target.mode: "append"` this is always the empty, untrimmed request
   * instruction (append only happens when that was already empty), matching
   * `AppendNodeRequest.instruction` always being `""`.
   *
   * This is NOT what `continueStory` sends the server as its own
   * `instruction` argument — that is always the writer's raw, unresolved
   * text (possibly empty), because the server resolves the same default
   * itself when it builds the prompt (`shared/continuation-plan.ts`). Only
   * the save path needs the resolved value; the caller passes the raw one
   * to `continueStory` directly, without going through this plan.
   */
  readonly instruction: string;
}

export interface PlanRequest {
  readonly focusedPartId: string | null;
  /** What the writer typed; empty for a plain Continue. */
  readonly instruction?: string;
  readonly defaultContinueDirection?: string;
  /** The part a retake replaces. */
  readonly retakeNode?: StoryNode | null;
  /** An empty direction still opens a new take (images go with a take): the
   * configured default direction applies, as for any new take. */
  readonly forceTake?: boolean;
}

export async function planContinue(payload: StoryPayload, request: PlanRequest): Promise<GenerationPlan> {
  const requestedInstruction = request.instruction ?? "";
  const regenerateNode = request.retakeNode ?? null;
  const forced = request.forceTake === true && requestedInstruction.trim().length === 0;
  // A stand-in direction makes the intent a take; the saved instruction is
  // the configured default, which the server resolves the same way.
  const intent = continuationIntent(
    payload, request.focusedPartId, forced ? "." : requestedInstruction, regenerateNode, request.defaultContinueDirection
  );
  if (forced) intent.instruction = resolveDefaultContinueDirection(request.defaultContinueDirection ?? DEFAULT_INSTRUCTION);
  // A retake hides the part it replaces and everything below it, so the
  // streaming take takes that part's own number (the TUI's `virtualNumber`).
  // A Continue from the middle hides what follows the focused part.
  let seamPathIndex = intent.fromSeam ? intent.focusPathIndex : payload.path.length - 1;
  if (regenerateNode !== null) {
    const retakeIndex = payload.path.findIndex((node) => node.id === regenerateNode.id);
    if (retakeIndex < 0) throw new Error("1667 web: retake target is not on the line");
    seamPathIndex = retakeIndex - 1;
  }
  if (intent.appendLast) {
    const leaf = intent.leaf;
    // `intent.appendLast` is only ever true when `continuationIntent` found
    // a leaf to append to; the two fields are just not correlated at the
    // type level. A thrown error here (never a silent `leaf!.id`) is exactly
    // as loud as the invariant actually breaking should be.
    if (leaf === null) throw new Error("1667 web: appendLast without a leaf");
    return {
      target: { mode: "append", appendTo: leaf.id, expectedTextHash: await textHash(leaf.text) },
      seamPathIndex,
      instruction: requestedInstruction.trim()
    };
  }
  return {
    target: { mode: "take", parentId: intent.parentId },
    seamPathIndex,
    instruction: intent.instruction
  };
}
