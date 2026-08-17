/** Persisted continuation prompt choices. Omission keeps the v0.8.0 layout. */
export const CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES = [
  "late-cache-stable"
] as const;

export type ContinuationPromptOptimizationV2 =
  (typeof CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES)[number];

export const CONTINUATION_PROMPT_LAYOUTS = [
  "compatibility",
  ...CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES
] as const;

export type ContinuationPromptLayout = (typeof CONTINUATION_PROMPT_LAYOUTS)[number];

/** Resolve the persisted optional choice at the one prompt boundary. */
export function continuationPromptLayoutForOptimization(
  optimization: ContinuationPromptOptimizationV2 | undefined
): ContinuationPromptLayout {
  return optimization ?? "compatibility";
}
