/**
 * Structural-review finding on issue #107's first cut: `discardOversizedEvents`
 * (server/provider-sse.ts's BoundedProviderSseParser) was request-wide, so
 * ANY oversized event was dropped once a request had asked for
 * probabilities — but an OpenAI-compatible event can carry `delta.content`
 * (prose), `logprobs`, and finish/error fields together. A mixed event over
 * budget would have been discarded whole, silently losing prose or terminal
 * state — a quieter, worse failure than the loud one this issue set out to
 * fix. This module is the positive check that closes that gap, split out of
 * server/provider-sse.ts to keep that file's HTTP/SSE mechanics under the
 * repository's file-size guideline.
 *
 * INSPECTION_PREFIX_CHARS bounds how much of an oversized event's raw text
 * BoundedProviderSseParser keeps around (see its `inspectionPrefix` field)
 * so `decideOversizedEvent` there can positively identify "this event
 * carries no prose" before ever discarding it. Real streams put the small
 * fields (`delta`, `finish_reason`) before a large `logprobs` payload —
 * KoboldCpp's own shape (issue #107 review) is
 * `{"id":…,"choices":[{"index":0,"finish_reason":null,"delta":{"role":
 * "assistant","content":""},"logprobs":{…` — so 8 KiB is generous headroom
 * over any of those fields alone, while staying a rounding error next to
 * the megabyte-scale budgets provider-sse.ts already works with.
 */
export const INSPECTION_PREFIX_CHARS = 8 * 1024;

/** A positive proof only, never a guess: "this bounded prefix shows the
 *  event carries no prose (or reasoning text)". Anything short of that —
 *  `delta` not found at all within the prefix (it may be truncated, or
 *  `logprobs` may have been sent first and pushed `delta` past the cutoff),
 *  a `delta` object with nested braces (tool_calls, ...) this deliberately
 *  narrow scan doesn't attempt to parse, or a non-empty `content`/
 *  `reasoning_content` value — resolves to "not proven", the default this
 *  function fails closed to. The caller (BoundedProviderSseParser's
 *  decideOversizedEvent) throws the same loud failure as before whenever
 *  this returns false.
 *
 *  Deliberately not a JSON.parse: `prefix` is a fixed-size slice of a much
 *  larger, likely still-incomplete event and is not valid JSON on its own —
 *  this is a targeted text scan, not a decode. */
export function prefixProvesNoProse(prefix: string): boolean {
  // Scoped to the FIRST "delta": object, and only matches when that object
  // closes without any nested "{"/"}" inside it. Real delta objects (role,
  // content, reasoning_content) are flat, so anything this scan doesn't
  // recognize simply fails to match and falls through to "not proven".
  const deltaMatch = /"delta"\s*:\s*\{([^{}]*)\}/u.exec(prefix);
  if (deltaMatch === null) return false;
  const deltaBody = deltaMatch[1]!;
  return !hasNonEmptyStringField(deltaBody, "content")
    && !hasNonEmptyStringField(deltaBody, "reasoning_content");
}

function hasNonEmptyStringField(object: string, key: "content" | "reasoning_content"): boolean {
  const pattern = key === "content"
    ? /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/u
    : /"reasoning_content"\s*:\s*"((?:[^"\\]|\\.)*)"/u;
  const match = pattern.exec(object);
  return match !== null && match[1]!.length > 0;
}
