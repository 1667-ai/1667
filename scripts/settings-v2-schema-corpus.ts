import { canonicalJson } from "../server/canonical-json.js";
import { SAMPLING_LOGIT_BIAS_POLICY } from "../shared/sampling-validation-policy.js";
import {
  formatSettingsDocumentV2,
  formatSettingsStateV2
} from "../server/settings-v2-codec.js";
import {
  applyEffectiveGenerationSettings,
  convertGenerationSettingsV1
} from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_DOCUMENT_V2_TEXT,
  INITIAL_SETTINGS_STATE_V2,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import {
  reduceSettingsStateV2
} from "../server/settings-v2-reducer.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  EMPTY_SAMPLING_V2,
  type SamplingSettingsV2,
  type SettingsDocumentV2,
  type SettingsStateV2
} from "../shared/settings-v2-types.js";

export interface SettingsV2CorpusCase {
  readonly name: string;
  readonly kind: "document" | "state";
  readonly valid: boolean;
  readonly schemaValid: boolean;
  readonly text: string;
}

const MUTATION = `m1.1767225600000.${"d".repeat(32)}`;
const POINTER = { receiptKind: "user", mutationId: MUTATION, phase: "prepared" } as const;

export function settingsV2Corpus(): SettingsV2CorpusCase[] {
  const openAi = openAiSettings();
  const anthropic = { ...openAi, provider: "anthropic" as const, baseUrl: "https://api.anthropic.com" };
  const local = {
    ...openAi,
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    apiKeyEnv: null
  };
  const convertedOpenAi = convertGenerationSettingsV1(openAi);
  const convertedAnthropic = convertGenerationSettingsV1(anthropic);
  const convertedLocal = convertGenerationSettingsV1(local);
  // phraseBias/bannedStrings only validate as available for a model on the
  // closed tokenizer allow-list (shared/sampling-capabilities.ts); every
  // other corpus case keeps the plain "test-model" placeholder.
  const sampledOpenAi = withSampling(withKnownTokenizerModel(convertedOpenAi), {
    topP: 0.9,
    topK: null,
    minP: null,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    repeatPenalty: null,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1 },
    // Single words, chosen so every one of the four surface variants
    // (typed, leading-space, capitalized, leading-space-capitalized)
    // resolves to exactly one o200k_base token — a phrase that needs more
    // than one token in any variant is rejected at resolution, and this
    // fixture exercises the accepted path, not the rejected one.
    bannedStrings: ["spam"],
    phraseBias: [{ phrase: "wolf", weight: 4 }]
  });
  const emptySampling = withSampling(sampledOpenAi, EMPTY_SAMPLING_V2);
  const legacySamplingText = legacyShapedSamplingDocumentText(sampledOpenAi);
  const candidate = applyEffectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2, openAi);
  const staged = reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
    kind: "save-document",
    document: candidate,
    lastTransaction: POINTER
  });
  const validating = reduceSettingsStateV2(staged, { kind: "begin-validation", transactionId: MUTATION });
  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const committed = reduceSettingsStateV2(promoted, { kind: "commit" });
  const rollingBack = reduceSettingsStateV2(promoted, { kind: "begin-rollback" });
  const cleanCommitted = reduceSettingsStateV2(committed, { kind: "finish-commit" });
  const cleanRolledBack = reduceSettingsStateV2(rollingBack, {
    kind: "finish-rollback",
    errorCode: "readiness_failed"
  });
  const badRoute = {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    routing: { default: "missing" }
  };
  const unresolvedConstructorModel = withDefaultModelId("constructor");
  const unresolvedToStringModel = withDefaultModelId("toString");
  const networkConnection = convertedOpenAi.connections["migrated:connection"]!;
  const storedBearer = {
    ...convertedOpenAi,
    connections: {
      ...convertedOpenAi.connections,
      "migrated:connection": {
        ...networkConnection,
        auth: { type: "bearer-stored", secretId: "migrated:connection" }
      }
    }
  } satisfies SettingsDocumentV2;
  const storedHeader = {
    ...convertedOpenAi,
    connections: {
      ...convertedOpenAi.connections,
      "migrated:connection": {
        ...networkConnection,
        auth: {
          type: "header-stored",
          name: "x-api-key",
          secretId: "migrated:connection:x-api-key"
        }
      }
    }
  } satisfies SettingsDocumentV2;
  const reservedCredential = {
    ...convertedOpenAi,
    connections: {
      ...convertedOpenAi.connections,
      "migrated:connection": {
        ...networkConnection,
        auth: { type: "bearer-env", env: "PATH" }
      }
    }
  };
  const publicHttp = {
    ...convertedOpenAi,
    connections: {
      ...convertedOpenAi.connections,
      "migrated:connection": { ...networkConnection, baseUrl: "http://example.com", auth: { type: "none" } }
    }
  };
  const badRole = {
    ...staged,
    activeRevision: staged.pendingRevision
  };
  const badHash = {
    ...validating,
    activation: { ...validating.activation!, oldHash: "a".repeat(64) }
  };
  const newerProtocol = {
    ...convertedOpenAi,
    connections: {
      ...convertedOpenAi.connections,
      "migrated:connection": { ...networkConnection, protocol: "openai-responses" }
    }
  };
  return [
    validText("initial-document", "document", INITIAL_SETTINGS_DOCUMENT_V2_TEXT),
    validText("initial-state", "state", INITIAL_SETTINGS_STATE_V2_TEXT),
    valid("converted-openai", "document", convertedOpenAi),
    valid("document-with-sampling", "document", sampledOpenAi),
    validText("document-empty-sampling", "document", canonicalJson(emptySampling)),
    validText("document-sampling-legacy-fields-absent", "document", legacySamplingText),
    valid("converted-anthropic", "document", convertedAnthropic),
    valid("converted-loopback", "document", convertedLocal),
    valid("stored-bearer", "document", storedBearer),
    valid("stored-header", "document", storedHeader),
    valid("staged", "state", staged),
    valid("validating", "state", validating),
    valid("prepared", "state", prepared),
    valid("promoted", "state", promoted),
    valid("rolling-back", "state", rollingBack),
    valid("committed", "state", committed),
    valid("clean-committed", "state", cleanCommitted),
    valid("clean-rolled-back", "state", cleanRolledBack),
    invalidText(
      "document-noncanonical-order",
      "document",
      JSON.stringify(INITIAL_SETTINGS_DOCUMENT_V2),
      true
    ),
    invalidText(
      "document-duplicate-root-key",
      "document",
      INITIAL_SETTINGS_DOCUMENT_V2_TEXT.replace("{", '{"schemaVersion":2,'),
      true
    ),
    invalid("document-unknown-root-key", "document", {
      ...INITIAL_SETTINGS_DOCUMENT_V2,
      surprise: true
    }, false),
    invalid("document-newer-reserved-protocol", "document", newerProtocol, false),
    invalid("document-unresolved-default-route", "document", badRoute, true),
    invalid("document-unresolved-constructor-model", "document", unresolvedConstructorModel, true),
    invalid("document-unresolved-to-string-model", "document", unresolvedToStringModel, true),
    invalid("document-reserved-credential", "document", reservedCredential, true),
    invalid("document-public-plain-http", "document", publicHttp, true),
    invalid("document-invalid-stored-secret-id", "document", {
      ...storedBearer,
      connections: {
        ...storedBearer.connections,
        "migrated:connection": {
          ...storedBearer.connections["migrated:connection"]!,
          auth: { type: "bearer-stored", secretId: "not/portable" }
        }
      }
    }, false),
    invalid("document-sampling-out-of-bounds", "document", withSampling(sampledOpenAi, {
      ...sampledOpenAi.profiles.default!.sampling!,
      topP: 2
    }), false),
    invalid("document-sampling-logit-bias-limit", "document", withSampling(sampledOpenAi, {
      ...sampledOpenAi.profiles.default!.sampling!,
      logitBias: Object.fromEntries(
        Array.from({ length: SAMPLING_LOGIT_BIAS_POLICY.maxEntries + 1 }, (_, index) => [String(index), 1])
      )
    }), false),
    // The generated PhraseBiasEntry schema sets additionalProperties: false;
    // the codec has to agree (issue #282 review finding D), or a document
    // the schema rejects could still be accepted and silently lose "typo"
    // on the next round trip.
    invalid("document-sampling-phrase-bias-extra-key", "document", withRawSampling(sampledOpenAi, {
      ...sampledOpenAi.profiles.default!.sampling!,
      phraseBias: [{ phrase: "raven", weight: 4, typo: true }]
    }), false),
    invalid("document-nfd-string", "document", {
      ...INITIAL_SETTINGS_DOCUMENT_V2,
      writing: { defaultAuthorBrief: "Cafe\u0301" }
    }, true),
    invalid("state-invalid-role-matrix", "state", badRole, true),
    invalid("state-activation-hash-mismatch", "state", badHash, true),
    invalid("state-unknown-root-key", "state", { ...staged, surprise: true }, false),
    invalid("state-started-pointer", "state", {
      ...staged,
      lastTransaction: { ...POINTER, phase: "started" }
    }, false)
  ];
}

