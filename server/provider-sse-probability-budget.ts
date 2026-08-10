/**
 * Issue #107: KoboldCpp emits every token probability in one SSE event —
 * sent after all the prose, once the stream is already done — so that one
 * event grows with the whole generation rather than with one token. A flat
 * per-event byte cap doesn't know a request asked for `top_logprobs`, even
 * though that payload is exactly what was requested on purpose. This module
 * sizes the per-event allowance to what was actually asked for instead —
 * split out of server/provider-sse.ts to keep that file's HTTP/SSE
 * mechanics under the repository's file-size guideline.
 *
 * This module's first cut sized the budget from a synthetic OpenAI-spec
 * payload and scaled it by the requested alternative count. That was wrong
 * on both counts (review finding, corrected below):
 *
 *  - KoboldCpp's own serializer (`~/source/oss/koboldcpp/koboldcpp.py`,
 *    `parse_last_logprobs`) always reports `min(option_count, logprobs_max)`
 *    alternatives per token, where `logprobs_max = 10` is hard-coded — it
 *    does NOT follow the client's requested `top_logprobs` count. Scaling
 *    the budget by the request's alternative count therefore starved a
 *    request that asked for few alternatives: at alt count 1 the old
 *    formula budgeted roughly `maxTokens * 256`, against a real need of
 *    `maxTokens * 1452` — an ordinary generation lost its probabilities
 *    every time, with the event simply refused as too large.
 *  - Every real entry also carries `token_id` and a `bytes` array (the
 *    token's UTF-8 bytes) that a bare OpenAI-spec payload does not, both on
 *    the sampled token and on each of its alternatives — real events are
 *    bigger than the spec shape alone predicts.
 *
 *  Measured directly against that serializer, mirroring its real output
 *  exactly (fixed at 10 alternatives per token, independent of what was
 *  requested):
 *
 *   tokens   event size   bytes/token
 *      512     0.71 MiB          1452
 *    1,000     1.38 MiB          1452
 *    2,048     2.84 MiB          1452
 *    4,096     5.67 MiB          1452
 *    8,192    11.35 MiB          1452
 *
 *  The cost is flat per token and independent of the requested alternative
 *  count, because the wire alternative count is independent of it too.
 *  PER_TOKEN_BYTES below rounds 1452 up by roughly 1.4x (2048 B/token) so
 *  the derived allowance carries genuine headroom over the measurement
 *  (longer or unicode-heavy tokens, a provider that isn't KoboldCpp and
 *  reports a different fixed alternative count, ...) instead of tracking it
 *  exactly — the same headroom ratio this module used before, just applied
 *  to the right variable.
 */
const PER_TOKEN_BYTES = 2048;
/** The outer `choices[0].logprobs` JSON wrapper and the SSE `data:` framing
 *  around the payload: a small fixed cost independent of token count. */
const PROBABILITY_EVENT_ENVELOPE_BYTES = 4 * 1024;

/**
 * Absolute ceiling for a probability-carrying event, regardless of how large
 * `maxTokens` derives it. Sized to the storage layer's own hard limit, not
 * to a round number: shared/token-probabilities.ts caps a stored record at
 * MAX_TOKEN_PROBABILITY_STEPS (8,192) steps, and at the measured 1,452
 * bytes/token above, a full 8,192-step payload is ~11.35 MiB on the wire.
 * 12 MiB is exactly "as much as the storage layer could conceivably accept
 * in steps", with a little headroom (unicode-heavy tokens, a provider that
 * isn't KoboldCpp) over that figure — not an arbitrary number, and not
 * trying to be generous beyond what the step limit already bounds.
 *
 * A transport-layer decision earlier tried to also cover events past this
 * ceiling — a request-wide "discard the event instead of throwing" path in
 * server/provider-sse.ts — and was removed (issue #107, third review pass):
 * deciding "this event is safe to drop" requires seeing the whole event
 * (its prose, its finish_reason, its error field), but an event too large
 * to buffer is precisely the one the parser cannot see all of. There is no
 * safe middle ground at the transport layer, so this module doesn't attempt
 * one: past MAX_PROBABILITY_EVENT_BYTES the stream fails loudly, exactly
 * the pre-existing behaviour for any oversized response.
 *
 * Below the ceiling, graceful degradation already exists one layer up:
 * server/story-node-token-probabilities.ts's attachTakeTokenProbabilities
 * wraps record creation in try/catch and returns on failure, so a captured
 * record that still busts MAX_TOKEN_PROBABILITY_BYTES (4 MiB) once
 * serialized for storage is dropped silently there — the take keeps its
 * prose, only the diagnostic is lost. The transport doesn't need to
 * pre-empt that decision; it only needs to let a storable-sized payload
 * through, which is exactly what sizing this ceiling to the step limit
 * achieves.
 */
const MAX_PROBABILITY_EVENT_BYTES = 12 * 1024 * 1024;

/** Mirrors the flat caps' own ratio in server/provider-sse.ts (2 MiB partial
 *  / 1 MiB event = 2x). A still-accumulating line needs headroom over the
 *  finished-event cap it is bounding before an event boundary is even seen,
 *  and the event queue's memory accounting doubles a UTF-16 string's length
 *  — both need the same headroom over whatever maxSseEventBytesFor resolves
 *  to, or they become the next thing to trip once a per-request budget grows
 *  past the old flat 2 MiB: a legal, in-budget probability event would then
 *  be refused by a cap that never learned the budget grew, even though
 *  maxSseEventBytesFor itself would have allowed it through. */
export const EVENT_HEADROOM_MULTIPLIER = 2;

/** No probabilities requested: `flatEventBytes` (server/provider-sse.ts's
 *  MAX_SSE_EVENT_BYTES), unchanged. Probabilities requested: a budget
 *  proportional to `maxTokens` alone — deliberately NOT to `alternatives`,
 *  since KoboldCpp's real wire cost doesn't depend on it either (see the
 *  module comment above) — never smaller than `flatEventBytes` (turning the
 *  diagnostic on must never shrink the allowance) and never larger than
 *  MAX_PROBABILITY_EVENT_BYTES. `alternatives` is kept as a parameter
 *  purely to decide *whether* a request asked for probabilities at all;
 *  its numeric value plays no part in the arithmetic. */
export function maxSseEventBytesFor(
  maxTokens: number,
  alternatives: number | null,
  flatEventBytes: number
): number {
  if (alternatives === null) return flatEventBytes;
  const derived = maxTokens * PER_TOKEN_BYTES + PROBABILITY_EVENT_ENVELOPE_BYTES;
  return Math.min(MAX_PROBABILITY_EVENT_BYTES, Math.max(flatEventBytes, derived));
}
