import {
  REASONING_DISPLAY_V2_VALUES,
  SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES,
  SETTINGS_SUBSCRIPTION_PROTOCOL_V2_VALUES,
  type ModelDiscoveryResultV2,
  type ModelDiscoverySourceV2,
  type ReasoningDisplayV2,
  type SettingsActivationOutcomeV2,
  type SettingsDocumentV2,
  type SettingsMutationResult,
  type SettingsView,
  type SubscriptionAuthState,
  type SubscriptionAuthStatus,
  type SubscriptionProtocolV2
} from "./settings-v2-types.js";
import { CONTINUATION_PROMPT_LAYOUTS } from "./continuation-prompt-optimization.js";
import type { GenerationSettings, Provider } from "./types.js";

export type SettingsDocumentResponseDecoder = (value: unknown) => SettingsDocumentV2;

export function decodeGenerationSettingsResponse(value: unknown): GenerationSettings {
  const settings = closedRecord(value, "generation settings", [
    "provider", "baseUrl", "model", "apiKeyEnv", "temperature",
    "maxTokens", "systemPrompt", "contextWindow"
  ], ["protocol"]);
  const protocol = optionalSubscriptionProtocol(settings.protocol);
  return {
    provider: providerValue(settings.provider, "generation settings.provider"),
    baseUrl: stringValue(settings.baseUrl, "generation settings.baseUrl"),
    model: stringValue(settings.model, "generation settings.model"),
    apiKeyEnv: nullableString(settings.apiKeyEnv, "generation settings.apiKeyEnv"),
    ...(protocol === undefined ? {} : { protocol }),
    temperature: nullableFiniteNumber(settings.temperature, "generation settings.temperature"),
    maxTokens: positiveSafeInteger(settings.maxTokens, "generation settings.maxTokens"),
    systemPrompt: stringValue(settings.systemPrompt, "generation settings.systemPrompt"),
    contextWindow: nullablePositiveSafeInteger(
      settings.contextWindow,
      "generation settings.contextWindow"
    )
  };
}

function optionalSubscriptionProtocol(value: unknown): SubscriptionProtocolV2 | undefined {
  if (value === undefined) return undefined;
  return oneOf(value, SETTINGS_SUBSCRIPTION_PROTOCOL_V2_VALUES, "generation settings.protocol");
}

export function decodeSettingsViewResponse(
  value: unknown,
  decodeDocument: SettingsDocumentResponseDecoder
): SettingsView {
  const response = closedRecord(value, "settings view", [
    "dataFormat", "editable", "stateGeneration", "activeRevision",
    "pendingRevision", "document", "effective", "effectiveProse", "lastActivationOutcome"
  ], [
    "effectiveProseReasoning", "effectiveProseContinuationPromptLayout",
    "subscriptionAuth"
  ]);
  const effective = decodeGenerationSettingsResponse(response.effective);
  const effectiveProse = decodeGenerationSettingsResponse(response.effectiveProse);
  const effectiveProseReasoning = Object.hasOwn(response, "effectiveProseReasoning")
    ? reasoningDisplayValue(response.effectiveProseReasoning, "settings view.effectiveProseReasoning")
    : undefined;
  const effectiveProseContinuationPromptLayout = Object.hasOwn(
    response,
    "effectiveProseContinuationPromptLayout"
  )
    ? oneOf(
      response.effectiveProseContinuationPromptLayout,
      CONTINUATION_PROMPT_LAYOUTS,
      "settings view.effectiveProseContinuationPromptLayout"
    )
    : undefined;
  const subscriptionAuth = Object.hasOwn(response, "subscriptionAuth")
    ? decodeSubscriptionAuth(response.subscriptionAuth)
    : undefined;
  if (response.dataFormat === 1) {
    if (response.editable !== false || response.stateGeneration !== null
      || response.activeRevision !== null || response.pendingRevision !== null
      || response.document !== null || response.lastActivationOutcome !== null) {
      invalid("format-1 settings view");
    }
    return {
      dataFormat: 1,
      editable: false,
      stateGeneration: null,
      activeRevision: null,
      pendingRevision: null,
      document: null,
      effective,
      effectiveProse,
      effectiveProseReasoning,
      effectiveProseContinuationPromptLayout,
      ...(subscriptionAuth === undefined ? {} : { subscriptionAuth }),
      lastActivationOutcome: null
    };
  }
  if (response.dataFormat !== 2 || response.editable !== true) invalid("settings view format");
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: positiveSafeInteger(response.stateGeneration, "settings view.stateGeneration"),
    activeRevision: positiveSafeInteger(response.activeRevision, "settings view.activeRevision"),
    pendingRevision: nullablePositiveSafeInteger(
      response.pendingRevision,
      "settings view.pendingRevision"
    ),
    document: decodeDocument(response.document),
    effective,
    effectiveProse,
    effectiveProseReasoning,
    effectiveProseContinuationPromptLayout,
    ...(subscriptionAuth === undefined ? {} : { subscriptionAuth }),
    lastActivationOutcome: response.lastActivationOutcome === null
      ? null
      : decodeActivationOutcome(response.lastActivationOutcome)
  };
}

