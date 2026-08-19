import {
  GENERATION_EFFORT_V2_VALUES,
  type FeatureSupportV2,
  type GenerationEffortV2,
  type SettingsProtocolV2
} from "./settings-v2-types.js";
import type { SelectedSettingsRouteV2 } from "./settings-route.js";

const DEFAULT_EFFORT: readonly GenerationEffortV2[] = ["default"];
const ANTHROPIC_EFFORTS: readonly GenerationEffortV2[] = ["default", "low", "medium", "high"];

export type GenerationEffortAvailability =
  | { readonly kind: "available" }
  | {
    readonly kind: "unavailable";
    readonly code: "model-unsupported" | "anthropic-off";
    readonly reason: string;
  };

export interface GenerationEffortTarget {
  readonly protocol: SettingsProtocolV2;
  readonly reasoningEffort: FeatureSupportV2;
}

/** Return only request values that one runtime target can lower safely. */
export function generationEffortChoicesForTarget(
  target: GenerationEffortTarget
): readonly GenerationEffortV2[] {
  if (target.reasoningEffort !== "supported") return DEFAULT_EFFORT;
  return target.protocol === "anthropic-messages"
    || target.protocol === "anthropic-subscription-messages"
    ? ANTHROPIC_EFFORTS
    : GENERATION_EFFORT_V2_VALUES;
}

/** Explain why one requested effort cannot reach one runtime target. */
export function generationEffortAvailabilityForTarget(
  target: GenerationEffortTarget,
  effort: GenerationEffortV2
): GenerationEffortAvailability {
  if (generationEffortChoicesForTarget(target).includes(effort)) {
    return { kind: "available" };
  }
  if (target.reasoningEffort !== "supported") {
    return {
      kind: "unavailable",
      code: "model-unsupported",
      reason: "model does not support reasoning effort"
    };
  }
  return {
    kind: "unavailable",
    code: "anthropic-off",
    reason: "Anthropic does not support generation effort set to off"
  };
}

/** Return only request values that the exact profile route can lower safely. */
export function generationEffortChoicesForRoute(
  route: SelectedSettingsRouteV2
): readonly GenerationEffortV2[] {
  return generationEffortChoicesForTarget({
    protocol: route.connection.protocol,
    reasoningEffort: route.model.capabilities.reasoningEffort
  });
}

/** Explain why one requested effort cannot reach the exact profile route. */
export function generationEffortAvailabilityForRoute(
  route: SelectedSettingsRouteV2,
  effort: GenerationEffortV2
): GenerationEffortAvailability {
  return generationEffortAvailabilityForTarget({
    protocol: route.connection.protocol,
    reasoningEffort: route.model.capabilities.reasoningEffort
  }, effort);
}
