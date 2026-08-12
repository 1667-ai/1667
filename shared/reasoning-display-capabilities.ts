import {
  REASONING_DISPLAY_V2_VALUES,
  type FeatureSupportV2,
  type GenerationProfileV2,
  type ModelCapabilitiesV2,
  type ModelConnectionV2,
  type ReasoningDisplayV2,
  type SettingsDocumentV2
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

/** What one route can actually return, which is not always what the model
 *  alone says. A text protocol reports `reasoningContent: "unsupported"`
 *  because that wire format carries no reasoning field, but a connection with
 *  `splitThinkTags` on makes one: the split is precisely what turns a
 *  `<think>` block into a thought. The model capability stays honest about
 *  the protocol, and the connection setting overrides it here, at the only
 *  layer that can see both. */
export function effectiveReasoningContent(
  connection: Pick<ModelConnectionV2, "splitThinkTags">,
  capabilities: Pick<ModelCapabilitiesV2, "reasoningContent">
): FeatureSupportV2 {
  if (connection.splitThinkTags === true) return "supported";
  return capabilities.reasoningContent ?? "unknown";
}

function routeReasoningContent(route: SelectedSettingsRouteV2): FeatureSupportV2 {
  return effectiveReasoningContent(route.connection, route.model.capabilities);
}

/** Return only display values the exact profile route can populate. */
export function reasoningDisplayChoicesForRoute(
  route: SelectedSettingsRouteV2
): readonly ReasoningDisplayV2[] {
  return reasoningDisplayChoicesForTarget({
    reasoningContent: routeReasoningContent(route)
  });
}

/** Explain why the exact profile route cannot show a thought at the
 *  requested display value. */
export function reasoningDisplayAvailabilityForRoute(
  route: SelectedSettingsRouteV2,
  display: ReasoningDisplayV2
): ReasoningDisplayAvailability {
  return reasoningDisplayAvailabilityForTarget({
    reasoningContent: routeReasoningContent(route),
    modelName: route.model.name,
    connectionName: route.connection.name
  }, display);
}

/** Clear any profile's explicit reasoning display that its route can no
 *  longer populate. Turning the split off, or moving a connection to a
 *  protocol that cannot hold it, drops the effective capability back to the
 *  model's own, and a display the writer chose while the split was on would
 *  then be a document `parseProfiles` refuses, from a row that is no longer
 *  on screen to correct it. Absence is the safe landing: it means the default
 *  fold state, exactly as for a document saved before the field existed. */
export function withSupportedReasoningDisplays(
  document: SettingsDocumentV2
): SettingsDocumentV2 {
  let changed = false;
  const profiles: Record<string, GenerationProfileV2> = {};
  for (const [id, profile] of Object.entries(document.profiles)) {
    const model = document.models[profile.modelId];
    const connection = model === undefined
      ? undefined
      : document.connections[model.connectionId];
    if (
      profile.reasoning === undefined
      || model === undefined
      || connection === undefined
      || reasoningDisplayChoicesForTarget({
        reasoningContent: effectiveReasoningContent(connection, model.capabilities)
      }).includes(profile.reasoning)
    ) {
      profiles[id] = profile;
      continue;
    }
    const { reasoning: _unsupported, ...rest } = profile;
    profiles[id] = rest;
    changed = true;
  }
  return changed ? { ...document, profiles } : document;
}
