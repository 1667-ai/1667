import {
  CREDENTIAL_ENV_PATTERN_SOURCE,
  HASH256_PATTERN_SOURCE,
  HEADER_NAME_PATTERN_SOURCE,
  MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
  MAX_SETTINGS_HEADERS,
  MAX_SETTINGS_ID_SCALARS,
  MAX_SETTINGS_NAME_SCALARS,
  MAX_SETTINGS_RECORDS,
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_TIMEOUT_MS,
  MAX_SETTINGS_TOKEN_COUNT,
  MAX_SETTINGS_URL_SCALARS,
  SECRET_ID_PATTERN_SOURCE,
  SETTINGS_ID_PATTERN_SOURCE
} from "../server/settings-v2-scalars.js";
import {
  FM1_KEY_PATTERN_SOURCE,
  MUTATION_ID_PATTERN_SOURCE
} from "../server/mutation-ledger-scalars.js";
import { exactStringPatternSource } from "../server/story-wire-patterns.js";
import {
  FEATURE_SUPPORT_V2_VALUES,
  GENERATION_EFFORT_V2_VALUES,
  PROMPT_CACHE_POLICY_V2_VALUES,
  SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES,
  SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES,
  SETTINGS_ACTIVATION_STATE_V2_VALUES,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingScalarKnobV2
} from "../shared/settings-v2-types.js";
import {
  SAMPLING_DRY_BREAKERS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_SCALAR_DESCRIPTORS,
  SAMPLING_STOP_POLICY
} from "../shared/sampling-validation-policy.js";

