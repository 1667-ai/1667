import type { GenerationSettings } from "../shared/types.js";
import {
  MAX_ALTERNATIVE_TOKENS,
  MAX_TOKEN_PROBABILITY_STEPS,
  MAX_TOKEN_PROBABILITY_TEXT_CHARS,
  type AlternativeToken,
  type CapturedTokenProbabilities,
  type TokenProbabilityStep
} from "../shared/token-probabilities.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { redactProviderSecrets } from "./provider-runtime.js";

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
 *  `StreamOutcome` in server/providers.ts. `record` is filled exactly once,
 *  at stream finalization (`createTokenProbabilityCapture`'s `finish`) —
 *  never rebuilt per chunk. It carries the raw capture, not yet a persisted
 *  `TokenProbabilityRecord`: commit-time alignment
 *  (server/story-node-token-probabilities.ts) is what places it inside a
 *  take's stored text and turns it into one. */
export interface TokenProbabilityCollector {
  record: CapturedTokenProbabilities | null;
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
 *  prose, and one bad entry among thousands must not discard the rest.
 *  Private: only `createTokenProbabilityCapture`'s `observe` calls this. */
function parseOpenAiLogprobsEntry(value: unknown): TokenProbabilityStep | null {
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

/** Every string a provider put in this record, in the order it sent them.
 *  Both the generated tokens and the alternatives, one after another, so a
 *  secret split across two of them is as visible here as a whole one. */
function capturedText(steps: readonly TokenProbabilityStep[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    parts.push(step.token);
    for (const alternative of step.alternatives) parts.push(alternative.token);
  }
  return parts.join("");
}

/** Streamed prose passes through the stream redactor on its way out; these
 *  strings never did. A provider that returns the key it was given — in a
 *  token, in an alternative, or split across several of them — would
 *  otherwise have it written to the story bundle and read back by the viewer,
 *  which is exactly the leak the prose redactor exists to prevent.
 *
 *  A record that carries secret material is dropped whole rather than
 *  scrubbed. Partial redaction would leave a diagnostic whose tokens no longer
 *  concatenate to the prose they describe, and an endpoint that echoes a
 *  credential is not one whose alternatives are worth keeping. Losing them
 *  costs a diagnostic; keeping them costs the key. */
function carriesProviderSecret(
  steps: readonly TokenProbabilityStep[],
  secrets: readonly string[]
): boolean {
  if (secrets.length === 0) return false;
  const captured = capturedText(steps);
  return redactProviderSecrets(captured, secrets) !== captured;
}

/** Owns one attempt's capture state end to end, so neither the state nor its
 *  interpretation has to live in server/providers.ts (issue #291 structural
 *  review, finding F2): `observe` is the OpenAI-compatible per-event parser,
 *  `push` takes an already-built step (dry-run's deterministic fabrication),
 *  and `finish` is the old `finalizeTokenProbabilities` — building the box
 *  exactly once, at stream finalization, never per chunk (issue #291 phase
 *  2, point 1).
 *
 *  A fresh instance per attempt is load-bearing: only the attempt that
 *  actually finishes ever calls `finish`, so a retried attempt's partial
 *  capture is never mixed with the one that succeeds — server/providers.ts
 *  creates one `const capture = ...` per attempt, not once per request. */
export function createTokenProbabilityCapture(
  collector: TokenProbabilityCollector | undefined,
  requestedAlternatives: number | null,
  secrets: readonly string[]
): { observe(choice: unknown): void; push(step: TokenProbabilityStep): void; finish(): void } {
  const active = collector !== undefined && requestedAlternatives !== null;
  const steps: TokenProbabilityStep[] = [];
  let truncated = false;

  function push(step: TokenProbabilityStep): void {
    if (!active || truncated) return;
    if (steps.length >= MAX_TOKEN_PROBABILITY_STEPS) {
      truncated = true;
      return;
    }
    steps.push(step);
  }

  return {
    observe(choice: unknown): void {
      if (!active || truncated) return;
      // OpenAI streams `logprobs.content` incrementally, one entry per
      // event; KoboldCpp sends the whole array in a final chunk — never
      // assume one element per event, and never assume every event carries
      // one (issue #291 phase 2, point 2).
      const logprobs = isObject(choice) ? choice.logprobs : undefined;
      const content = isObject(logprobs) ? logprobs.content : undefined;
      if (!Array.isArray(content)) return;
      for (const entry of content) {
        if (steps.length >= MAX_TOKEN_PROBABILITY_STEPS) {
          truncated = true;
          break;
        }
        const step = parseOpenAiLogprobsEntry(entry);
        // A malformed entry is skipped, not thrown: a broken diagnostic must
        // never cost the writer their prose (issue #291 phase 2, point 3).
        if (step !== null) steps.push(step);
      }
    },
    push,
    finish(): void {
      // Leaves the box null, rather than storing an empty capture, when
      // nothing usable ever arrived (point 7) or when the provider returned
      // its own credential inside one.
      if (collector === undefined || requestedAlternatives === null) return;
      collector.record = steps.length === 0 || carriesProviderSecret(steps, secrets)
        ? null
        : { requested: requestedAlternatives, steps, truncated };
    }
  };
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
 *  way an unavailable sampling knob would be.
 *
 *  Every alternative carries the sampled token's own leading boundary. A real
 *  tokenizer puts the space before the word inside the token, so every
 *  alternative at one position begins the same way; alternatives that dropped
 *  it would sit one cell left of the sampled token in the viewer and read as
 *  a broken column rather than as the boundary it is. */
export function dryRunProbabilityStep(word: string, requested: number, stepIndex: number): TokenProbabilityStep {
  const bounded = Math.min(requested, MAX_ALTERNATIVE_TOKENS);
  const boundary = word.slice(0, word.length - word.trimStart().length);
  const alternatives: AlternativeToken[] = [{ token: word, logprob: DRY_RUN_BASE_LOGPROB }];
  for (let rank = 1; rank < bounded; rank++) {
    const candidate = DRY_RUN_ALTERNATIVE_TOKENS[(stepIndex + rank) % DRY_RUN_ALTERNATIVE_TOKENS.length]!;
    alternatives.push({
      token: `${boundary}${candidate}`,
      logprob: DRY_RUN_BASE_LOGPROB - rank * DRY_RUN_LOGPROB_STEP
    });
  }
  return { token: word, logprob: DRY_RUN_BASE_LOGPROB, alternatives };
}
