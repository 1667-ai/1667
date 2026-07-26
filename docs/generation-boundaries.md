---
summary: Exact-seam protocols for Continue and highlighted rewrites
read_when:
  - changing continuation or regeneration prompts
  - adding a model provider
  - changing generation idempotency or prompt-cache lowering
  - debugging prose that does not fit adjacent text
---

# Generation boundaries

Empty Continue is not a new user turn. On providers that support assistant
prefill, the active passage remains the final assistant message so generation
begins after its last character. Providers known to reject prefills receive a
short exact left-boundary echo contract; 1667 verifies and removes the
echo before saving.

A highlighted rewrite is an infill operation with two constraints. The request
prefills or echoes a short exact left anchor, then requires the model to reproduce
a short exact right anchor followed by a request-specific terminator. Streaming
withholds that suffix. A missing required anchor rejects the generation and keeps
the original passage unchanged.

Boundary whitespace stays owned by the original selection. Only generated prose
between the verified anchors is spliced into the active take in place.

All generation operations first build the provider-neutral block model in
`shared/prompt-plan.ts`. Author brief, facts, operation contract, and source
blocks form a stable prefix. Request text, selections, boundary tags, and
completion markers form the volatile suffix. The renderer rejects any stable
block placed after volatility begins; provider adapters and the TUI context
meter both consume the same model.

Continuation admission is owned by `StoryService` and keyed by the exact
`(storyId, genId)` tuple. A committed ID returns the stored story before
settings or provider work. A duplicate while the first call is still active is
rejected with `409 resource_busy`; success, failure, and cancellation all
release the process-local claim. The final commit remains an independent
idempotency boundary for recovery.

Receipt-backed generation uses three short story claims: admission, durable
provider start, and terminal publication. Provider preparation and streaming
hold no story claim, so local edits remain available throughout the round-trip.
The provider-start record advances durable revision metadata before the stream
can return it; a local edit may therefore present only the exact content
version recorded by the active phase immediately before that current started
record. Version kind and value must both match; any intervening local revision
still conflicts normally.
The admitted snapshot's immutable revision graph remains pinned until that
round-trip ends, so concurrent cleanup cannot invalidate lazy source hydration.
Terminal publication applies an operation-specific effect to the current story:
manual renames beat autoname, rewrites and summaries revalidate their source,
continuations preserve a line moved by the writer, and a Stop save wins by
generation ID. An ambiguous provider result retains the durable unresolved
pointer; retries stay blocked until that exact outcome is acknowledged.

Provider request bodies are built by exact OpenAI Chat Completions and Anthropic
Messages serializers. The selected ADR 003 cache policy and capability project
through an exact protocol/preset adapter identity; a custom endpoint is never
promoted from its URL. `StoryService` owns bounded, hash-only rolling
breakpoint state and each generation reads its settings plus cache context from
one route snapshot. Anthropic uses explicit stable-block controls; declared
legacy OpenAI Chat models use automatic caching with a stable key; declared
newer OpenAI Chat models use explicit mode with exact-token-qualified stable
breakpoints. Unsupported policies fail before provider work and are never
silently downgraded.

Regression coverage lives in `test/generation-prompts.test.ts` for prompt/filter
mechanics, `test/prompt-plan.test.ts` for exact wire and stable-prefix ownership,
`test/provider-request-body.test.ts` for exact provider bodies, and
`test/prompt-cache-breakpoints.test.ts` for exact token and rolling-state rules,
and `test/generation-http.test.ts` for admission, OpenAI-compatible wire
payloads, and saved story text.