type Schema = Record<string, unknown>;

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export function settingsV2Schema(): Schema {
  const definitions: Record<string, Schema> = {
    SettingsId: stringPattern(SETTINGS_ID_PATTERN_SOURCE, MAX_SETTINGS_ID_SCALARS),
    CredentialName: stringPattern(CREDENTIAL_ENV_PATTERN_SOURCE, 64),
    SecretId: stringPattern(SECRET_ID_PATTERN_SOURCE, MAX_SETTINGS_ID_SCALARS),
    HeaderName: stringPattern(HEADER_NAME_PATTERN_SOURCE, 128),
    Hash256: stringPattern(HASH256_PATTERN_SOURCE, 64),
    MutationId: stringPattern(MUTATION_ID_PATTERN_SOURCE),
    Fm1Key: stringPattern(FM1_KEY_PATTERN_SOURCE),
    PositiveSafeInteger: integer(1, SAFE_INTEGER),
    TokenCount: integer(1, MAX_SETTINGS_TOKEN_COUNT),
    Timeout: integer(1, MAX_SETTINGS_TIMEOUT_MS),
    AuthNone: closed({ type: { const: "none" } }),
    AuthBearer: closed({ type: { const: "bearer-env" }, env: ref("CredentialName") }),
    AuthHeader: closed({
      type: { const: "header-env" },
      name: ref("HeaderName"),
      env: ref("CredentialName")
    }),
    AuthBearerStored: closed({
      type: { const: "bearer-stored" },
      secretId: ref("SecretId")
    }),
    AuthHeaderStored: closed({
      type: { const: "header-stored" },
      name: ref("HeaderName"),
      secretId: ref("SecretId")
    }),
    Auth: {
      oneOf: [
        ref("AuthNone"),
        ref("AuthBearer"),
        ref("AuthHeader"),
        ref("AuthBearerStored"),
        ref("AuthHeaderStored")
      ]
    },
    HeaderValue: closed({ type: { const: "env" }, env: ref("CredentialName") }),
    Header: closed({ name: ref("HeaderName"), value: ref("HeaderValue") }),
    Timeouts: closed({
      responseHeaderMs: ref("Timeout"),
      firstTokenMs: ref("Timeout"),
      idleMs: ref("Timeout"),
      totalMs: ref("Timeout")
    }),
    Connection: closed({
      name: boundedString(MAX_SETTINGS_NAME_SCALARS, 1),
      preset: { enum: SETTINGS_PRESET_V2_VALUES },
      protocol: { enum: SETTINGS_PROTOCOL_V2_VALUES },
      baseUrl: { oneOf: [{ type: "null" }, boundedString(MAX_SETTINGS_URL_SCALARS, 1)] },
      auth: ref("Auth"),
      headers: { type: "array", maxItems: MAX_SETTINGS_HEADERS, items: ref("Header") },
      timeouts: ref("Timeouts"),
      allowInsecureHttp: { const: true }
    }, ["name", "preset", "protocol", "baseUrl", "auth", "headers", "timeouts"]),
    ScalarMetadata: closed({
      contextWindow: ref("TokenCount"),
      maxOutputTokens: ref("TokenCount")
    }, []),
    Capabilities: closed({
      temperature: support(),
      assistantPrefill: support(),
      reasoningEffort: support(),
      promptCaching: support()
    }),
    Model: closed({
      connectionId: ref("SettingsId"),
      remoteId: boundedString(MAX_SETTINGS_REMOTE_ID_SCALARS),
      name: boundedString(MAX_SETTINGS_NAME_SCALARS, 1),
      discovered: ref("ScalarMetadata"),
      overrides: ref("ScalarMetadata"),
      capabilities: ref("Capabilities")
    }),
    Profile: closed({
      name: boundedString(MAX_SETTINGS_NAME_SCALARS, 1),
      modelId: ref("SettingsId"),
      temperature: {
        oneOf: [{ type: "null" }, { type: "number", minimum: -100, maximum: 100 }]
      },
      maxOutputTokens: ref("TokenCount"),
      effort: { enum: GENERATION_EFFORT_V2_VALUES },
      cachePolicy: { enum: PROMPT_CACHE_POLICY_V2_VALUES },
      sampling: ref("Sampling")
    }, ["name", "modelId", "temperature", "maxOutputTokens", "effort", "cachePolicy"]),
    Sampling: closed({
      ...Object.fromEntries(
        SAMPLING_SCALAR_KNOB_V2_VALUES.map((knob) => [knob, samplingScalar(knob)])
      ),
      stop: {
        type: "array",
        maxItems: SAMPLING_STOP_POLICY.maxSequences,
        uniqueItems: true,
        items: boundedString(SAMPLING_STOP_POLICY.maxScalars, 1)
      },
      logitBias: {
        type: "object",
        maxProperties: SAMPLING_LOGIT_BIAS_POLICY.maxEntries,
        propertyNames: {
          pattern: exactStringPatternSource(SAMPLING_LOGIT_BIAS_POLICY.keyPatternSource)
        },
        additionalProperties: integer(
          SAMPLING_LOGIT_BIAS_POLICY.minimum,
          SAMPLING_LOGIT_BIAS_POLICY.maximum
        )
      },
      dryBreakers: {
        type: "array",
        maxItems: SAMPLING_DRY_BREAKERS_POLICY.maxSequences,
        uniqueItems: true,
        items: boundedString(SAMPLING_DRY_BREAKERS_POLICY.maxScalars, 1)
      }
    }),
    Connections: settingsMap("Connection"),
    Models: settingsMap("Model"),
    Profiles: settingsMap("Profile"),
    Routing: closed({
      default: ref("SettingsId"),
      prose: ref("SettingsId"),
      utility: ref("SettingsId")
    }, ["default"]),
    Writing: closed({
      defaultAuthorBrief: boundedString(MAX_SETTINGS_AUTHOR_BRIEF_SCALARS, 1)
    }),
    Document: closed({
      schemaVersion: { const: 2 },
      connections: ref("Connections"),
      models: ref("Models"),
      profiles: ref("Profiles"),
      routing: ref("Routing"),
      writing: ref("Writing")
    }),
    UserTransactionPointer: closed({
      receiptKind: { const: "user" },
      mutationId: ref("MutationId"),
      phase: { const: "prepared" }
    }),
    MigrationTransactionPointer: closed({
      receiptKind: { const: "format-migration-v1" },
      key: ref("Fm1Key"),
      phase: { const: "prepared" }
    }),
    TransactionPointer: {
      oneOf: [ref("UserTransactionPointer"), ref("MigrationTransactionPointer")]
    },
    Activation: closed({
      transactionId: ref("MutationId"),
      oldHash: ref("Hash256"),
      candidateHash: ref("Hash256"),
      state: { enum: SETTINGS_ACTIVATION_STATE_V2_VALUES },
      attempt: { const: 1 }
    }),
    CommittedOutcome: closed({
      transactionId: ref("MutationId"),
      candidateRevision: ref("PositiveSafeInteger"),
      result: { const: "committed" },
      errorCode: { type: "null" },
      atStateGeneration: ref("PositiveSafeInteger")
    }),
    FailedOutcome: closed({
      transactionId: ref("MutationId"),
      candidateRevision: ref("PositiveSafeInteger"),
      result: {
        enum: SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES.filter((value) => value !== "committed")
      },
      errorCode: { enum: SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES },
      atStateGeneration: ref("PositiveSafeInteger")
    }),
    ActivationOutcome: { oneOf: [ref("CommittedOutcome"), ref("FailedOutcome")] },
    Documents: {
      type: "object",
      minProperties: 1,
      maxProperties: 2,
      propertyNames: { pattern: exactStringPatternSource("[1-9][0-9]{0,15}") },
      additionalProperties: ref("Document")
    },
    State: closed({
      schemaVersion: { const: 2 },
      stateGeneration: ref("PositiveSafeInteger"),
      settingsRevisionClock: ref("PositiveSafeInteger"),
      documents: ref("Documents"),
      activeRevision: ref("PositiveSafeInteger"),
      pendingRevision: nullable(ref("PositiveSafeInteger")),
      previousRevision: nullable(ref("PositiveSafeInteger")),
      activation: nullable(ref("Activation")),
      lastActivationOutcome: nullable(ref("ActivationOutcome")),
      lastTransaction: nullable(ref("TransactionPointer"))
    })
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://1667.invalid/schema/settings-v2-release-a.json",
    title: "1667 settings v2 document and aggregate state",
    oneOf: [ref("Document"), ref("State")],
    $defs: definitions
  };
}

