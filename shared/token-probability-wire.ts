import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";
import {
  MAX_ALTERNATIVE_TOKENS,
  MAX_TOKEN_PROBABILITY_BYTES,
  MAX_TOKEN_PROBABILITY_STEPS,
  MAX_TOKEN_PROBABILITY_TEXT_CHARS
} from "./token-probability-policy.js";
import type {
  AlternativeToken,
  CapturedTokenProbabilities,
  TokenProbabilityRecord,
  TokenProbabilityStep
} from "./token-probabilities.js";

export class TokenProbabilityFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenProbabilityFormatError";
  }
}

const TOKEN_PROBABILITY_FORMAT = "1667-token-probabilities";
const TOKEN_PROBABILITY_SCHEMA_VERSION = 1;

export function createTokenProbabilities(
  captured: CapturedTokenProbabilities,
  textOffset: number
): TokenProbabilityRecord {
  const { requested, steps, truncated } = captured;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_ALTERNATIVE_TOKENS) {
    throw new TokenProbabilityFormatError(`requested must be an integer in 1..${MAX_ALTERNATIVE_TOKENS}`);
  }
  if (!Number.isSafeInteger(textOffset) || textOffset < 0) {
    throw new TokenProbabilityFormatError("textOffset must be a non-negative integer");
  }
  if (steps.length > MAX_TOKEN_PROBABILITY_STEPS) {
    throw new TokenProbabilityFormatError(
      `Token probabilities exceed the ${MAX_TOKEN_PROBABILITY_STEPS.toLocaleString()}-step limit`
    );
  }
  const record: TokenProbabilityRecord = {
    format: TOKEN_PROBABILITY_FORMAT,
    schemaVersion: TOKEN_PROBABILITY_SCHEMA_VERSION,
    requested,
    textOffset,
    steps: steps.map((step, index) => cloneStep(step, index)),
    ...(truncated ? { truncated: true as const } : {})
  };
  assertEncodedSize(record);
  return record;
}

/** Byte-stable: the same record always produces the same bytes. */
export function serializeTokenProbabilities(record: TokenProbabilityRecord): string {
  return JSON.stringify({
    format: record.format,
    schemaVersion: record.schemaVersion,
    requested: record.requested,
    textOffset: record.textOffset,
    steps: record.steps.map((step) => ({
      token: step.token,
      logprob: step.logprob,
      alternatives: step.alternatives.map((alternative) => ({
        token: alternative.token,
        logprob: alternative.logprob
      }))
    })),
    ...(record.truncated === true ? { truncated: true as const } : {})
  });
}

/** Parse the canonical wire shape without the optional content hash check. */
export function parseTokenProbabilitiesWire(raw: string): TokenProbabilityRecord {
  if (new TextEncoder().encode(raw).byteLength > MAX_TOKEN_PROBABILITY_BYTES) {
    throw new TokenProbabilityFormatError(
      `Token probabilities exceed the ${MAX_TOKEN_PROBABILITY_BYTES.toLocaleString()}-byte size limit`
    );
  }
  const value = parseJsonObject(raw);
  if (value.format !== TOKEN_PROBABILITY_FORMAT) {
    throw new TokenProbabilityFormatError("Unsupported token probabilities format");
  }
  if (value.schemaVersion !== TOKEN_PROBABILITY_SCHEMA_VERSION) {
    throw new TokenProbabilityFormatError("Unsupported token probabilities schema version");
  }
  requireKeys(
    value,
    ["format", "schemaVersion", "requested", "textOffset", "steps"],
    ["truncated"],
    "token probabilities"
  );
  const requested = requireSafeInteger(value.requested, "requested");
  const textOffset = requireSafeInteger(value.textOffset, "textOffset");
  const steps = requireArray(value.steps, "steps").map((step, index) => parseStep(step, index));
  if (value.truncated !== undefined && value.truncated !== true) {
    throw new TokenProbabilityFormatError("truncated must be true when present");
  }
  const record = createTokenProbabilities({ requested, steps, truncated: value.truncated === true }, textOffset);
  if (serializeTokenProbabilities(record) !== raw) {
    throw new TokenProbabilityFormatError("Token probabilities are not canonically serialized");
  }
  return record;
}

