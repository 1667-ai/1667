/**
 * Issue #127: prefill computes the KV cache for every prompt token before a
 * single output token exists, so the connection is silent while it runs —
 * no header, no partial event, nothing `provider-sse.ts` can watch for. Its
 * cost scales with prompt size, not with anything the server can report in
 * advance. A flat deadline (120 s by default,
 * shared/settings-provider-defaults.ts) cannot tell a server doing minutes
 * of legitimate prefill on a large context from one that will never answer,
 * and a large context on modest hardware crosses it easily.
 *
 * Prefill can finish before or after the response headers arrive — which
 * side of that flush it lands on is a provider/server implementation
 * detail this program has no way to see — so `provider-sse.ts` applies this
 * derivation to both the response-header phase and the first-token phase.
 * The justification is identical on both: neither phase can distinguish
 * "still prefilling" from "dead", and both need the same scaled patience.
 *
 * This module derives an effective deadline from the one thing
 * `provider-sse.ts` already has at both call sites: the byte length of the
 * serialized request body it is about to send. That is a proxy for prompt
 * size, not an exact measure of it — the body also carries the model name,
 * sampling parameters, and protocol wrapping — but for any request whose
 * prompt is large enough to matter, prompt content dominates the body, and a
 * proxy the transport layer can compute without knowing any provider's
 * message shape is exactly what a generic SSE layer needs.
 *
 * Deliberately not a stored `"auto"` setting: `firstTokenMs` and
 * `responseHeaderMs` are required `number`s in `ConnectionTimeoutsV2`
 * (shared/settings-v2-types.ts), a closed shape on the wire, and a string
 * value there would be a breaking schema change (issue #127's brief).
 * Instead, the configured value is a floor, always extended by a derived
 * allowance:
 *
 *   effective = max(configuredMs, min(totalMs, requestBodyBytes * PER_BYTE_ALLOWANCE_MS))
 *
 * There is no separate additive baseline term: the configured value already
 * *is* the baseline — "a floor, always extended" — so adding another fixed
 * constant on top would just double-count generosity the floor and the rate
 * below already provide. A zero-byte body therefore returns exactly the
 * configured value, unchanged from today's flat constant.
 *
 * PER_BYTE_ALLOWANCE_MS multiplies two pessimistic assumptions, and both have
 * to be floors or the product is not one.
 *
 * Prefill on modest hardware running a large model runs on the order of 20
 * tokens/second. That is the first floor.
 *
 * The second is bytes per token, and it took three tries to state correctly.
 * 4 bytes/token went in first — the figure for common tokenizers on English
 * prose. That is an average, not a bound: denser input carries more tokens in
 * the same bytes, so the request is granted less time than its real token
 * count needs, which is the abort this module exists to prevent. 3 (CJK) and
 * then 2 were tried next, and each was the same mistake with a smaller
 * number: an observation about typical text, presented as a floor.
 *
 * 1 byte/token is the floor, and unlike the others it is not an estimate at
 * all. A token is produced from at least one byte of input, so no tokenizer
 * on any text can put more than `n` tokens in `n` bytes. A byte-level
 * fallback on unmerged input approaches exactly that. Nothing can go under
 * it, which is what makes it the bound the other three only claimed to be.
 *
 * So 20 tokens/second * 1 byte/token = 20 bytes/second, and inverted,
 * 1,000 ms / 20 bytes = 50 ms of additional deadline per byte of request
 * body.
 *
 * This is deliberately generous, and for a large prompt the derived value
 * simply reaches `totalMs` and clamps there. That is the honest end state
 * rather than a defect: once a prompt is big enough that prefill could run
 * for the whole request budget, there is no information left that would let
 * this program call the connection dead any earlier, and the total deadline —
 * which the writer configures, and which has been running since the request
 * began — is the one bound that still means something.
 *
 * The ceiling on the derived allowance is the connection's own `totalMs`,
 * not a fixed constant. A separate fixed ceiling was tried first (15
 * minutes) and was wrong on two counts, caught in review: the arithmetic
 * claimed it covered "roughly 4.3 MB of request body", but at 12.5 ms/byte,
 * 900,000 ms covers 900,000 / 12.5 = 72,000 bytes — 70 KiB, not 4.3 MB, off
 * by about 60x; and 70 KiB is small enough that an ordinary 32k-token
 * context (roughly 128 KiB of request body) derives past it and gets cut
 * short, which is exactly the failure issue #127 exists to fix. A first-token
 * deadline longer than the total deadline is meaningless regardless of its
 * exact value, though: the total timer (already running independently from
 * the start of the request, see providerSseEvents) fires first either way
 * and reports the real reason. Using `totalMs` itself as the ceiling removes
 * the arbitrary constant, stays configurable through the same **total** row
 * issue #127 also exposed in Settings, and never binds on a context this
 * program supports before the total deadline already would have.
 *
 * The error this module can make is asymmetric, and the constants above lean
 * into that on purpose: a deadline that is too long only delays reporting a
 * server that was never going to answer, while one that is too short
 * destroys minutes of legitimate prefill the server was still doing. Every
 * constant here — the pessimistic 20 bytes/second, the totalMs-based
 * ceiling — errs toward waiting longer, not toward failing fast.
 */
const PER_BYTE_ALLOWANCE_MS = 1_000 / 20;

/** The effective deadline for a phase that can overlap prefill — the
 *  response-header phase or the first-token phase, both called with this
 *  same function from provider-sse.ts — extended by a per-byte allowance
 *  derived from the serialized request body's size. See the module comment
 *  for the arithmetic.
 *
 *  The ceiling (`totalMs`, the connection's own total deadline) bounds the
 *  **derived** allowance only, never the configured value. A writer may set
 *  `firstTokenMs` or `responseHeaderMs` as high as `MAX_SETTINGS_TIMEOUT_MS`
 *  (server/settings-v2-scalars.ts, 24 hours) — including higher than
 *  `totalMs` itself, the same as before this module existed — and that
 *  value is always honoured exactly. Clamping the result as a whole would
 *  shorten such a setting, contradicting "the configured value is a floor"
 *  above. The ceiling exists only to stop *automatic* growth on an enormous
 *  prompt from hiding a dead server. */
export function prefillPhaseDeadlineMsFor(
  configuredMs: number,
  requestBodyBytes: number,
  totalMs: number,
  /** Injectable only so a test can watch a phase deadline fire without
   *  waiting the real allowance out — the same reason
   *  `countPromptTokens` takes its own clock (server/tokenize-probe.ts). At
   *  the real rate a phase deadline on any lifelike request body is tens of
   *  seconds, which is correct in production and unusable in a suite. No
   *  production caller passes this. */
  msPerByte: number = PER_BYTE_ALLOWANCE_MS
): number {
  const derived = requestBodyBytes * msPerByte;
  return Math.max(configuredMs, Math.min(totalMs, derived));
}
