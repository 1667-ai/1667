import type { ContinuationPromptOptimizationTransferCandidate } from "./continuation-prompt-optimization-profile-transfer.js";
import type { ModelScalarMetadataSourcesV2 } from "./model-scalar-resolution.js";
import type { SamplingBiasResolutionResult } from "./sampling-capabilities.js";
import type {
  GenerationEffortV2,
  PromptCachePolicyV2,
  SamplingSettingsV2,
  SettingsDocumentV2
} from "./settings-v2-types.js";

/** A protocol-neutral set of generation behavior that can move between routes. */
export interface ProfileTransferCandidate extends ContinuationPromptOptimizationTransferCandidate {
  readonly name: string;
  readonly temperature?: number | null;
  readonly maxOutputTokens?: number;
  readonly effort?: GenerationEffortV2;
  readonly cachePolicy?: PromptCachePolicyV2;
  /** Alternative tokens per generated token; null means off. */
  readonly tokenProbabilities?: number | null;
  readonly sampling?: Partial<SamplingSettingsV2>;
  /** Active source parameters that had no transferable candidate value. */
  readonly omittedCount?: number;
  readonly fidelity?: readonly string[];
}

export interface FittedProfileTransfer {
  readonly document: SettingsDocumentV2;
  readonly profileId: string;
  readonly importedCount: number;
  readonly candidateCount: number;
  readonly fidelity: readonly string[];
}

/** Optional model metadata supplied by an import path that owns it. */
export interface ProfileTransferFitOptions {
  readonly modelMetadata?: ModelScalarMetadataSourcesV2;
  /** A canonical resolution of the offered text-bias settings, when the caller owns it. */
  readonly samplingBiasResolution?: SamplingBiasResolutionResult;
}
