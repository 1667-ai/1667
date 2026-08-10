import {
  REASONING_DISPLAY_V2_VALUES,
  type FeatureSupportV2,
  type ReasoningDisplayV2
} from "./settings-v2-types.js";
import type { SelectedSettingsRouteV2 } from "./settings-route.js";

/** Only a route whose capability is confirmed `"unsupported"` drops to `off`.
 *  This gate is deliberately looser than
 *  `generationEffortChoicesForTarget`'s `!== "supported"`, because the two
 *  capabilities carry different risk. Effort is a request field: sending it
 *  to a model that does not take it fails the generation, so an unproven
 *  model must refuse it. Reasoning content is a response field: whether an
 *  arbitrary OpenAI-compatible endpoint emits it cannot be known before the
 *  request, and a thought that never arrives renders nothing. Refusing on
 *  `"unknown"` would therefore disable this row on every discovered model. */
const REASONING_DISPLAY_OFF_ONLY: readonly ReasoningDisplayV2[] = ["off"];

export type ReasoningDisplayAvailability =
  | { readonly kind: "available" }
  | {
    readonly kind: "unavailable";
    readonly code: "model-no-reasoning";
    readonly reason: string;
  };

export interface ReasoningDisplayTarget {
  readonly reasoningContent: FeatureSupportV2;
  /** Only used to word `reasoningDisplayAvailabilityForTarget`'s reason. */
  readonly modelName: string;
  readonly connectionName: string;
}

/** Return only display values one runtime target can actually populate. */
export function reasoningDisplayChoicesForTarget(
  target: Pick<ReasoningDisplayTarget, "reasoningContent">
): readonly ReasoningDisplayV2[] {
  if (target.reasoningContent === "unsupported") return REASONING_DISPLAY_OFF_ONLY;
  return REASONING_DISPLAY_V2_VALUES;
}

/** Explain why one route cannot show a thought at the requested display
 *  value. */
export function reasoningDisplayAvailabilityForTarget(
  target: ReasoningDisplayTarget,
  display: ReasoningDisplayV2
): ReasoningDisplayAvailability {
  if (reasoningDisplayChoicesForTarget(target).includes(display)) {
    return { kind: "available" };
  }
  return {
    kind: "unavailable",
    code: "model-no-reasoning",
    reason: `${target.modelName} @ ${target.connectionName.toLowerCase()} returns none`
  };
}

/** Return only display values the exact profile route can populate. */
export function reasoningDisplayChoicesForRoute(
  route: SelectedSettingsRouteV2
): readonly ReasoningDisplayV2[] {
  return reasoningDisplayChoicesForTarget({
    reasoningContent: route.model.capabilities.reasoningContent ?? "unknown"
  });
}

/** Explain why the exact profile route cannot show a thought at the
 *  requested display value. */
export function reasoningDisplayAvailabilityForRoute(
  route: SelectedSettingsRouteV2,
  display: ReasoningDisplayV2
): ReasoningDisplayAvailability {
  return reasoningDisplayAvailabilityForTarget({
    reasoningContent: route.model.capabilities.reasoningContent ?? "unknown",
    modelName: route.model.name,
    connectionName: route.connection.name
  }, display);
}
