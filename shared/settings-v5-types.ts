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
import type { GenerationReasoningV5 } from "./settings-v5-reasoning.js";
import type { WritingPromptSettings } from "./settings-v5-writing.js";

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

export {
  GENERATION_EFFORT_V4_VALUES,
  THINKING_MODE_V4_VALUES
} from "./settings-v4-types.js";
export type { GenerationEffortV4, ThinkingModeV4 } from "./settings-v4-types.js";

export {
  GENERATION_REASONING_KIND_V5_VALUES,
  independentGenerationReasoningV5,
  isGenerationReasoningV5,
  legacyGenerationReasoningV5
} from "./settings-v5-reasoning.js";
export type {
  GenerationReasoningKindV5,
  GenerationReasoningV5
} from "./settings-v5-reasoning.js";

export {
  DEFAULT_AUTHOR_BRIEF,
  DEFAULT_CONTINUE_DIRECTION,
  DEFAULT_WRITING_PROMPT_SETTINGS,
  WRITING_PROMPT_FIELD_DEFINITIONS,
  WRITING_PROMPT_FIELD_IDS,
  WRITING_PROMPT_ROW_IDS,
  isWritingPromptRow,
  writingPromptEmptyHelp,
  writingPromptFieldDefinition,
  writingPromptFieldDefinitionForRow,
  writingPromptRowHelp,
  writingPromptSettingsFromAuthorBrief
} from "./settings-v5-writing.js";
export type {
  WritingPromptEmptyBehavior,
  WritingPromptFieldDefinition,
  WritingPromptFieldId,
  WritingPromptRowId,
  WritingPromptSettings,
  WritingPromptViewVisibility
} from "./settings-v5-writing.js";

export {
  MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS,
  MAX_PROVIDER_PROBE_REQUEST_BYTES,
  MAX_PROVIDER_PROBE_SECRETS,
  MAX_SETTINGS_DOCUMENT_V5_BYTES,
  MAX_SETTINGS_SAVE_REQUEST_BYTES,
  MAX_SETTINGS_STATE_V5_BYTES,
  MAX_WRITING_OBJECT_BYTES,
  MAX_WRITING_PROMPT_SCALARS
} from "./settings-v5-limits.js";

/** Schema 5's model capability record is schema 3's record, unchanged. */
export type ModelCapabilitiesV5 = ModelCapabilitiesV3;

/** Schema 5's model definition is schema 3's definition, unchanged. */
export type ModelDefinitionV5 = ModelDefinitionV3;

/** A schema-5 profile stores a reasoning union instead of a bare effort. */
export interface GenerationProfileV5 extends Omit<GenerationProfileV2, "effort"> {
  readonly generationReasoning: GenerationReasoningV5;
}

export interface SettingsDocumentV5 {
  readonly schemaVersion: 5;
  readonly connections: Readonly<Record<string, ModelConnectionV2>>;
  readonly models: Readonly<Record<string, ModelDefinitionV5>>;
  readonly profiles: Readonly<Record<string, GenerationProfileV5>>;
  readonly routing: SettingsRoutingV2;
  readonly writing: WritingPromptSettings;
}

export type SettingsStateV5 = SettingsStateEnvelope<5, SettingsDocumentV5>;

export type SelectedSettingsRouteV5 = SelectedSettingsRoute<
  GenerationProfileV5,
  ModelDefinitionV5,
  ModelConnectionV2
>;

export function selectSettingsRouteV5(
  document: SettingsDocumentV5,
  purpose: "default" | "prose" | "utility" = "default"
): SelectedSettingsRouteV5 {
  return selectSettingsRoute(document, purpose);
}


