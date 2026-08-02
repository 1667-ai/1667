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
between the verified anchors replaces the selection. 1667 saves the result as
a new take next to the original take. The original take keeps its
descendant takes. The new take has none. The story line then runs through
the new take instead. For example: a rewrite in story part 12 of a 30-part
story removes story parts 13 through 30 from the story line.

A writer cannot rewrite a chapter summary. A chapter summary is not part of
the active story line, so this operation cannot reach it.

## Author's Note boundary

The Author's Note is per-story steering for a continuation or a prompted
retake. 1667 sends it again for each request.

The Author's Note depth sets how many story parts from the end the note comes
before. The default depth is 1: 1667 sends the note immediately before the
last story part. A story that sets no depth keeps this default placement. A
depth larger than the number of story parts clamps: 1667 sends the note
before every part, right after the stable prefix. `shared/continuation-plan.ts`
computes the placement and reports the depth it actually used, so the request
viewer shows the real placement, not only the requested one.

Official OpenAI Chat Completions receives a late `system` message. Anthropic
Messages and OpenAI-compatible endpoints receive the fold form in the message
that follows the note, at any depth.

A highlighted rewrite does not use the Author's Note. A summary take does not
use it. The autoname operation does not use it.

## Author Brief boundary

The Author Brief is the standing `author-brief` block that opens the stable
prefix of every generation request. 1667 resolves one value for each request.
A story Author Brief wins when the story has one. The machine-wide default
Author Brief applies otherwise. `shared/author-brief.ts` holds this lookup
order. The server and the TUI request viewer both call it, so the request
viewer shows the same brief that the server sends.

The Author Brief applies to a continuation request, a prompted retake, a
highlighted rewrite, and an autoname request. A summary take does not use it.

All generation operations first build the provider-neutral block model in
`shared/prompt-plan.ts`. The Author Brief, facts, operation contract, and
source blocks form a stable prefix. Request text, selections, boundary tags,
and completion markers form the volatile suffix. The renderer rejects any
stable block placed after volatility begins; provider adapters and the TUI
context meter both consume the same model.

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
generation ID. Stop closes the provider record. If model text arrived before
Stop, the TUI waits for terminal settlement. It then saves that text with the
same generation ID. A provider failure cannot write the local story. 1667 records
the local generation as failed and accepts more work. It does not automatically
repeat the provider request. This rule also applies when the model connection
fails after it sends response headers.

The worker can report that a local result needs a saved-state check. This report
is terminal. The TUI keeps the worker available. It archives the request,
reloads the story, and then accepts a new request.
If a newer request finds an older provider-start record, recovery uses the
record that the story identifies. It does not use the newer request ID. Thus,
recovery removes the story fence before the writer tries the request again.
The newer request stays pending until recovery stores the older request ID.
Thus, a process stop cannot replace the older request ID with a general error.
A request deadline cannot replace the older request ID with a general error.
Archive format 2 stores the older request ID. An older version of 1667 cannot
read this format. It stops before it can remove a different provider record.
If warning cleanup fails after recovery, 1667 keeps the recovered story result.
It retries warning cleanup in the background.
The private log records the story ID and both request IDs when recovery uses
the older record. It also records an error if it cannot close that record.

If the backend stops before terminal publication, 1667 retains the durable
provider-start record. At the next start, 1667 closes this record and reloads
the story. It does not ask the writer to close the record. It does not
automatically repeat the provider request.

Provider request bodies are built by exact OpenAI Chat Completions and Anthropic
Messages serializers. The selected cache policy and capability project
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
