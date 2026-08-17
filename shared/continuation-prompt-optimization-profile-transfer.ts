import type { ContinuationPromptOptimizationV2 } from "./continuation-prompt-optimization.js";
import type { GenerationProfileV2 } from "./settings-v2-types.js";

/** The optional continuation-layout value carried by a profile transfer. */
export interface ContinuationPromptOptimizationTransferCandidate {
  /** Null explicitly clears the experimental opt-in. */
  readonly continuationPromptOptimization?: ContinuationPromptOptimizationV2 | null;
}

/** Apply the transfer value while preserving absence as the compatibility layout. */
export function applyContinuationPromptOptimizationTransfer(
  profile: GenerationProfileV2,
  optimization: ContinuationPromptOptimizationTransferCandidate["continuationPromptOptimization"]
): GenerationProfileV2 {
  if (optimization === undefined) return profile;
  if (optimization !== null) return { ...profile, continuationPromptOptimization: optimization };
  const { continuationPromptOptimization: _optimization, ...withoutOptimization } = profile;
  return withoutOptimization;
}
