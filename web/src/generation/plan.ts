import { continuationIntent } from "../../../shared/continuation-intent.js";
import type { StoryPayload } from "../../../shared/types.js";
import { textHash } from "../../../client/api.js";
import type { GenerationMode } from "./state.js";

/**
 * What Continue is about to ask for, computed the exact same way the TUI's
 * own `generate()` does (`shared/continuation-intent.ts`, moved there in
 * step 5 precisely so both surfaces share it) — TUI parity is an owner
 * decision, not a coincidence. Only an empty instruction is in scope for
 * step 5 (the composer seam, `instruction`, is step 6's).
 */
export interface GenerationPlan {
  readonly mode: GenerationMode;
  readonly appendTo: string | null;
  /** Set only for `mode: "append"` — the hash `createNode`'s `AppendNodeRequest`
   *  must echo back so the server can refuse a save against text that moved
   *  under it. Computed once, before the stream starts, from the leaf's text
   *  at that moment — never recomputed mid-stream. */
  readonly expectedTextHash: string | undefined;
  readonly parentId: string | null;
  readonly seamPathIndex: number;
  /**
   * The instruction a saved new take records — `continuationIntent`'s own
   * resolved default direction (e.g. "Continue the story.") when the writer
   * typed nothing, exactly like the TUI's `stream.instruction` for a take.
   * For `mode: "append"` this is always the empty, untrimmed request
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

export async function planContinue(
  payload: StoryPayload,
  focusedPartId: string | null,
  requestedInstruction = ""
): Promise<GenerationPlan> {
  const intent = continuationIntent(payload, focusedPartId, requestedInstruction);
  const seamPathIndex = intent.fromSeam ? intent.focusPathIndex : payload.path.length - 1;
  if (intent.appendLast) {
    const leaf = intent.leaf!;
    return {
      mode: "append",
      appendTo: leaf.id,
      expectedTextHash: await textHash(leaf.text),
      parentId: null,
      seamPathIndex,
      instruction: requestedInstruction.trim()
    };
  }
  return {
    mode: "take",
    appendTo: null,
    expectedTextHash: undefined,
    parentId: intent.parentId,
    seamPathIndex,
    instruction: intent.instruction
  };
}
