import { CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES } from "../shared/continuation-prompt-optimization.js";
import { generationEffortAvailabilityForTarget } from "../shared/generation-effort-capabilities.js";
import {
  effectiveReasoningContent,
  reasoningDisplayChoicesForTarget
} from "../shared/reasoning-display-capabilities.js";
import {
  GENERATION_EFFORT_V2_VALUES,
  PROMPT_CACHE_POLICY_V2_VALUES,
  REASONING_DISPLAY_V2_VALUES,
  type GenerationProfileV2,
  type ModelConnectionV2,
  type ModelDefinitionV2
} from "../shared/settings-v2-types.js";
import { MAX_ALTERNATIVE_TOKENS } from "../shared/token-probabilities.js";
import { parseSampling, validateSamplingRoute } from "./settings-v2-sampling-validation.js";
import {
  MAX_SETTINGS_NAME_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT,
  SettingsFormatError,
  requireBoundedSettingsString,
  requireFiniteTemperature,
  requirePositiveSettingsInteger,
  requireSettingsId
} from "./settings-v2-scalars.js";
import { oneOf } from "./settings-v2-validation-values.js";
import { settingsMap } from "./settings-v2-validation-record.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

const PROFILE = closedShape(
  ["name", "modelId", "temperature", "maxOutputTokens", "effort", "cachePolicy"],
  ["sampling", "tokenProbabilities", "reasoning", "discardReasoning", "continuationPromptOptimization"]
);

/** Parse persisted profiles and reject values that the selected route cannot use. */
export function parseProfiles(
  value: unknown,
  models: Readonly<Record<string, ModelDefinitionV2>>,
  connections: Readonly<Record<string, ModelConnectionV2>>
): Record<string, GenerationProfileV2> {
  const record = settingsMap(value, "settings document.profiles");
  const result: Record<string, GenerationProfileV2> = {};
  for (const [id, raw] of Object.entries(record)) {
    requireSettingsId(id, "profile ID");
    const profile = closedRecord(raw, `profile ${id}`, PROFILE);
    const modelId = requireSettingsId(profile.modelId, `profile ${id}.modelId`);
    const model = models[modelId];
    if (!Object.hasOwn(models, modelId) || model === undefined) {
      throw new SettingsFormatError(`profile ${id}.modelId does not resolve`);
    }
    const connection = connections[model.connectionId];
    if (connection === undefined) {
      throw new SettingsFormatError(`model ${modelId}.connectionId does not resolve`);
    }
    const temperature = requireFiniteTemperature(profile.temperature, `profile ${id}.temperature`);
    const effort = oneOf(profile.effort, GENERATION_EFFORT_V2_VALUES, `profile ${id}.effort`);
    if (temperature !== null && model.capabilities.temperature === "unsupported") {
      throw new SettingsFormatError(`profile ${id} sets temperature for an unsupported model`);
    }
    const effortAvailability = generationEffortAvailabilityForTarget({
      protocol: connection.protocol,
      reasoningEffort: model.capabilities.reasoningEffort
    }, effort);
    if (effortAvailability.kind === "unavailable" && effortAvailability.code === "model-unsupported") {
      throw new SettingsFormatError(`profile ${id} sets effort without explicit model support`);
    }
    const sampling = parseSampling(profile.sampling, `profile ${id}.sampling`);
    // Absent means the request asks for no alternatives, the default for
    // every existing and new profile, so a document saved before this field
    // existed keeps meaning exactly what it did — same shape as `sampling`.
    const tokenProbabilities = profile.tokenProbabilities === undefined
      ? undefined
      : requirePositiveSettingsInteger(
        profile.tokenProbabilities,
        `profile ${id}.tokenProbabilities`,
        MAX_ALTERNATIVE_TOKENS
      );
    // Absent means "marker", the default fold state, so a document saved
    // before this field existed keeps meaning exactly what it did — same
    // shape as `sampling` and `tokenProbabilities` above. A present, explicit
    // value still has to be one this route can actually populate: `off` is
    // always fine, but `marker`/`open` is refused on a model that reports it
    // returns no reasoning content at all.
    const reasoning = profile.reasoning === undefined
      ? undefined
      : oneOf(profile.reasoning, REASONING_DISPLAY_V2_VALUES, `profile ${id}.reasoning`);
    if (
      reasoning !== undefined
      && !reasoningDisplayChoicesForTarget({
        // The connection's split is what makes a text route return reasoning
        // at all, so this has to read the same effective value the settings
        // UI offers from. Keying off the model alone would refuse a value the
        // writer was just given.
        reasoningContent: effectiveReasoningContent(connection, model.capabilities)
      }).includes(reasoning)
    ) {
      throw new SettingsFormatError(`profile ${id} sets reasoning on a model that returns none`);
    }
    const discardReasoning = profile.discardReasoning === undefined
      ? undefined
      : literal(profile.discardReasoning, true, `profile ${id}.discardReasoning`);
    const continuationPromptOptimization = profile.continuationPromptOptimization === undefined
      ? undefined
      : oneOf(
        profile.continuationPromptOptimization,
        CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES,
        `profile ${id}.continuationPromptOptimization`
      );
    const parsedProfile: GenerationProfileV2 = {
      name: requireBoundedSettingsString(profile.name, `profile ${id}.name`, MAX_SETTINGS_NAME_SCALARS, 1),
      modelId,
      temperature,
      maxOutputTokens: requirePositiveSettingsInteger(
        profile.maxOutputTokens,
        `profile ${id}.maxOutputTokens`,
        MAX_SETTINGS_TOKEN_COUNT
      ),
      effort,
      cachePolicy: oneOf(profile.cachePolicy, PROMPT_CACHE_POLICY_V2_VALUES, `profile ${id}.cachePolicy`),
      ...(sampling === undefined ? {} : { sampling }),
      ...(tokenProbabilities === undefined ? {} : { tokenProbabilities }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(discardReasoning === undefined ? {} : { discardReasoning }),
      ...(continuationPromptOptimization === undefined ? {} : { continuationPromptOptimization })
    };
    validateSamplingRoute(id, parsedProfile, model, connection);
    result[id] = parsedProfile;
  }
  return result;
}