function withDefaultModelId(modelId: string): SettingsDocumentV2 {
  const defaultProfile = INITIAL_SETTINGS_DOCUMENT_V2.profiles.default;
  if (defaultProfile === undefined) {
    throw new Error("Canonical initial settings are missing the default profile");
  }
  return {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    profiles: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.profiles,
      default: {
        ...defaultProfile,
        modelId
      }
    }
  };
}

/** Simulates a document saved before issue #282 added phraseBias and
 * bannedStrings: same document, but with those two keys stripped out of
 * `sampling` before serialization. Proves the schema and the codec still
 * accept the exact shape a pre-existing document has on disk. */
function legacyShapedSamplingDocumentText(document: SettingsDocumentV2): string {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  if (profile === undefined || profile.sampling === undefined) {
    throw new Error("Canonical settings are missing sampling on the default profile");
  }
  const { phraseBias: _phraseBias, bannedStrings: _bannedStrings, ...legacySampling } = profile.sampling;
  return canonicalJson({
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: { ...profile, sampling: legacySampling }
    }
  });
}

function withKnownTokenizerModel(document: SettingsDocumentV2): SettingsDocumentV2 {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  const model = profile === undefined ? undefined : document.models[profile.modelId];
  if (profile === undefined || model === undefined) {
    throw new Error("Canonical settings are missing the default profile's model");
  }
  return {
    ...document,
    models: {
      ...document.models,
      [profile.modelId]: { ...model, remoteId: "gpt-4o" }
    }
  };
}

