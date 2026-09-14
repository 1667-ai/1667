import { createHash } from "node:crypto";
import {
  createTokenProbabilities,
  parseTokenProbabilitiesWire,
  serializeTokenProbabilities,
  TokenProbabilityFormatError
} from "./token-probability-wire.js";
export { TokenProbabilityFormatError } from "./token-probability-wire.js";
export {
  MAX_ALTERNATIVE_TOKENS,
  MAX_TOKEN_PROBABILITY_BYTES,
  MAX_TOKEN_PROBABILITY_STEPS,
  MAX_TOKEN_PROBABILITY_TEXT_CHARS
} from "./token-probability-policy.js";
import {
  MAX_ALTERNATIVE_TOKENS,
  MAX_TOKEN_PROBABILITY_BYTES,
  MAX_TOKEN_PROBABILITY_STEPS,
  MAX_TOKEN_PROBABILITY_TEXT_CHARS
} from "./token-probability-policy.js";

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

/** What the stream capture has in hand before commit-time alignment places it
 *  inside a take's stored text: the same fields as a stored record, minus
 *  `textOffset`, which is meaningless until alignment computes it. Kept as
 *  its own type — not a partial `TokenProbabilityRecord` — so a capture can
 *  never be persisted without first going through `createTokenProbabilities`
 *  and a real offset. */
export interface CapturedTokenProbabilities {
  readonly requested: number;
  readonly steps: readonly TokenProbabilityStep[];
  readonly truncated: boolean;
}

export interface TokenProbabilityRecord {
  readonly format: typeof TOKEN_PROBABILITY_FORMAT;
  readonly schemaVersion: typeof TOKEN_PROBABILITY_SCHEMA_VERSION;
  /** The alternative count this request asked for. */
  readonly requested: number;
  /** UTF-16 offset in the take's stored text where the concatenation of these
   *  steps begins. An append records only the streamed tail, and a trimmed
   *  take drops leading recorded text, so this is rarely 0. Always a real,
   *  computed offset — nothing in this module can construct a record with a
   *  placeholder value here; `createTokenProbabilities` requires the caller
   *  to supply one. */
  readonly textOffset: number;
  readonly steps: readonly TokenProbabilityStep[];
  /** Present only when a bound stopped the recording short. */
  readonly truncated?: true;
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

/** The result of reconciling a stream's captured steps with the text a take
 *  actually stored. See `alignTokenProbabilities` below for why this can
 *  fail. */
export { createTokenProbabilities, serializeTokenProbabilities };

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
  return parseTokenProbabilitiesWire(raw);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
