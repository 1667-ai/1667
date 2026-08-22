import { settingsV2Schema } from "./settings-v2-schema-definition.js";
import {
  GENERATION_EFFORT_V2_VALUES
} from "../shared/settings-v2-types.js";
import {
  GENERATION_EFFORT_V4_VALUES,
  THINKING_MODE_V4_VALUES
} from "../shared/settings-v4-types.js";
import { WRITING_PROMPT_FIELD_DEFINITIONS } from "../shared/settings-v5-writing.js";

type Schema = Record<string, unknown>;

/** Build the schema-5 structural contract from frozen schema 2. */
export function settingsV5Schema(): Schema {
  const base = settingsV2Schema();
  const defs = base.$defs as Record<string, Schema>;
  const profile = defs.Profile!;
  const profileProperties = { ...(profile.properties as Record<string, Schema>) };
  delete profileProperties.effort;
  defs.GenerationReasoningLegacy = closed({
    kind: { const: "legacy" },
    effort: { enum: [...GENERATION_EFFORT_V2_VALUES] }
  });
  defs.GenerationReasoningIndependent = closed({
    kind: { const: "independent" },
    effort: { enum: [...GENERATION_EFFORT_V4_VALUES] },
    thinkingMode: { enum: [...THINKING_MODE_V4_VALUES] }
  });
  defs.GenerationReasoningV5 = {
    oneOf: [
      { $ref: "#/$defs/GenerationReasoningLegacy" },
      { $ref: "#/$defs/GenerationReasoningIndependent" }
    ]
  };
  defs.ProfileV5 = {
    type: "object",
    additionalProperties: false,
    properties: {
      ...profileProperties,
      generationReasoning: { $ref: "#/$defs/GenerationReasoningV5" }
    },
    required: ["name", "modelId", "temperature", "maxOutputTokens", "generationReasoning", "cachePolicy"]
  };
  const writingProperties: Record<string, Schema> = {};
  for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
    writingProperties[definition.field] = boundedString(definition.maxScalars);
  }
  defs.WritingV5 = {
    type: "object",
    additionalProperties: false,
    properties: writingProperties,
    required: WRITING_PROMPT_FIELD_DEFINITIONS.map((definition) => definition.field)
  };
  defs.ModelsV5 = {
    type: "object",
    minProperties: 1,
    maxProperties: 64,
    propertyNames: { $ref: "#/$defs/SettingsId" },
    additionalProperties: { $ref: "#/$defs/ModelV3" }
  };
  defs.ProfilesV5 = {
    type: "object",
    minProperties: 1,
    maxProperties: 64,
    propertyNames: { $ref: "#/$defs/SettingsId" },
    additionalProperties: { $ref: "#/$defs/ProfileV5" }
  };
  defs.DocumentV5 = {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { const: 5 },
      connections: { $ref: "#/$defs/Connections" },
      models: { $ref: "#/$defs/ModelsV5" },
      profiles: { $ref: "#/$defs/ProfilesV5" },
      routing: { $ref: "#/$defs/Routing" },
      writing: { $ref: "#/$defs/WritingV5" }
    },
    required: ["schemaVersion", "connections", "models", "profiles", "routing", "writing"]
  };
  defs.DocumentsV5 = {
    type: "object",
    minProperties: 1,
    maxProperties: 2,
    propertyNames: { pattern: "^(?:[1-9][0-9]{0,15})(?![\\s\\S])" },
    additionalProperties: { $ref: "#/$defs/DocumentV5" }
  };
  defs.StateV5 = {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { const: 5 },
      stateGeneration: { $ref: "#/$defs/PositiveSafeInteger" },
      settingsRevisionClock: { $ref: "#/$defs/PositiveSafeInteger" },
      documents: { $ref: "#/$defs/DocumentsV5" },
      activeRevision: { $ref: "#/$defs/PositiveSafeInteger" },
      pendingRevision: { oneOf: [{ type: "null" }, { $ref: "#/$defs/PositiveSafeInteger" }] },
      previousRevision: { oneOf: [{ type: "null" }, { $ref: "#/$defs/PositiveSafeInteger" }] },
      activation: { oneOf: [{ type: "null" }, { $ref: "#/$defs/Activation" }] },
      lastActivationOutcome: { oneOf: [{ type: "null" }, { $ref: "#/$defs/ActivationOutcome" }] },
      lastTransaction: { oneOf: [{ type: "null" }, { $ref: "#/$defs/TransactionPointer" }] }
    },
    required: [
      "schemaVersion", "stateGeneration", "settingsRevisionClock", "documents", "activeRevision",
      "pendingRevision", "previousRevision", "activation", "lastActivationOutcome", "lastTransaction"
    ]
  };
  base.oneOf = [{ $ref: "#/$defs/DocumentV5" }, { $ref: "#/$defs/StateV5" }];
  base.$id = "https://1667.invalid/schema/settings-v5.json";
  base.title = "1667 settings v5 document and aggregate state";
  return base;
}

function closed(
  properties: Record<string, Schema>,
  required: readonly string[] = Object.keys(properties)
): Schema {
  return { type: "object", additionalProperties: false, properties, required };
}

function boundedString(maxLength: number, minLength = 0): Schema {
  return { type: "string", minLength, maxLength };
}