function withSampling(
  document: SettingsDocumentV2,
  sampling: SamplingSettingsV2
): SettingsDocumentV2 {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  if (profile === undefined) throw new Error("Canonical settings are missing the default profile");
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: { ...profile, sampling }
    }
  };
}

/** Same as withSampling, but for a deliberately malformed sampling shape a
 * corpus "invalid" case needs — e.g. an extra key the SamplingSettingsV2
 * type itself would reject at compile time. */
function withRawSampling(document: SettingsDocumentV2, sampling: unknown): unknown {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  if (profile === undefined) throw new Error("Canonical settings are missing the default profile");
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: { ...profile, sampling }
    }
  };
}

function openAiSettings(): GenerationSettings {
  return {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "test-model",
    apiKeyEnv: "OPENAI_API_KEY",
    temperature: 0.7,
    maxTokens: 2_048,
    systemPrompt: "Continue in the established voice.",
    contextWindow: 32_768
  };
}

function valid(
  name: string,
  kind: SettingsV2CorpusCase["kind"],
  value: SettingsDocumentV2 | SettingsStateV2
): SettingsV2CorpusCase {
  const text = kind === "document"
    ? formatSettingsDocumentV2(value as SettingsDocumentV2)
    : formatSettingsStateV2(value as SettingsStateV2);
  return validText(name, kind, text);
}

function validText(
  name: string,
  kind: SettingsV2CorpusCase["kind"],
  text: string
): SettingsV2CorpusCase {
  return { name, kind, valid: true, schemaValid: true, text };
}

function invalid(
  name: string,
  kind: SettingsV2CorpusCase["kind"],
  value: unknown,
  schemaValid: boolean
): SettingsV2CorpusCase {
  return invalidText(name, kind, canonicalJson(value), schemaValid);
}

function invalidText(
  name: string,
  kind: SettingsV2CorpusCase["kind"],
  text: string,
  schemaValid: boolean
): SettingsV2CorpusCase {
  return { name, kind, valid: false, schemaValid, text };
}
