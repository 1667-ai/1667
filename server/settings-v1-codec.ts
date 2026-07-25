import { createHash } from "node:crypto";
import type { GenerationSettings, Provider } from "../shared/types.js";
import {
  canonicalJson,
  decodeCanonicalUtf8,
  encodeUtf8Strict
} from "./canonical-json.js";
import {
  CREDENTIAL_ENV_PATTERN,
  MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT,
  MAX_SETTINGS_URL_SCALARS,
  SettingsFormatError,
  requireBoundedSettingsString,
  requireFiniteTemperature,
  requirePositiveSettingsInteger
} from "./settings-v2-scalars.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";

const V1 = closedShape([
  "provider", "baseUrl", "model", "apiKeyEnv", "temperature", "maxTokens", "systemPrompt", "contextWindow"
]);
const PROVIDERS = ["dry-run", "openai-compatible", "anthropic"] as const;

export const ABSENT_SETTINGS_V1_TEXT = "{\"apiKeyEnv\":null,\"baseUrl\":\"\",\"contextWindow\":null,\"maxTokens\":1024,\"model\":\"\",\"provider\":\"dry-run\",\"systemPrompt\":\"You are a skilled fiction writer collaborating on a story. Continue the story according to the user's instruction. Write vivid, concrete prose in a consistent voice. Stay in the fiction: no summaries, no meta commentary, no questions to the reader. Write roughly 200-400 words per continuation unless the instruction asks otherwise, and end at a natural beat rather than a cliffhanger cut mid-sentence.\",\"temperature\":0.9}";
export const ABSENT_SETTINGS_V1_HASH =
  "338c84ff15a6b5fb6566d339dcf611c3a420f1d817889277d0701aa56427c611" as const;

export function parseGenerationSettingsV1(value: unknown): GenerationSettings {
  try {
    const raw = closedRecord(value, "generation settings v1", V1);
    const provider = oneOf(raw.provider, PROVIDERS, "generation settings v1.provider");
    const apiKeyEnv = raw.apiKeyEnv === null
      ? null
      : requireLegacyCredentialName(raw.apiKeyEnv, "generation settings v1.apiKeyEnv");
    const contextWindow = raw.contextWindow === null
      ? null
      : requirePositiveSettingsInteger(
          raw.contextWindow,
          "generation settings v1.contextWindow",
          MAX_SETTINGS_TOKEN_COUNT
        );
    return {
      provider,
      baseUrl: requireBoundedSettingsString(
        raw.baseUrl,
        "generation settings v1.baseUrl",
        MAX_SETTINGS_URL_SCALARS
      ),
      model: requireBoundedSettingsString(
        raw.model,
        "generation settings v1.model",
        MAX_SETTINGS_REMOTE_ID_SCALARS
      ),
      apiKeyEnv,
      temperature: requireFiniteTemperature(raw.temperature, "generation settings v1.temperature"),
      maxTokens: requirePositiveSettingsInteger(
        raw.maxTokens,
        "generation settings v1.maxTokens",
        MAX_SETTINGS_TOKEN_COUNT
      ),
      systemPrompt: requireBoundedSettingsString(
        raw.systemPrompt,
        "generation settings v1.systemPrompt",
        MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
        1
      ),
      contextWindow
    };
  } catch (error) {
    if (error instanceof SettingsFormatError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new SettingsFormatError(`Generation settings v1 are invalid${detail}`, { cause: error });
  }
}

export function parseGenerationSettingsV1Bytes(bytes: Uint8Array): GenerationSettings {
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Generation settings v1 exceed the ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  let text: string;
  try {
    text = decodeCanonicalUtf8(bytes, "generation settings v1");
  } catch (error) {
    throw new SettingsFormatError("Generation settings v1 are not strict UTF-8", { cause: error });
  }
  return parseGenerationSettingsV1Text(text);
}

export function parseGenerationSettingsV1Text(text: string): GenerationSettings {
  let bytes: Uint8Array;
  try {
    bytes = encodeUtf8Strict(text, "generation settings v1");
  } catch (error) {
    throw new SettingsFormatError("Generation settings v1 contain invalid Unicode", { cause: error });
  }
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Generation settings v1 exceed the ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  return deepFreeze(parseGenerationSettingsV1(parseJsonRejectingDuplicateKeys(text, "generation settings v1")));
}

export function formatGenerationSettingsV1(value: GenerationSettings): string {
  const settings = parseGenerationSettingsV1(value);
  const text = canonicalJson(settings);
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Generation settings v1 exceed the ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  return text;
}

export function hashCanonicalGenerationSettingsV1(value: GenerationSettings): string {
  return createHash("sha256").update(formatGenerationSettingsV1(value), "utf8").digest("hex");
}

export const ABSENT_SETTINGS_V1 = parseGenerationSettingsV1Text(ABSENT_SETTINGS_V1_TEXT);

if (hashCanonicalGenerationSettingsV1(ABSENT_SETTINGS_V1) !== ABSENT_SETTINGS_V1_HASH) {
  throw new Error("Checked-in absent settings v1 hash vector is stale");
}

function requireLegacyCredentialName(value: unknown, label: string): string {
  if (typeof value !== "string" || !CREDENTIAL_ENV_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} is not a portable environment-variable name`);
  }
  return value;
}

function oneOf<const T extends readonly Provider[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new SettingsFormatError(`${label} is invalid`);
  }
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
