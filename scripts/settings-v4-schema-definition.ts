import { settingsV2Schema } from "./settings-v2-schema-definition.js";
import {
  GENERATION_EFFORT_V4_VALUES,
  THINKING_MODE_V4_VALUES
} from "../shared/settings-v4-types.js";

type Schema = Record<string, unknown>;

/** Build the predecessor's schema-4 structural contract from frozen schema 2. */
export function settingsV4Schema(): Schema {
  const base = settingsV2Schema();
  const defs = base.$defs as Record<string, Schema>;
  const profile = defs.Profile!;
  const profileProperties = profile.properties as Record<string, Schema>;
  defs.ProfileV4 = {
    type: "object",
    additionalProperties: false,
    properties: {
      ...profileProperties,
      effort: { enum: GENERATION_EFFORT_V4_VALUES },
      thinkingMode: { enum: THINKING_MODE_V4_VALUES }
    },
    required: ["name", "modelId", "temperature", "maxOutputTokens", "effort", "cachePolicy", "thinkingMode"]
  };
  defs.ModelsV4 = {
    type: "object",
    minProperties: 1,
    maxProperties: 64,
    propertyNames: { $ref: "#/$defs/SettingsId" },
    additionalProperties: { $ref: "#/$defs/ModelV3" }
  };
  defs.ProfilesV4 = {
    type: "object",
    minProperties: 1,
    maxProperties: 64,
    propertyNames: { $ref: "#/$defs/SettingsId" },
    additionalProperties: { $ref: "#/$defs/ProfileV4" }
  };
  defs.DocumentV4 = {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { const: 4 },
      connections: { $ref: "#/$defs/Connections" },
      models: { $ref: "#/$defs/ModelsV4" },
      profiles: { $ref: "#/$defs/ProfilesV4" },
      routing: { $ref: "#/$defs/Routing" },
      writing: { $ref: "#/$defs/Writing" }
    },
    required: ["schemaVersion", "connections", "models", "profiles", "routing", "writing"]
  };
  defs.DocumentsV4 = {
    type: "object",
    minProperties: 1,
    maxProperties: 2,
    propertyNames: { pattern: "^(?:[1-9][0-9]{0,15})(?![\\s\\S])" },
    additionalProperties: { $ref: "#/$defs/DocumentV4" }
  };
  defs.StateV4 = {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { const: 4 },
      stateGeneration: { $ref: "#/$defs/PositiveSafeInteger" },
      settingsRevisionClock: { $ref: "#/$defs/PositiveSafeInteger" },
      documents: { $ref: "#/$defs/DocumentsV4" },
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
  const oneOf = base.oneOf as Array<Record<string, unknown>>;
  base.oneOf = [...oneOf, { $ref: "#/$defs/DocumentV4" }, { $ref: "#/$defs/StateV4" }];
  base.$id = "https://1667.invalid/schema/settings-v4-release-predecessor.json";
  base.title = "1667 settings v4 document and aggregate state";
  return base;
}
