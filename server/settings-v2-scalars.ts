import { StoryFormatError } from "./story-format-facts.js";
import { unicodeScalarLength } from "../shared/unicode.js";
import {
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_ENV_PATTERN_SOURCE,
  MAX_CREDENTIAL_NAMES_PER_DOCUMENT,
  isCredentialEnvironmentName
} from "../shared/credential-slot-policy.js";
import {
  SamplingValidationError,
  validateSamplingLogitBias,
  validateSamplingNumber,
  validateSamplingScalar,
  validateSamplingStopSequences
} from "../shared/sampling-validation-policy.js";
export { classifyHttpHost } from "../shared/http-host-class.js";
export {
  MAX_SAMPLING_LOGIT_BIAS_ENTRIES,
  MAX_SAMPLING_STOP_SCALARS,
  MAX_SAMPLING_STOP_SEQUENCES,
  MAX_SAMPLING_TOP_K,
  SAMPLING_LOGIT_BIAS_KEY_PATTERN,
  SAMPLING_LOGIT_BIAS_KEY_PATTERN_SOURCE,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_SCALAR_DESCRIPTORS,
  SAMPLING_STOP_POLICY
} from "../shared/sampling-validation-policy.js";

export const MAX_SETTINGS_DOCUMENT_BYTES = 256 * 1024;
export const MAX_SETTINGS_STATE_BYTES = 1024 * 1024;
export const MAX_SETTINGS_STATE_ENVELOPE_BYTES = 512 * 1024;
export const MAX_SETTINGS_RECORDS = 64;
export const MAX_SETTINGS_HEADERS = 32;
export const MAX_SETTINGS_CREDENTIAL_NAMES =
  MAX_CREDENTIAL_NAMES_PER_DOCUMENT;
export const MAX_SETTINGS_ID_SCALARS = 128;
export const MAX_SETTINGS_NAME_SCALARS = 256;
export const MAX_SETTINGS_REMOTE_ID_SCALARS = 512;
export const MAX_SETTINGS_URL_SCALARS = 4_096;
export const MAX_SETTINGS_AUTHOR_BRIEF_SCALARS = 65_536;
export const MAX_SETTINGS_TIMEOUT_MS = 86_400_000;
export const MAX_SETTINGS_TOKEN_COUNT = 1_000_000_000;

export const SETTINGS_ID_PATTERN_SOURCE = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
export const SETTINGS_ID_PATTERN = new RegExp(`^(?:${SETTINGS_ID_PATTERN_SOURCE})$`, "u");
export const SECRET_ID_PATTERN_SOURCE = SETTINGS_ID_PATTERN_SOURCE;
export const SECRET_ID_PATTERN = SETTINGS_ID_PATTERN;
export { CREDENTIAL_ENV_PATTERN, CREDENTIAL_ENV_PATTERN_SOURCE };
export const HEADER_NAME_PATTERN_SOURCE = "[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}";
export const HEADER_NAME_PATTERN = new RegExp(`^(?:${HEADER_NAME_PATTERN_SOURCE})$`, "u");
export const HASH256_PATTERN_SOURCE = "[0-9a-f]{64}";
export const HASH256_PATTERN = new RegExp(`^(?:${HASH256_PATTERN_SOURCE})$`, "u");

const PROTECTED_HEADERS = new Set([
  "accept",
  "anthropic-version",
  "authorization",
  "content-length",
  "content-type",
  "host",
  "proxy-authorization"
]);

export class SettingsFormatError extends StoryFormatError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingsFormatError";
  }
}

export function requireSettingsId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SETTINGS_ID_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} must match ${SETTINGS_ID_PATTERN}`);
  }
  return value;
}

export function requireSecretId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SECRET_ID_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} must match ${SECRET_ID_PATTERN}`);
  }
  return value;
}

export function requireBoundedSettingsString(
  value: unknown,
  label: string,
  maxScalars: number,
  minimum = 0
): string {
  if (typeof value !== "string") throw new SettingsFormatError(`${label} must be a string`);
  const length = unicodeScalarLength(value, maxScalars);
  if (length < minimum || length > maxScalars) {
    throw new SettingsFormatError(`${label} must contain ${minimum}..${maxScalars} Unicode scalars`);
  }
  return value;
}

export function requirePositiveSettingsInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 1
    || value > maximum
  ) {
    throw new SettingsFormatError(`${label} must be an integer in 1..${maximum}`);
  }
  return value;
}

export function requireFiniteTemperature(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -100 || value > 100) {
    throw new SettingsFormatError(`${label} must be null or a finite number in -100..100`);
  }
  return value;
}

export function requireSamplingNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  return samplingPolicy(() => validateSamplingNumber(
    value,
    label,
    { minimum, maximum, integer: false }
  ));
}

export function requireSamplingTopK(value: unknown, label: string): number {
  return samplingPolicy(() => validateSamplingScalar("topK", value, label));
}

export function requireSamplingStopSequences(
  value: unknown,
  label: string
): readonly string[] {
  return samplingPolicy(() => validateSamplingStopSequences(value, label));
}

export function requireSamplingLogitBias(
  value: unknown,
  label: string
): Readonly<Record<string, number>> {
  return samplingPolicy(() => validateSamplingLogitBias(value, label));
}

function samplingPolicy<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SamplingValidationError) {
      throw new SettingsFormatError(error.message, { cause: error });
    }
    throw error;
  }
}

export function requireCredentialName(
  value: unknown,
  label: string,
  caseInsensitive = process.platform === "win32"
): string {
  if (typeof value !== "string" || !CREDENTIAL_ENV_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} is not a portable environment-variable name`);
  }
  if (!isCredentialEnvironmentName(value, caseInsensitive)) {
    throw new SettingsFormatError(`${label} is reserved for runtime or presentation use`);
  }
  return value;
}

export function requireHeaderName(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEADER_NAME_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} is not a valid HTTP header name`);
  }
  if (PROTECTED_HEADERS.has(value.toLowerCase())) {
    throw new SettingsFormatError(`${label} is owned by the transport or authentication slot`);
  }
  return value;
}

export function normalizeSettingsBaseUrl(value: unknown, label: string): string {
  const original = requireBoundedSettingsString(value, label, MAX_SETTINGS_URL_SCALARS, 1);
  const normalized = original.trim().replace(/\/+$/u, "");
  if (normalized !== original || /[\u0000-\u001f\u007f]/u.test(original)) {
    throw new SettingsFormatError(`${label} is not in trimmed, trailing-slash-free form`);
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new SettingsFormatError(`${label} is not an absolute URL`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SettingsFormatError(`${label} must use http: or https:`);
  }
  if (
    parsed.username !== ""
    || parsed.password !== ""
    || parsed.href.includes("?")
    || parsed.href.includes("#")
  ) {
    throw new SettingsFormatError(`${label} must not contain userinfo, query, or fragment components`);
  }
  if (
    parsed.hostname === ""
    || parsed.hostname.endsWith(".")
    || parsed.hostname.includes("%")
    || parsed.hostname !== parsed.hostname.toLowerCase()
  ) {
    throw new SettingsFormatError(`${label} contains an ambiguous or non-canonical hostname`);
  }
  return normalized;
}
