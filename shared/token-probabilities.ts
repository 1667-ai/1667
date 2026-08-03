import { createHash } from "node:crypto";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

/**
 * The token probability wire and storage format.
 *
 * A provider that documents `logprobs` reports, for each generated token, the
 * alternative tokens it weighed at that position and their log probabilities.
 * `shared/token-probability-capabilities.ts` says which of 1667's endpoints
 * document the field; this module only shapes and bounds what gets stored
 * once a provider has returned one.
 *
 * 1667 stores exactly what the provider returned, content-addressed beside
 * the take (`server/story-objects.ts`, phase 3), and derives every displayed
 * probability from the logprob at render time — see `probabilityOf`. `p` is
 * never itself stored. The shape is frozen now because the object's bytes are
 * hashed for that content address: a later migration would have to reach
 * every story that ever stored one.
 *
 * The steps rarely cover the whole of a take's stored text — an append
 * records only its streamed tail, and a trim or a stripped echo removes text
 * the recording still includes — so `textOffset` places the steps inside
 * that text and `alignTokenProbabilities` computes it. See that function for
 * the three ways the two can drift and how each is reconciled.
 *
 * OpenAI logprobs: https://platform.openai.com/docs/api-reference/chat/create
 *   (`logprobs`, `top_logprobs`, up to 20 alternatives per token)
 */
export const TOKEN_PROBABILITY_FORMAT = "1667-token-probabilities";
export const TOKEN_PROBABILITY_SCHEMA_VERSION = 1;

export const MAX_TOKEN_PROBABILITY_STEPS = 8_192;
/** OpenAI's documented `top_logprobs` ceiling. */
export const MAX_ALTERNATIVE_TOKENS = 20;
export const MAX_TOKEN_PROBABILITY_TEXT_CHARS = 256;
export const MAX_TOKEN_PROBABILITY_BYTES = 4 * 1024 * 1024;

/** One token the model weighed at one position. */
export interface AlternativeToken {
  readonly token: string;
  readonly logprob: number;
}

/** One generated token and the alternatives the model weighed with it. */
export interface TokenProbabilityStep {
  /** Exactly what the provider returned, with one exception: when a take's
   *  stored text is trimmed relative to what was recorded,
   *  `alignTokenProbabilities` narrows the boundary token that straddles the
   *  trim, dropping only the whitespace the stored text itself already
   *  discarded. That is the one place a stored token is not byte-for-byte
   *  what the provider returned — see that function for why. */
  readonly token: string;
  readonly logprob: number;
  /** As the provider returned them: most likely first. Includes the sampled
   *  token when the provider reports it there. */
  readonly alternatives: readonly AlternativeToken[];
}

export interface TokenProbabilityRecord {
  readonly format: typeof TOKEN_PROBABILITY_FORMAT;
  readonly schemaVersion: typeof TOKEN_PROBABILITY_SCHEMA_VERSION;
  /** The alternative count this request asked for. */
  readonly requested: number;
  /** UTF-16 offset in the take's stored text where the concatenation of these
   *  steps begins. An append records only the streamed tail, and a trimmed
   *  take drops leading recorded text, so this is rarely 0. */
  readonly textOffset: number;
  readonly steps: readonly TokenProbabilityStep[];
  /** Present only when a bound stopped the recording short. */
  readonly truncated?: true;
}

export class TokenProbabilityFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenProbabilityFormatError";
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** Every displayed probability is derived from the stored logprob, never
 *  itself stored — the clamp only guards the floating-point edge where a
 *  logprob at or near 0 exponentiates a hair past 1. */