function closed(
  properties: Record<string, Schema>,
  required: readonly string[] = Object.keys(properties)
): Schema {
  return { type: "object", additionalProperties: false, properties, required };
}

function settingsMap(valueRef: string): Schema {
  return {
    type: "object",
    minProperties: 1,
    maxProperties: MAX_SETTINGS_RECORDS,
    propertyNames: { $ref: "#/$defs/SettingsId" },
    additionalProperties: ref(valueRef)
  };
}

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function nullable(schema: Schema): Schema {
  return { oneOf: [{ type: "null" }, schema] };
}

function boundedString(maxLength: number, minLength = 0): Schema {
  return { type: "string", minLength, maxLength };
}

function integer(minimum: number, maximum: number): Schema {
  return { type: "integer", minimum, maximum };
}

function number(minimum: number, maximum: number): Schema {
  return { type: "number", minimum, maximum };
}

function samplingScalar(knob: SamplingScalarKnobV2): Schema {
  const descriptor = SAMPLING_SCALAR_DESCRIPTORS[knob];
  return nullable(
    descriptor.integer
      ? integer(descriptor.minimum, descriptor.maximum)
      : number(descriptor.minimum, descriptor.maximum)
  );
}

function stringPattern(source: string, maxLength?: number): Schema {
  return {
    type: "string",
    pattern: exactStringPatternSource(source),
    ...(maxLength === undefined ? {} : { maxLength })
  };
}

function support(): Schema {
  return { enum: FEATURE_SUPPORT_V2_VALUES };
}
