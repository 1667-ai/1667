import type { PromptTurn } from "./prompt-plan.js";
import {
  DEFAULT_CONTINUE_DIRECTION,
  type WritingPromptSettings
} from "./settings-v5-writing.js";

export { DEFAULT_CONTINUE_DIRECTION };

/** Normalize the configured direction at the request boundary. Settings may
 * contain editor whitespace, but prompt previews and provider requests must
 * use the same effective bytes. */
export function resolveDefaultContinueDirection(value: string): string {
  return value.trim() || DEFAULT_CONTINUE_DIRECTION;
}

/** Resolve the Continue request direction from writer input and active writing.
 *  A genuine append keeps its historical empty-request fallback and does not
 *  receive Default Continue direction. */
export function resolveContinueRequestDirection(
  requestedInstruction: string,
  writing: WritingPromptSettings,
  genuineAppend: boolean
): string {
  if (genuineAppend) return requestedInstruction.length === 0
    ? DEFAULT_CONTINUE_DIRECTION
    : requestedInstruction;
  if (requestedInstruction.length > 0) return requestedInstruction;
  return resolveDefaultContinueDirection(writing.defaultContinueDirection);
}

/** Optional guidance as its own system turn immediately before the fixed
 *  operation contract. Empty guidance adds no turn and no wrapper text. */
export function operationGuidanceTurns(guidance: string): PromptTurn[] {
  if (guidance.length === 0) return [];
  return [{
    role: "system",
    blocks: [{
      stability: "stable",
      kind: "operation-contract",
      text: guidance,
      boundaryAfter: "candidate"
    }]
  }];
}

/** Bind nonempty operation guidance into generation-intent context. Omit the
 *  member when empty so default settings keep the pre-schema-5 payload. */
export function operationGuidanceContext(
  guidance: string
): { readonly operationGuidance?: string } {
  return guidance.length === 0 ? {} : { operationGuidance: guidance };
}
