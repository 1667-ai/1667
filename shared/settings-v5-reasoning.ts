import {
  GENERATION_EFFORT_V2_VALUES,
  type GenerationEffortV2
} from "./settings-v2-types.js";
import {
  GENERATION_EFFORT_V4_VALUES,
  THINKING_MODE_V4_VALUES,
  type GenerationEffortV4,
  type ThinkingModeV4
} from "./settings-v4-types.js";

export const GENERATION_REASONING_KIND_V5_VALUES = ["legacy", "independent"] as const;
export type GenerationReasoningKindV5 =
  (typeof GENERATION_REASONING_KIND_V5_VALUES)[number];

/** Persisted discriminator. Conversion never infers legacy vs independent
 *  from equal scalar values. */
export type GenerationReasoningV5 =
  | {
      readonly kind: "legacy";
      readonly effort: GenerationEffortV2;
    }
  | {
      readonly kind: "independent";
      readonly effort: GenerationEffortV4;
      readonly thinkingMode: ThinkingModeV4;
    };

export function isGenerationEffortV2(value: string): value is GenerationEffortV2 {
  return (GENERATION_EFFORT_V2_VALUES as readonly string[]).includes(value);
}

export function isGenerationEffortV4(value: string): value is GenerationEffortV4 {
  return (GENERATION_EFFORT_V4_VALUES as readonly string[]).includes(value);
}

export function isThinkingModeV4(value: string): value is ThinkingModeV4 {
  return (THINKING_MODE_V4_VALUES as readonly string[]).includes(value);
}

export function isGenerationReasoningV5(value: unknown): value is GenerationReasoningV5 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "legacy") {
    return typeof record.effort === "string"
      && isGenerationEffortV2(record.effort)
      && record.thinkingMode === undefined
      && Object.keys(record).length === 2;
  }
  if (record.kind === "independent") {
    return typeof record.effort === "string"
      && isGenerationEffortV4(record.effort)
      && typeof record.thinkingMode === "string"
      && isThinkingModeV4(record.thinkingMode)
      && Object.keys(record).length === 3;
  }
  return false;
}

export function legacyGenerationReasoningV5(
  effort: GenerationEffortV2
): Extract<GenerationReasoningV5, { kind: "legacy" }> {
  return { kind: "legacy", effort };
}

export function independentGenerationReasoningV5(
  effort: GenerationEffortV4,
  thinkingMode: ThinkingModeV4
): Extract<GenerationReasoningV5, { kind: "independent" }> {
  return { kind: "independent", effort, thinkingMode };
}
