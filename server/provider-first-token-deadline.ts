/**
 * Issue #127: prefill computes the KV cache for every prompt token before a
 * single output token exists, so the stream sends nothing at all while it
 * runs. Its cost scales with prompt size, not with anything the server can
 * report in advance — there is no header, no partial event, nothing
 * `provider-sse.ts` can watch for. A flat `firstTokenMs` (120 s by default,
 * shared/settings-provider-defaults.ts) cannot tell a server doing minutes of
 * legitimate prefill on a large context from one that will never answer, and
 * a large context on modest hardware crosses it easily.
 *
 * This module derives an effective deadline from the one thing
 * `provider-sse.ts` already has at the call site: the byte length of the
 * serialized request body it is about to send. That is a proxy for prompt
 * size, not an exact measure of it — the body also carries the model name,
 * sampling parameters, and protocol wrapping — but for any request whose
 * prompt is large enough to matter, prompt content dominates the body, and a
 * proxy the transport layer can compute without knowing any provider's
 * message shape is exactly what a generic SSE layer needs.
 *
 * Deliberately not a stored `"auto"` setting: `firstTokenMs` is a required
 * `number` in `ConnectionTimeoutsV2` (shared/settings-v2-types.ts), a closed
 * shape on the wire, and a string value there would be a breaking schema
 * change (issue #127's brief). Instead, the configured value is a floor,
 * always extended by a derived allowance:
 *
 *   effective = min(CEILING_MS, max(configuredMs, requestBodyBytes * PER_BYTE_ALLOWANCE_MS))
 *
 * There is no separate additive baseline term: the configured value already
 * *is* the baseline — "a floor, always extended" — so adding another fixed
 * constant on top would just double-count generosity the floor and the rate
 * below already provide. A zero-byte body therefore returns exactly the
 * configured value, unchanged from today's flat constant.
 *
 * PER_BYTE_ALLOWANCE_MS: prefill on modest hardware running a large model
 * runs on the order of 20 tokens/second, and prompt text is roughly 4 bytes
 * per token for common tokenizers on English prose, so 20 * 4 = 80 bytes/
 * second is a defensible pessimistic floor for prefill throughput. Inverted
 * to a per-byte allowance: 1,000 ms / 80 bytes = 12.5 ms of additional
 * deadline per byte of request body.
 *
 * CEILING_MS: a ceiling is required so a genuinely dead server is still
 * reported eventually rather than the deadline growing without bound on an
 * enormous prompt. It must stay below `totalMs`'s own default (30 minutes,
 * NETWORK_CONNECTION_TIMEOUTS.totalMs in
 * shared/settings-provider-defaults.ts) or the total deadline would fire
 * first and report the wrong reason. 15 minutes is half of that: generous
 * enough for a very large prompt on slow hardware at the rate above (a 15
 * minute allowance covers roughly 4.3 MB of request body — a prompt far
 * larger than any context window this program supports), while leaving room
 * below `totalMs` for whatever the first token then takes to actually
 * generate.
 *
 * The error this module can make is asymmetric, and the constants above lean
 * into that on purpose: a deadline that is too long only delays reporting a
 * server that was never going to answer, while one that is too short
 * destroys minutes of legitimate prefill the server was still doing. Every
 * constant here — the pessimistic 80 bytes/second, the 15 minute ceiling —
 * errs toward waiting longer, not toward failing fast.
 */
const PER_BYTE_ALLOWANCE_MS = 1_000 / 80;

/** See the module comment: half of `totalMs`'s own 30 minute default, with
 *  headroom below it for the generation that follows the first token. */
export const FIRST_TOKEN_DEADLINE_CEILING_MS = 15 * 60 * 1_000;

/** The effective first-token deadline for one request: the configured value,
 *  extended by a per-byte allowance derived from the serialized request
 *  body's size. See the module comment for the arithmetic.
 *
 *  The ceiling bounds the **derived** allowance only, never the configured
 *  value. A writer may set `firstTokenMs` as high as
 *  `MAX_SETTINGS_TIMEOUT_MS` (server/settings-v2-scalars.ts, 24 hours), and
 *  before this module existed that value was honoured exactly. Clamping the
 *  result as a whole would shorten such a setting — a 20 minute deadline
 *  would come back as 15 — which both contradicts "the configured value is a
 *  floor" above and would abort generations that used to succeed. The
 *  ceiling exists to stop *automatic* growth on an enormous prompt from
 *  hiding a dead server, and that is the only thing it bounds. */
export function firstTokenDeadlineMsFor(
  configuredMs: number,
  requestBodyBytes: number
): number {
  const derived = requestBodyBytes * PER_BYTE_ALLOWANCE_MS;
  return Math.max(configuredMs, Math.min(FIRST_TOKEN_DEADLINE_CEILING_MS, derived));
}