function cloneStep(step: TokenProbabilityStep, index: number): TokenProbabilityStep {
  const token = requireTokenText(step.token, `steps[${index}].token`);
  const logprob = requireLogprob(step.logprob, `steps[${index}].logprob`);
  if (step.alternatives.length > MAX_ALTERNATIVE_TOKENS) {
    throw new TokenProbabilityFormatError(
      `steps[${index}].alternatives exceeds the ${MAX_ALTERNATIVE_TOKENS}-alternative limit`
    );
  }
  const alternatives = step.alternatives.map((alternative, altIndex) => ({
    token: requireTokenText(alternative.token, `steps[${index}].alternatives[${altIndex}].token`),
    logprob: requireLogprob(alternative.logprob, `steps[${index}].alternatives[${altIndex}].logprob`)
  }));
  return { token, logprob, alternatives };
}

function requireTokenText(value: string, label: string): string {
  if (hasUnpairedSurrogate(value)) {
    throw new TokenProbabilityFormatError(`${label} contains an unpaired Unicode surrogate`);
  }
  if (unicodeScalarLength(value, MAX_TOKEN_PROBABILITY_TEXT_CHARS) > MAX_TOKEN_PROBABILITY_TEXT_CHARS) {
    throw new TokenProbabilityFormatError(`${label} exceeds the ${MAX_TOKEN_PROBABILITY_TEXT_CHARS}-character limit`);
  }
  return value;
}

function requireLogprob(value: number, label: string): number {
  if (!Number.isFinite(value) || value > 0) {
    throw new TokenProbabilityFormatError(`${label} must be a finite number no greater than 0`);
  }
  return value;
}

function assertEncodedSize(record: TokenProbabilityRecord): void {
  const bytes = new TextEncoder().encode(serializeTokenProbabilities(record)).byteLength;
  if (bytes > MAX_TOKEN_PROBABILITY_BYTES) {
    throw new TokenProbabilityFormatError(
      `Token probabilities exceed the ${MAX_TOKEN_PROBABILITY_BYTES.toLocaleString()}-byte size limit`
    );
  }
}

function parseStep(value: unknown, index: number): TokenProbabilityStep {
  const label = `steps[${index}]`;
  const step = requireRecord(value, label);
  requireKeys(step, ["token", "logprob", "alternatives"], [], label);
  return {
    token: requireString(step.token, `${label}.token`),
    logprob: requireNumber(step.logprob, `${label}.logprob`),
    alternatives: requireArray(step.alternatives, `${label}.alternatives`)
      .map((alternative, altIndex) => parseAlternative(alternative, index, altIndex))
  };
}

function parseAlternative(value: unknown, stepIndex: number, altIndex: number): AlternativeToken {
  const label = `steps[${stepIndex}].alternatives[${altIndex}]`;
  const alternative = requireRecord(value, label);
  requireKeys(alternative, ["token", "logprob"], [], label);
  return {
    token: requireString(alternative.token, `${label}.token`),
    logprob: requireNumber(alternative.logprob, `${label}.logprob`)
  };
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TokenProbabilityFormatError(`${label} contains unknown key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TokenProbabilityFormatError(`${label} is missing required key: ${key}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TokenProbabilityFormatError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TokenProbabilityFormatError(`${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TokenProbabilityFormatError(`${label} must be a string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new TokenProbabilityFormatError(`${label} must be a number`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TokenProbabilityFormatError(`${label} must be an integer`);
  return value as number;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(raw) as unknown, "token probabilities");
  } catch (error) {
    if (error instanceof TokenProbabilityFormatError) throw error;
    throw new TokenProbabilityFormatError("Invalid JSON in token probabilities", { cause: error });
  }
}
