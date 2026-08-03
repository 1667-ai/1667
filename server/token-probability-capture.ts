import type { GenerationSettings } from "../shared/types.js";
import {
  MAX_ALTERNATIVE_TOKENS,
  MAX_TOKEN_PROBABILITY_TEXT_CHARS,
  createTokenProbabilities,
  type AlternativeToken,
  type TokenProbabilityRecord,
  type TokenProbabilityStep
} from "../shared/token-probabilities.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";

/**
 * The capture side of issue #291 phase 2: what server/providers.ts fills
 * while a stream runs (the collector box, the OpenAI-compatible logprobs
 * parser, dry-run's deterministic fabrication) and the process-local refusal
 * memory that keeps a model from being asked twice. Split out of
 * server/providers.ts to keep that file's HTTP/SSE mechanics under the
 * repository's file-size guideline.
 */

/** Filled as the stream runs when the request asked for token probabilities.
 *  Callers that want them pass a box the provider fills, the same pattern as
 *  `StreamOutcome` in server/providers.ts. `record` is built exactly once, at
 *  stream finalization — `createTokenProbabilities` re-serializes the whole
 *  record to check its byte bound, so calling it per chunk would be
 *  needless, quadratic work. */
export interface TokenProbabilityCollector {
  record: TokenProbabilityRecord | null;
}

/** Mirrors providers.ts's SAMPLING_REFUSED, but for `logprobs`/
 * `top_logprobs`: models observed to reject token-probability capture
 * outright, keyed by endpoint and model. Unlike a sampling knob's silent
 * loss — which changes what the provider actually samples — losing this
 * field only loses a diagnostic the writer opted into
 * (server/provider-request-body.ts documents that distinction), so a
 * refusal is not an error. It is still remembered and paid once per model
 * rather than on every request, so a model that has already said no is
 * never asked again. Process-local by design: it is an observation about a
 * remote endpoint, not settings. */
const TOKEN_PROBABILITY_REFUSED = new Set<string>();

export function tokenProbabilityRefusalKey(settings: GenerationSettings): string {
  return `${settings.baseUrl}\0${settings.model}`;
}

export function tokenProbabilitiesRefused(key: string): boolean {
  return TOKEN_PROBABILITY_REFUSED.has(key);
}

export function refuseTokenProbabilities(key: string): void {
  TOKEN_PROBABILITY_REFUSED.add(key);
}

export function forgetRefusedTokenProbabilities(): void {
  TOKEN_PROBABILITY_REFUSED.clear();
}

/** One element of OpenAI's `choices[0].logprobs.content` array: the
 *  generated token, its own logprob, and the alternatives the model weighed
 *  with it. A malformed entry — the wrong shape, a positive or non-finite
 *  logprob, an over-long token — is skipped rather than thrown (issue #291
 *  phase 2, point 3): a broken diagnostic must never cost the writer their
 *  prose, and one bad entry among thousands must not discard the rest. */
export function parseOpenAiLogprobsEntry(value: unknown): TokenProbabilityStep | null {
  if (!isObject(value)) return null;
  if (!isValidTokenProbabilityText(value.token) || !isValidLogprob(value.logprob)) return null;
  const rawAlternatives = value.top_logprobs;
  if (!Array.isArray(rawAlternatives) || rawAlternatives.length > MAX_ALTERNATIVE_TOKENS) return null;
  const alternatives: AlternativeToken[] = [];
  for (const raw of rawAlternatives) {
    if (!isObject(raw) || !isValidTokenProbabilityText(raw.token) || !isValidLogprob(raw.logprob)) return null;
    alternatives.push({ token: raw.token, logprob: raw.logprob });
  }
  return { token: value.token, logprob: value.logprob, alternatives };
}

function isValidTokenProbabilityText(value: unknown): value is string {
  return typeof value === "string"
    && !hasUnpairedSurrogate(value)
    && unicodeScalarLength(value, MAX_TOKEN_PROBABILITY_TEXT_CHARS) <= MAX_TOKEN_PROBABILITY_TEXT_CHARS;
}

function isValidLogprob(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value <= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `createTokenProbabilities` re-validates every bound; the per-entry checks
 *  above already screen ordinary malformed entries, so a throw here is a
 *  last-resort guard (for example a step count that reached the cap exactly
 *  as the byte bound was also crossed). Token probabilities are a
 *  diagnostic, never a reason to fail the generation itself.
 *
 *  `textOffset` is 0 here, a placeholder: this is the raw capture, still in
 *  the order the stream produced it, not yet placed inside the take's stored
 *  text. The commit path realigns it — see `alignTokenProbabilities` in
 *  shared/token-probabilities.ts and its callers in server/story-node-text.ts
 *  — before anything is persisted. */
function safeCreateTokenProbabilities(
  requested: number,
  steps: readonly TokenProbabilityStep[],
  truncated: boolean
): TokenProbabilityRecord | null {
  try {
    return createTokenProbabilities(requested, steps, truncated, 0);
  } catch {
    return null;
  }
}

/** Builds the record exactly once, at stream finalization — never per chunk
 *  (issue #291 phase 2, point 1). Leaves the box null, rather than storing an
 *  empty record, when nothing usable ever arrived (point 7). */
export function finalizeTokenProbabilities(
  collector: TokenProbabilityCollector | undefined,
  requested: number | null,
  steps: readonly TokenProbabilityStep[],
  truncated: boolean
): void {
  if (collector === undefined || requested === null) return;
  collector.record = steps.length === 0 ? null : safeCreateTokenProbabilities(requested, steps, truncated);
}

/** A closed, fixed vocabulary for dry-run's fabricated alternatives — never
 *  derived from a clock or `Math.random()`, so the same prompt always
 *  fabricates the same record. Exactly MAX_ALTERNATIVE_TOKENS entries, so
 *  every rank a request could ask for has one to cycle to. */
const DRY_RUN_ALTERNATIVE_TOKENS: readonly string[] = [
  "the", "a", "an", "and", "but", "so", "then", "now",
  "still", "again", "there", "here", "soon", "later", "quietly", "slowly",
  "gently", "briefly", "already", "instead"
];

const DRY_RUN_BASE_LOGPROB = -0.05;
const DRY_RUN_LOGPROB_STEP = 0.4;

/** One fabricated step: the sampled token first (as a real provider's own
 *  alternatives commonly do), then `requested - 1` more descending logprobs
 *  drawn from the fixed table above, keyed off the step's position so two
 *  different positions in the same prompt do not repeat the same table
 *  entries. Dry-run really does fabricate these — it is not pretending, the
 *  way an unavailable sampling knob would be. */
export function dryRunProbabilityStep(word: string, requested: number, stepIndex: number): TokenProbabilityStep {
  const bounded = Math.min(requested, MAX_ALTERNATIVE_TOKENS);
  const alternatives: AlternativeToken[] = [{ token: word, logprob: DRY_RUN_BASE_LOGPROB }];
  for (let rank = 1; rank < bounded; rank++) {
    const candidate = DRY_RUN_ALTERNATIVE_TOKENS[(stepIndex + rank) % DRY_RUN_ALTERNATIVE_TOKENS.length]!;
    alternatives.push({ token: candidate, logprob: DRY_RUN_BASE_LOGPROB - rank * DRY_RUN_LOGPROB_STEP });
  }
  return { token: word, logprob: DRY_RUN_BASE_LOGPROB, alternatives };
}
