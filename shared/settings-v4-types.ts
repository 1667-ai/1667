import type {
  GenerationProfileV2,
  ModelCapabilitiesV3,
  ModelConnectionV2,
  ModelDefinitionV3,
  SettingsStateEnvelope,
  SettingsRoutingV2
} from "./settings-v2-types.js";
import {
  selectSettingsRoute,
  type SelectedSettingsRoute
} from "./settings-route.js";

/**
 * Settings schema 4 is the first schema that separates generation effort
 * from thinking mode. Schema 2 and schema 3 remain frozen. These types are
 * therefore kept in a separate module instead of widening the old contracts.
 */

export {
  FEATURE_SUPPORT_V2_VALUES,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  TEXT_PROMPT_FORMAT_V2_VALUES,
  isSubscriptionPresetV2,
  isSubscriptionProtocolV2,
  subscriptionPresetForProtocolV2,
  subscriptionProtocolForPresetV2
} from "./settings-v2-types.js";

export type {
  CredentialReferenceV2,
  CustomHeaderV2,
  ConnectionTimeoutsV2,
  FeatureSupportV2,
  ModelScalarMetadataV2,
  SamplingSettingsV2,
  SamplingPhraseBiasEntryV2,
  SettingsPresetV2,
  SettingsProtocolV2,
  TextPromptFormatV2
} from "./settings-v2-types.js";

export const GENERATION_EFFORT_V4_VALUES = [
  "default",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;
export type GenerationEffortV4 = (typeof GENERATION_EFFORT_V4_VALUES)[number];

export const THINKING_MODE_V4_VALUES = ["default", "on", "off"] as const;
export type ThinkingModeV4 = (typeof THINKING_MODE_V4_VALUES)[number];

/** Schema 4's model capability record is schema 3's record, unchanged. */
export type ModelCapabilitiesV4 = ModelCapabilitiesV3;

/** Schema 4's model definition is schema 3's definition, unchanged. */
export type ModelDefinitionV4 = ModelDefinitionV3;

/** A schema-4 profile carries both controls as required fields. */
export interface GenerationProfileV4 extends Omit<GenerationProfileV2, "effort"> {
  readonly effort: GenerationEffortV4;
  readonly thinkingMode: ThinkingModeV4;
}

export interface SettingsDocumentV4 {
  readonly schemaVersion: 4;
  readonly connections: Readonly<Record<string, ModelConnectionV2>>;
  readonly models: Readonly<Record<string, ModelDefinitionV4>>;
  readonly profiles: Readonly<Record<string, GenerationProfileV4>>;
  readonly routing: SettingsRoutingV2;
  readonly writing: {
    readonly defaultAuthorBrief: string;
  };
}

/** Schema 4 uses the same activation envelope as schema 2 and schema 3. The
 * shared generic keeps the frozen document aliases separate. */
export type SettingsStateV4 = SettingsStateEnvelope<4, SettingsDocumentV4>;

/** A route selected from a schema-4 document. */
export type SelectedSettingsRouteV4 = SelectedSettingsRoute<
  GenerationProfileV4,
  ModelDefinitionV4,
  ModelConnectionV2
>;

/** Resolve the route from a schema-4 document without projecting its profile
 * controls into a frozen schema-2 shape. */
export function selectSettingsRouteV4(
  document: SettingsDocumentV4,
  purpose: "default" | "prose" | "utility" = "default"
): SelectedSettingsRouteV4 {
  return selectSettingsRoute(document, purpose);
}
