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
 * A second review pass found the first cut of this check proved too little:
 * it only looked at `delta.content`/`delta.reasoning_content`, so an
 * oversized event with an empty `delta` but a real `finish_reason` (a
 * truncation, a length cutoff) or a provider `error` field could still be
 * discarded — silently hiding terminal state behind a later `[DONE]` that
 * lets the take commit as if the generation had simply finished cleanly.
 * `prefixProvesSafeToDiscard` below now also requires the prefix to show no
 * such state, not just no prose.
 *
 * INSPECTION_PREFIX_CHARS bounds how much of an oversized event's raw text
 * BoundedProviderSseParser keeps around (see its `inspectionPrefix` field)
 * so `decideOversizedEvent` there can positively identify "this event
 * carries no prose and no terminal/error state" before ever discarding it.
 * Real streams put the small fields (`delta`, `finish_reason`) before a
 * large `logprobs` payload — KoboldCpp's own shape (issue #107 review) is
 * `{"id":…,"choices":[{"index":0,"finish_reason":null,"delta":{"role":
 * "assistant","content":""},"logprobs":{…` — so 8 KiB is generous headroom
 * over any of those fields alone, while staying a rounding error next to
 * the megabyte-scale budgets provider-sse.ts already works with.
 */
export const INSPECTION_PREFIX_CHARS = 8 * 1024;

/** A positive proof only, never a guess: "this bounded prefix shows the
 *  event carries no prose (or reasoning text) and no terminal or error
 *  state". Anything short of that resolves to "not proven", the default
 *  this function fails closed to — the caller (BoundedProviderSseParser's
 *  decideOversizedEvent) throws the same loud failure as before whenever
 *  this returns false:
 *
 *   - `delta` not found at all within the prefix (it may be truncated, or
 *     `logprobs` may have been sent first and pushed `delta` past the
 *     cutoff);
 *   - a `delta` object with nested braces (tool_calls, ...) this
 *     deliberately narrow scan doesn't attempt to parse;
 *   - a non-empty `content`/`reasoning_content` value inside `delta`;
 *   - a `finish_reason` present with any value other than `null` (KoboldCpp
 *     itself sends `"finish_reason":null` on the probability-only event
 *     this issue is about — a real reason means the generation actually
 *     ended here, and that must not be hidden);
 *   - a `finish_reason` key whose value this scan doesn't recognize as
 *     `null` or a JSON string (fails closed rather than guessing what an
 *     unrecognized shape means);
 *   - an `error` key anywhere in the prefix.
 *
 *  Deliberately not a JSON.parse: `prefix` is a fixed-size slice of a much
 *  larger, likely still-incomplete event and is not valid JSON on its own —
 *  this is a targeted text scan, not a decode. The finish_reason and error
 *  checks scan the whole prefix rather than staying scoped to the same
 *  choice object as `delta`: a broader scan can only find MORE reasons to
 *  fail closed, never fewer, which is the safe direction for a positive
 *  proof to err in. */
export function prefixProvesSafeToDiscard(prefix: string): boolean {
  // Scoped to the FIRST "delta": object, and only matches when that object
  // closes without any nested "{"/"}" inside it. Real delta objects (role,
  // content, reasoning_content) are flat, so anything this scan doesn't
  // recognize simply fails to match and falls through to "not proven".
  const deltaMatch = /"delta"\s*:\s*\{([^{}]*)\}/u.exec(prefix);
  if (deltaMatch === null) return false;
  const deltaBody = deltaMatch[1]!;
  if (hasNonEmptyStringField(deltaBody, "content")) return false;
  if (hasNonEmptyStringField(deltaBody, "reasoning_content")) return false;
  if (hasBlockingFinishReason(prefix)) return false;
  if (hasErrorField(prefix)) return false;
  return true;
}

function hasNonEmptyStringField(object: string, key: "content" | "reasoning_content"): boolean {
  const pattern = key === "content"
    ? /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/u
    : /"reasoning_content"\s*:\s*"((?:[^"\\]|\\.)*)"/u;
  const match = pattern.exec(object);
  return match !== null && match[1]!.length > 0;
}

/** `finish_reason` is "blocking" (refuses the discard) unless it is
 *  provably absent or explicitly `null`. A recognized value (`null` or a
 *  JSON string) decides directly; a `"finish_reason"` key present with any
 *  other shape (a value this narrow scan doesn't recognize) is treated as
 *  blocking too, rather than assumed harmless — the key being present at
 *  all is reason enough to fail closed when its value is unclear. */
function hasBlockingFinishReason(prefix: string): boolean {
  const match = /"finish_reason"\s*:\s*(null|"(?:[^"\\]|\\.)*")/u.exec(prefix);
  if (match !== null) return match[1] !== "null";
  return /"finish_reason"\s*:/u.test(prefix);
}

function hasErrorField(prefix: string): boolean {
  return /"error"\s*:/u.test(prefix);
}
