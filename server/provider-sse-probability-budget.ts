/**
 * Issue #107: KoboldCpp emits every token probability in one SSE event —
 * sent after all the prose, once the stream is already done — so that one
 * event grows with the whole generation rather than with one token. A flat
 * per-event byte cap doesn't know a request asked for `top_logprobs`
 * alternatives across up to `maxTokens` tokens, even though that payload is
 * exactly what was requested on purpose. This module sizes the per-event
 * allowance to what was actually asked for instead — split out of
 * server/provider-sse.ts to keep that file's HTTP/SSE mechanics under the
 * repository's file-size guideline.
 *
 * Issue #107's measured table, a realistic KoboldCpp-shaped
 * `choices[0].logprobs.content` payload:
 *
 *   tokens   alts   event size   bytes / (token * alt)
 *    1,000     10     0.80 MiB   83.9
 *    1,600      5     0.71 MiB   93.1
 *    2,048     10     1.65 MiB   84.5
 *    4,096     10     3.29 MiB   84.2
 *
 * Fitting `bytes/token = stepOverhead + alternatives * perAlternative`
 * against the alt=5 and alt=10 rows gives ~75 bytes marginal cost per
 * alternative and ~89 bytes of fixed per-step overhead (the sampled
 * token's own text, its logprob, and the surrounding JSON punctuation).
 * PER_ALTERNATIVE_BYTES and PER_STEP_OVERHEAD_BYTES below round those up by
 * roughly 1.4x so the derived allowance carries headroom over the
 * measurement (longer or unicode-heavy tokens, a more verbose field name,
 * ...) instead of tracking it exactly.
 */
const PER_ALTERNATIVE_BYTES = 128;
const PER_STEP_OVERHEAD_BYTES = 128;
/** The outer `choices[0].logprobs` JSON wrapper and the SSE `data:` framing
 *  around the payload: a small fixed cost independent of step count. */
const PROBABILITY_EVENT_ENVELOPE_BYTES = 4 * 1024;

/**
 * Absolute ceiling for a probability-carrying event, regardless of how large
 * `maxTokens * alternatives` derives it: twice
 * shared/token-probabilities.ts's MAX_TOKEN_PROBABILITY_BYTES (4 MiB)
 * stored-record cap, leaving headroom for wire overhead (JSON key
 * repetition, SSE framing) over that already-decoded shape, while staying
 * below server/provider-sse.ts's own scales for an entire response — 16 MiB
 * decoded output (provider-stream-output.ts's MAX_DECODED_OUTPUT_BYTES) and
 * its 64 MiB raw-response cap.
 */
const MAX_PROBABILITY_EVENT_BYTES = 8 * 1024 * 1024;

/** Mirrors the flat caps' own ratio in server/provider-sse.ts (2 MiB partial
 *  / 1 MiB event = 2x). A still-accumulating line needs headroom over the
 *  finished-event cap it is bounding before an event boundary is even seen,
 *  and the event queue's memory accounting doubles a UTF-16 string's length
 *  — both need the same headroom over whatever maxSseEventBytesFor resolves
 *  to, or they become the next thing to trip once a per-request budget grows
 *  past the old flat 2 MiB (issue #107's own warning: a legal, in-budget
 *  probability event would then be silently discarded by a cap that never
 *  learned the budget grew). */
export const EVENT_HEADROOM_MULTIPLIER = 2;

/** No probabilities requested: `flatEventBytes` (server/provider-sse.ts's
 *  MAX_SSE_EVENT_BYTES), unchanged. Probabilities requested: a budget
 *  proportional to what the request actually asked for, never smaller than
 *  `flatEventBytes` (turning the diagnostic on must never shrink the
 *  allowance) and never larger than MAX_PROBABILITY_EVENT_BYTES. */
export function maxSseEventBytesFor(
  maxTokens: number,
  alternatives: number | null,
  flatEventBytes: number
): number {
  if (alternatives === null) return flatEventBytes;
  const derived = maxTokens * (PER_STEP_OVERHEAD_BYTES + alternatives * PER_ALTERNATIVE_BYTES)
    + PROBABILITY_EVENT_ENVELOPE_BYTES;
  return Math.min(MAX_PROBABILITY_EVENT_BYTES, Math.max(flatEventBytes, derived));
}