function decodeSubscriptionAuth(value: unknown): SubscriptionAuthState {
  const auth = closedRecord(value, "settings subscription auth", ["chatgpt", "claude"]);
  return {
    chatgpt: subscriptionAuthStatus(auth.chatgpt, "settings subscription auth.chatgpt"),
    claude: subscriptionAuthStatus(auth.claude, "settings subscription auth.claude")
  };
}

function subscriptionAuthStatus(value: unknown, label: string): SubscriptionAuthStatus {
  return oneOf(value, ["signed-in", "signed-out"] as const, label);
}

function reasoningDisplayValue(value: unknown, label: string): ReasoningDisplayV2 {
  return oneOf(value, REASONING_DISPLAY_V2_VALUES, label);
}

function decodeActivationOutcome(value: unknown): SettingsActivationOutcomeV2 {
  const outcome = closedRecord(value, "settings activation outcome", [
    "transactionId", "candidateRevision", "result", "errorCode", "atStateGeneration"
  ]);
  const common = {
    transactionId: stringValue(outcome.transactionId, "settings activation outcome.transactionId"),
    candidateRevision: positiveSafeInteger(
      outcome.candidateRevision,
      "settings activation outcome.candidateRevision"
    ),
    atStateGeneration: positiveSafeInteger(
      outcome.atStateGeneration,
      "settings activation outcome.atStateGeneration"
    )
  };
  if (outcome.result === "committed") {
    if (outcome.errorCode !== null) invalid("settings activation outcome.errorCode");
    return { ...common, result: "committed", errorCode: null };
  }
  if (outcome.result !== "validation-failed" && outcome.result !== "rolled-back") {
    invalid("settings activation outcome.result");
  }
  return {
    ...common,
    result: outcome.result,
    errorCode: oneOf(
      outcome.errorCode,
      SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES,
      "settings activation outcome.errorCode"
    )
  };
}

export function decodeSettingsMutationResult(value: unknown): SettingsMutationResult {
  const response = closedRecord(value, "settings mutation result", [
    "kind", "settingsStateGeneration", "activeSettingsRevision", "pendingSettingsRevision",
    "activationOutcome"
  ]);
  if (response.kind !== "settings") invalid("settings mutation result.kind");
  return {
    kind: "settings",
    settingsStateGeneration: positiveSafeInteger(
      response.settingsStateGeneration,
      "settings mutation result.settingsStateGeneration"
    ),
    activeSettingsRevision: positiveSafeInteger(
      response.activeSettingsRevision,
      "settings mutation result.activeSettingsRevision"
    ),
    pendingSettingsRevision: nullablePositiveSafeInteger(
      response.pendingSettingsRevision,
      "settings mutation result.pendingSettingsRevision"
    ),
    activationOutcome: response.activationOutcome === null
      ? null
      : decodeActivationOutcome(response.activationOutcome)
  };
}

export function decodeModelDiscoveryResult(value: unknown): ModelDiscoveryResultV2 {
  const response = closedRecord(value, "model discovery result", ["observedAt", "models"]);
  const observedAt = stringValue(response.observedAt, "model discovery result.observedAt");
  if (!isCanonicalDate(observedAt) || !Array.isArray(response.models)
    || response.models.length > 256) {
    invalid("model discovery result");
  }
  return {
    observedAt,
    models: response.models.map((value, index) => {
      const model = closedRecord(value, `model discovery result.models[${index}]`, [
        "remoteId", "name", "contextWindow", "maxOutputTokens", "source"
      ]);
      return {
        remoteId: stringValue(model.remoteId, `model discovery result.models[${index}].remoteId`),
        name: stringValue(model.name, `model discovery result.models[${index}].name`),
        contextWindow: nullablePositiveSafeInteger(
          model.contextWindow,
          `model discovery result.models[${index}].contextWindow`
        ),
        maxOutputTokens: nullablePositiveSafeInteger(
          model.maxOutputTokens,
          `model discovery result.models[${index}].maxOutputTokens`
        ),
        source: discoverySource(
          model.source,
          `model discovery result.models[${index}].source`
        )
      };
    })
  };
}

/** `optional` fields may be present or absent without failing the closed-set
 *  check either way — unlike `fields`, which must all be present. Mirrors
 *  `closedShape`/`closedRecord` (server/story-wire-validation.ts), the
 *  server-side validator's own required/optional split for exactly this
 *  reason: additive fields (`effectiveProseReasoning` and
 *  `effectiveProseContinuationPromptLayout`) must stay decodable whether or
 *  not a given response — or a test fixture built from an older literal —
 *  happens to carry them. */
function closedRecord(
  value: unknown,
  label: string,
  fields: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...fields, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || fields.some((key) => !Object.hasOwn(record, key))) {
    invalid(label);
  }
  return record;
}

function providerValue(value: unknown, label: string): Provider {
  if (value !== "dry-run" && value !== "openai-compatible" && value !== "anthropic") invalid(label);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -100 || value > 100) invalid(label);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 1) invalid(label);
  return value as number;
}

function nullablePositiveSafeInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveSafeInteger(value, label);
}

function discoverySource(value: unknown, label: string): ModelDiscoverySourceV2 {
  if (value !== "anthropic-models" && value !== "openai-models"
    && value !== "lm-studio-models" && value !== "ollama-tags") invalid(label);
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    invalid(label);
  }
  return value as T[number];
}

function isCanonicalDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalid(label: string): never {
  throw new Error(`The server returned invalid ${label}.`);
}