export function probabilityOf(logprob: number): number {
  const value = Math.exp(logprob);
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Construct a record from already-decoded parts, enforcing every bound.
 *  Both `parseTokenProbabilities` and the phase-2 stream capture that builds
 *  a record incrementally go through here, so a bound can never be enforced
 *  in one path and forgotten in the other. `textOffset` comes last, after the
 *  optional `truncated`, because a required parameter cannot follow an
 *  optional one — callers that know it (the addendum's alignment step) pass
 *  it; the phase-2 capture, which does not know it yet, passes 0 and lets
 *  commit-time alignment build the real record. */
export function createTokenProbabilities(
  requested: number,
  steps: readonly TokenProbabilityStep[],
  truncated: boolean | undefined,
  textOffset: number
): TokenProbabilityRecord {
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
    ...(truncated === true ? { truncated: true as const } : {})
  };
  assertEncodedSize(record);
  return record;
}

/** The result of reconciling a stream's captured steps with the text a take
 *  actually stored. See `alignTokenProbabilities` below for why this can
 *  fail. */
export interface AlignedTokenProbabilities {
  readonly steps: readonly TokenProbabilityStep[];
  readonly textOffset: number;
}

/** Place the recorded steps inside the take's stored text, dropping whole
 *  steps that fall outside it. Returns null when the two cannot be
 *  reconciled on whole-token boundaries — a highlight on the wrong word is
 *  worse than no viewer at all.
 *
 *  Three things can move the recording away from the stored text (issue #291
 *  addendum): a new take stores `raw.trim()`, so leading or trailing
 *  whitespace the model emitted — and recorded steps for — is gone; an
 *  append stores only the streamed tail, so the recording starts at
 *  `segmentStart`, not 0; and an echoed left anchor is stripped from `raw`
 *  while the captured steps still include it. The first two make the
 *  recording a prefix of a larger, unchanged region (truncation); the last
 *  two make it a superset of the stored text (a trim or a stripped echo).
 *  Both searches use the first occurrence.
 *
 *  A trim's boundary routinely falls *inside* a token rather than between
 *  two: a take stores trimmed text, so the model's first (or last) recorded
 *  token very often carries the leading (or trailing) whitespace the take's
 *  stored text does not. Refusing outright on every such boundary would
 *  silently drop that common case, so when the excluded slice of a boundary
 *  token is whitespace-only, the step is kept with its `token` narrowed to
 *  the included part — see `TokenProbabilityStep.token` for why that is the
 *  one place a stored token departs from what the provider returned. A
 *  non-whitespace boundary still refuses, and so does a narrow that would
 *  leave nothing behind — that step is dropped instead. */
export function alignTokenProbabilities(
  steps: readonly TokenProbabilityStep[],
  storedSegment: string,
  segmentStart: number
): AlignedTokenProbabilities | null {
  const recorded = steps.map((step) => step.token).join("");
  if (recorded.length === 0 || storedSegment.length === 0) return null;

  // The recording covers part of the segment: truncation. Every step stays;
  // only the base offset shifts to where it actually sits.
  const truncationIndex = storedSegment.indexOf(recorded);
  if (truncationIndex !== -1) {
    return { steps, textOffset: segmentStart + truncationIndex };
  }

  // The recording covers more than the segment: a trim or a stripped echo.
  // Drop whole steps that fall outside [matchStart, matchEnd). When a
  // boundary lands inside a token instead of between two, narrow that token
  // to its included part if the excluded slice is whitespace-only; refuse
  // only when it is not.
  const matchStart = recorded.indexOf(storedSegment);
  if (matchStart === -1) return null;
  const matchEnd = matchStart + storedSegment.length;

  const kept: TokenProbabilityStep[] = [];
  let cursor = 0;
  let sawStart = false;
  let sawEnd = false;
  for (const step of steps) {
    const stepStart = cursor;
    const stepEnd = cursor + step.token.length;
    cursor = stepEnd;
    if (stepEnd <= matchStart) continue; // ends at or before the start: drop
    if (stepStart >= matchEnd) continue; // begins at or after the end: drop

    let token = step.token;
    let tokenStart = stepStart;
    if (stepStart < matchStart) {
      // A take's stored text has already dropped the model's leading
      // whitespace, so a whitespace-only cut here is routine, not a defect —
      // keep the step, narrowed to what's left, when that's all it removes.
      const excluded = token.slice(0, matchStart - stepStart);
      if (!isWhitespaceOnly(excluded)) return null;
      token = token.slice(matchStart - stepStart);
      tokenStart = matchStart;
    }
    if (stepEnd > matchEnd) {
      // Same reasoning, trailing edge: a stored take's trailing whitespace is
      // gone the same way its leading whitespace is.
      const excluded = token.slice(token.length - (stepEnd - matchEnd));
      if (!isWhitespaceOnly(excluded)) return null;
      token = token.slice(0, token.length - (stepEnd - matchEnd));
    }
    if (token.length === 0) continue; // narrowing consumed the whole token: drop it, not keep it empty

    if (tokenStart === matchStart) sawStart = true;
    if (tokenStart + token.length === matchEnd) sawEnd = true;
    kept.push(token === step.token ? step : { ...step, token });
  }
  if (!sawStart || !sawEnd) return null;
  return { steps: kept, textOffset: segmentStart };
}

function isWhitespaceOnly(text: string): boolean {
  return /^\s*$/u.test(text);
}

/** Byte-stable: the same record always produces the same bytes, because the
 *  bytes are what phase 3 hashes for the object's content address. One
 *  literal with a fixed key order, at every level — never assembled by
 *  spreading optional fields in varying order. */
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

/** Mirrors `parseRevision` in `server/story-format.ts`: check the hash first
 *  when the caller has one, decode, re-validate every bound through
 *  `createTokenProbabilities`, then confirm the input was already the exact
 *  canonical bytes a fresh serialize would produce. `expectedHash` is
 *  optional here — phase 3 always supplies it when reading a stored object,
 *  but this layer also serves a plain round trip with no object store
 *  involved. */
export function parseTokenProbabilities(
  raw: string,
  expectedHash?: string
): TokenProbabilityRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_TOKEN_PROBABILITY_BYTES) {
    throw new TokenProbabilityFormatError(
      `Token probabilities exceed the ${MAX_TOKEN_PROBABILITY_BYTES.toLocaleString()}-byte size limit`
    );
  }
  if (expectedHash !== undefined) {
    if (!HASH_PATTERN.test(expectedHash)) throw new TokenProbabilityFormatError("Invalid token probabilities id");
    if (sha256Hex(raw) !== expectedHash) {
      throw new TokenProbabilityFormatError(`Token probabilities hash mismatch: ${expectedHash}`);
    }
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
  const record = createTokenProbabilities(requested, steps, value.truncated === true, textOffset);
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
  const bytes = Buffer.byteLength(serializeTokenProbabilities(record), "utf8");
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

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
