import {
  type GenerationProfileV5,
  type ModelDefinitionV5,
  type SettingsDocumentV5
} from "../shared/settings-v5-types.js";
import type { ModelConnectionV2 } from "../shared/settings-v2-types.js";
import {
  CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES
} from "../shared/continuation-prompt-optimization.js";
import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  REASONING_DISPLAY_V2_VALUES
} from "../shared/settings-v2-types.js";
import { MAX_ALTERNATIVE_TOKENS } from "../shared/token-probabilities.js";
import {
  parseConnections,
  type SettingsValidationOptions
} from "./settings-v2-validation.js";
import { parseModelsV3 } from "./settings-v3-validation.js";
import { parseSampling } from "./settings-v2-sampling-validation.js";
import { settingsMap } from "./settings-v2-validation-record.js";
import { oneOf } from "./settings-v2-validation-values.js";
import { parseGenerationReasoningV5 } from "./settings-v5-reasoning-validation.js";
import { parseWritingPromptSettings } from "./settings-v5-writing-validation.js";
import {
  effectiveReasoningContent,
  reasoningDisplayChoicesForTarget
} from "../shared/reasoning-display-capabilities.js";
import {
  MAX_SETTINGS_CREDENTIAL_NAMES,
  MAX_SETTINGS_NAME_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT,
  SettingsFormatError,
  requireBoundedSettingsString,
  requirePositiveSettingsInteger,
  requireSettingsId
} from "./settings-v2-scalars.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

export type { SettingsValidationOptions };

const DOCUMENT = closedShape(["schemaVersion", "connections", "models", "profiles", "routing", "writing"]);
const PROFILE = closedShape(
  ["name", "modelId", "temperature", "maxOutputTokens", "generationReasoning", "cachePolicy"],
  ["sampling", "tokenProbabilities", "reasoning", "discardReasoning", "continuationPromptOptimization"]
);

/** Parse one schema-5 document without projecting its profile controls. */
export function validateSettingsDocumentV5(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV5 {
  const root = closedRecord(value, "settings document", DOCUMENT);
  literal(root.schemaVersion, 5, "settings document.schemaVersion");
  const credentialNames = new Set<string>();
  const caseInsensitive = options.environmentCaseInsensitive ?? process.platform === "win32";
  const connections = parseConnections(root.connections, credentialNames, caseInsensitive);
  const models = parseModelsV3(root.models, connections);
  const profiles = parseProfilesV5(root.profiles, models, connections);
  const routing = parseRoutingV5(root.routing, profiles);
  const writing = parseWritingPromptSettings(root.writing);
  if (credentialNames.size > MAX_SETTINGS_CREDENTIAL_NAMES) {
    throw new SettingsFormatError(
      `settings document exceeds the ${MAX_SETTINGS_CREDENTIAL_NAMES}-credential-name limit`
    );
  }
  return {
    schemaVersion: 5,
    connections,
    models,
    profiles,
    routing,
    writing
  };
}

export function parseProfilesV5(
  value: unknown,
  models: Readonly<Record<string, ModelDefinitionV5>>,
  connections: Readonly<Record<string, ModelConnectionV2>>
): Record<string, GenerationProfileV5> {
  const record = settingsMap(value, "settings document.profiles");
  const result: Record<string, GenerationProfileV5> = {};
  for (const [id, raw] of Object.entries(record)) {
    requireSettingsId(id, "profile ID");
    result[id] = parseProfileV5(id, raw, models, connections);
  }
  return result;
}

export function parseProfileV5(
  id: string,
  raw: unknown,
  models: Readonly<Record<string, ModelDefinitionV5>>,
  connections: Readonly<Record<string, ModelConnectionV2>>
): GenerationProfileV5 {
  const profile = closedRecord(raw, `profile ${id}`, PROFILE);
  const modelId = requireSettingsId(profile.modelId, `profile ${id}.modelId`);
  const model = models[modelId];
  if (!Object.hasOwn(models, modelId) || model === undefined) {
    throw new SettingsFormatError(`profile ${id}.modelId does not resolve`);
  }
  const connection = connections[model.connectionId];
  if (!Object.hasOwn(connections, model.connectionId) || connection === undefined) {
    throw new SettingsFormatError(`model ${modelId}.connectionId does not resolve`);
  }
  const temperature = requireFiniteNumberOrNull(profile.temperature, `profile ${id}.temperature`);
  if (temperature !== null && model.capabilities.temperature === "unsupported") {
    throw new SettingsFormatError(`profile ${id} sets temperature for an unsupported model`);
  }
  const generationReasoning = parseGenerationReasoningV5(
    profile.generationReasoning,
    `profile ${id}.generationReasoning`
  );
  const sampling = parseSampling(profile.sampling, `profile ${id}.sampling`);
  const tokenProbabilities = profile.tokenProbabilities === undefined
    ? undefined
    : requirePositiveSettingsInteger(
      profile.tokenProbabilities,
      `profile ${id}.tokenProbabilities`,
      MAX_ALTERNATIVE_TOKENS
    );
  const reasoning = profile.reasoning === undefined
    ? undefined
    : oneOf(profile.reasoning, REASONING_DISPLAY_V2_VALUES, `profile ${id}.reasoning`);
  if (
    reasoning !== undefined
    && !reasoningDisplayChoicesForTarget({
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
  return {
    name: requireBoundedSettingsString(profile.name, `profile ${id}.name`, MAX_SETTINGS_NAME_SCALARS, 1),
    modelId,
    temperature,
    maxOutputTokens: requirePositiveSettingsInteger(
      profile.maxOutputTokens,
      `profile ${id}.maxOutputTokens`,
      MAX_SETTINGS_TOKEN_COUNT
    ),
    generationReasoning,
    cachePolicy: oneOf(profile.cachePolicy, PROMPT_CACHE_POLICY_V2_VALUES, `profile ${id}.cachePolicy`),
    ...(sampling === undefined ? {} : { sampling }),
    ...(tokenProbabilities === undefined ? {} : { tokenProbabilities }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(discardReasoning === undefined ? {} : { discardReasoning }),
    ...(continuationPromptOptimization === undefined ? {} : { continuationPromptOptimization })
  };
}

function parseRoutingV5(
  value: unknown,
  profiles: Readonly<Record<string, GenerationProfileV5>>
): SettingsDocumentV5["routing"] {
  const routing = closedRecord(value, "settings document.routing", closedShape(["default"], ["prose", "utility"]));
  const result: { default: string; prose?: string; utility?: string } = {
    default: requireSettingsId(routing.default, "settings document.routing.default")
  };
  if (!Object.hasOwn(profiles, result.default)) {
    throw new SettingsFormatError("settings document.routing.default does not resolve");
  }
  for (const purpose of ["prose", "utility"] as const) {
    const valueForPurpose = routing[purpose];
    if (valueForPurpose === undefined) continue;
    const profileId = requireSettingsId(valueForPurpose, `settings document.routing.${purpose}`);
    if (!Object.hasOwn(profiles, profileId)) {
      throw new SettingsFormatError(`settings document.routing.${purpose} does not resolve`);
    }
    result[purpose] = profileId;
  }
  return result;
}

function requireFiniteNumberOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -100 || value > 100) {
    throw new SettingsFormatError(`${label} must be null or a finite number from -100 to 100`);
  }
  return value;
}
