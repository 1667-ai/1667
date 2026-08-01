import { StoryFormatError } from "./story-format-facts.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import {
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_ENV_PATTERN_SOURCE,
  MAX_CREDENTIAL_NAMES_PER_DOCUMENT,
  isCredentialEnvironmentName
} from "../shared/credential-slot-policy.js";
export { classifyHttpHost } from "../shared/http-host-class.js";

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
export const MAX_SAMPLING_TOP_K = 100_000;
export const MAX_SAMPLING_STOP_SEQUENCES = 4;
export const MAX_SAMPLING_STOP_SCALARS = 64;
export const MAX_SAMPLING_LOGIT_BIAS_ENTRIES = 16;
export const SAMPLING_LOGIT_BIAS_KEY_PATTERN_SOURCE = "(0|[1-9][0-9]{0,6})";
export const SAMPLING_LOGIT_BIAS_KEY_PATTERN = new RegExp(
  `^(?:${SAMPLING_LOGIT_BIAS_KEY_PATTERN_SOURCE})$`,
  "u"
);

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
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) {
    throw new SettingsFormatError(
      `${label} must be a finite number in ${minimum}..${maximum}`
    );
  }
  return value;
}

export function requireSamplingTopK(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0
    || value > MAX_SAMPLING_TOP_K
  ) {
    throw new SettingsFormatError(
      `${label} must be an integer in 0..${MAX_SAMPLING_TOP_K}`
    );
  }
  return value;
}

export function requireSamplingStopSequences(
  value: unknown,
  label: string
): readonly string[] {
  if (!Array.isArray(value)) throw new SettingsFormatError(`${label} must be an array`);
  if (value.length > MAX_SAMPLING_STOP_SEQUENCES) {
    throw new SettingsFormatError(
      `${label} exceeds the ${MAX_SAMPLING_STOP_SEQUENCES}-item limit`
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "string" || hasUnpairedSurrogate(entry)) {
      throw new SettingsFormatError(
        `${label}[${index}] must be a well-formed NFC string`
      );
    }
    if (entry.normalize("NFC") !== entry) {
      throw new SettingsFormatError(`${label}[${index}] must be NFC-normalized`);
    }
    const stop = requireBoundedSettingsString(
      entry,
      `${label}[${index}]`,
      MAX_SAMPLING_STOP_SCALARS,
      1
    );
    if (seen.has(stop)) throw new SettingsFormatError(`${label} repeats ${JSON.stringify(stop)}`);
    seen.add(stop);
    return stop;
  });
}

export function requireSamplingLogitBias(
  value: unknown,
  label: string
): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError(`${label} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SAMPLING_LOGIT_BIAS_ENTRIES) {
    throw new SettingsFormatError(
      `${label} exceeds the ${MAX_SAMPLING_LOGIT_BIAS_ENTRIES}-entry limit`
    );
  }
  const sorted = entries.map(([key, entry]) => {
    if (!SAMPLING_LOGIT_BIAS_KEY_PATTERN.test(key)) {
      throw new SettingsFormatError(`${label} key ${JSON.stringify(key)} is invalid`);
    }
    if (
      typeof entry !== "number"
      || !Number.isSafeInteger(entry)
      || Object.is(entry, -0)
      || entry < -100
      || entry > 100
    ) {
      throw new SettingsFormatError(`${label}.${key} must be an integer in -100..100`);
    }
    return [key, entry] as const;
  });
  sorted.sort((left, right) => Number(left[0]) - Number(right[0]));
  return Object.fromEntries(sorted);
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
