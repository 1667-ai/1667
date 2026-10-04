import type { PromptTokenCountAnswer } from "../../../shared/prompt-token-count-lane.js";
import type { NextRequestContext, NextRequestEstimate } from "../../../shared/request-projection.js";
import type { GenerationRuntimeState } from "../../../shared/runtime-settings.js";

/**
 * The next-request projection the composer's meter, the Facts rows, the
 * chapters table and the request viewer all read (#409 step 10f). It is
 * computed once per settled input, never per keystroke or per stream flush
 * (`context/actions.ts`), and kept here so every reader shares the one result.
 */

/** The generation settings the projection reads, from the server's settings
 * view, plus what a token count is taken against. */
export interface ContextRuntime {
  readonly runtime: GenerationRuntimeState;
  /** Identifies the route a token count was taken against. */
  readonly route: string;
}

export interface ProjectionSnapshot {
  readonly storyId: string;
  readonly estimate: NextRequestEstimate;
  /** What the request is: a Continue, or the retake of a part. */
  readonly operation: NextRequestContext["operation"];
  /** The model the request goes to. */
  readonly model: string;
  /** Likely response tokens that become context after this request. */
  readonly growthTokens: number;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number;
  /** Names the exact prompt and route; a token count is held against it. */
  readonly fingerprint: string;
}

export interface ContextState {
  readonly runtime: ContextRuntime | null;
  readonly projection: ProjectionSnapshot | null;
  /** The freshest token count; `identity` is a projection's `fingerprint`. */
  readonly count: PromptTokenCountAnswer<string> | null;
  /** The meter's breakdown is open. */
  readonly expanded: boolean;
}

export function initialContextState(): ContextState {
  return { runtime: null, projection: null, count: null, expanded: false };
}

/** The count that describes this projection, or `null` while there is none to trust. */
export function currentCount(
  state: Pick<ContextState, "count" | "projection">
): PromptTokenCountAnswer<string> | null {
  const { count, projection } = state;
  return count !== null && projection !== null && count.identity === projection.fingerprint ? count : null;
}
