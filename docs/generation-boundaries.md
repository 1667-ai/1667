---
summary: Exact-seam protocols for Continue and highlighted rewrites
read_when:
  - changing continuation or regeneration prompts
  - adding a model provider
  - changing generation idempotency or prompt-cache lowering
  - debugging prose that does not fit adjacent text
---

# Generation boundaries

Default Continue direction and Rewrite guidance add writer text. They do not
replace the Continue, append, or Rewrite contracts. An empty Default Continue
direction uses `Continue the story.` for a new empty Continue request. An
empty Rewrite guidance adds no request block.

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

## HTTP stream liveness

An HTTP generation sends one heartbeat comment each second while its SSE stream
stays open. A heartbeat does not change the story prose. The attached TUI stops
the HTTP generation after four seconds without stream bytes.

## Visible stream pacing

The TUI receives provider text at full transport speed. A presentation buffer
reveals the received text at small grapheme-safe steps. Slow streams stay
immediate. The buffer holds the last grapheme until the next delta or terminal
result confirms its boundary. Fast and bursty streams use an adaptive 16 ms
presentation interval.

The received text remains authoritative for Stop, deadline handling, partial
commit, and the final provider payload. Stop hides a Continue presentation at
once. A stopped Rewrite keeps its partial replacement visible until its
partial-save settlement. The TUI keeps the received text for settlement.
Before a successful result replaces the live view, the TUI starts a bounded
catch-up interval. The TUI stops the catch-up work at its deadline. The final
payload then replaces presentation text that remains.

Stop suspends visible presentation while terminal text can still arrive. If
the partial save fails, the TUI restores the stream and reveals the remaining
text in bounded recovery steps.

The same pacing rule applies to Continue, Retake, highlighted Rewrite, summary
previews, Aside answers, and visible model reasoning.

## Text Completions boundary

Text Completions converts the provider-neutral request into one text prompt.
The selected prompt format controls this conversion.

The `raw` prompt format joins message content with one blank line. It does not
add text after a final assistant message. A continuation prompt ends on the
last character of the active passage. A rewrite prompt ends on the last
character of the exact left anchor.

The `chatml` prompt format closes each complete message with `<|im_end|>`. It
does not close a final assistant message. If the request has no final assistant
message, it adds an assistant start marker.

The `server-template` prompt format uses llama.cpp `POST /apply-template`.
1667 sets `continue_final_message` for a final assistant message. The server
template keeps the assistant prefill open. This prompt format is not available
for another provider.

1667 does not select a prompt format from a model name. The writer must select
the prompt format. An existing chat connection stays a chat connection.

Text Completions does not change the rewrite right boundary. The model must
still return the exact right anchor and the request terminator. 1667 removes
this verified suffix before it saves the rewrite.

Boundary whitespace stays owned by the original selection. Only generated prose
between the verified anchors replaces the selection. By default, 1667 replaces
the selection in the current take. The story line and its later story parts
stay in place.

The writer can ask for a new take instead. The rewrite composer has a second
key for this request. It is the same key a manual edit uses to fork a take.
The new take starts next to the original take. The original take keeps its
descendant takes. The new take has none. The story line then runs through the
new take instead. For example: an opt-in rewrite in story part 12 of a
30-part story removes story parts 13 through 30 from the story line.

1667 records the range of prose that a rewrite replaced as a rewritten span
on the story part. See [Technical terms](technical-terms.md) for this term.

A writer cannot rewrite a chapter summary. A chapter summary is not part of
the active story line, so this operation cannot reach it.

## Author's Note boundary

The Author's Note is per-story steering for a continuation or a Retake. 1667
sends it again for each request.

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

The Author Brief applies to a continuation request, a Retake, a
highlighted rewrite, and an autoname request. A summary take does not use it.

All generation operations first build the provider-neutral block model in
`shared/prompt-plan.ts`. The Author Brief, facts, operation contract, and
source blocks form a stable prefix. Request text, selections, boundary tags,
and completion markers form the volatile suffix. The renderer rejects any
stable block placed after volatility begins; provider adapters and the TUI
context meter both consume the same model.

The complete v0.8.0 continuation prompt is the compatibility baseline for
local models. Keep this baseline for Continue and Retake until the [Gemma
prompt quality gate](prompt-quality-gate.md) passes. A wire-shape test does
not prove style continuity. The quality gate covers the prompt plan. It does
not cover prompt-cache or request-adapter changes. The deterministic HTTP
integration test in `test/model-connection-e2e.test.ts` protects the transport
wire for those changes.

The experimental `late-cache-stable` continuation prompt layout is optional.
The setting is off when the Generation Profile omits it. The compatibility
layout keeps the operation contract before the story history. The
`late-cache-stable` layout puts the operation-specific contract in the final
user turn. An assistant-prefill Continue sends no operation contract. It adds
a point of view and tense guard to the final user turn. The server and the TUI
request viewer resolve the layout from the active prose route.

Retake starts a new user turn. It does not use the assistant-prefill
continuation path. A Retake style regression can therefore remain after a fix
for a missing Continue contract. Issue [#176](https://github.com/1667-ai/1667/issues/176)
records the separate Continue defect.

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
same generation ID. If Keep thought is on, it also saves the thought that the
model sent before Stop. A clean timeout uses the same save behavior.
Stop hides the stream immediately. The main process gives local durable
cancellation work 2 seconds to finish. It then gives the embedded backend 10
seconds to close the provider stream and publish its terminal state. If the
operation is still active, the main process checks its status every 10 seconds.
A responsive worker keeps the operation until it publishes a terminal state.
The main process stops the embedded backend only if the worker does not answer
a status check.
After the Stop aborts the request signal, the worker transport sends no more
live text to the caller. The transport collects the text that arrives after
the abort. The transport delivers the collected text one time, at terminal
settlement, on the stopped-text channel. Thus, the Stop save keeps all text
that arrived from the embedded backend.
A request deadline can end a stream while the worker holds text that it did
not post. The worker reclaims that text the same way a Stop does. The worker
posts the reclaimed text in bounded delta messages before the error terminal.
The TUI adds that text to the streamed text before it processes the failure.
The failure keeps its error result. An unknown mutation result stays unknown.
A provider failure cannot write the local story. 1667 records
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

Provider request bodies are built by exact OpenAI Chat Completions, Text
Completions, and Anthropic Messages serializers. The selected cache policy
and capability use an exact protocol and preset identity. A native Text
Completions adapter is selected only with its provider choice. A port does not
select it. `StoryService` owns bounded, hash-only rolling breakpoint state.
Each generation reads its settings and cache context from one route snapshot.
Anthropic uses explicit stable-block controls; declared
legacy OpenAI Chat models use automatic caching with a stable key; declared
newer OpenAI Chat models use explicit mode with exact-token-qualified stable
breakpoints. Unsupported policies fail before provider work and are never
silently downgraded.

Regression coverage lives in `test/generation-prompts.test.ts` for prompt/filter
mechanics, `test/prompt-plan.test.ts` for exact wire and stable-prefix ownership,
`test/provider-request-body.test.ts` for exact provider bodies, and
`test/text-completion-e2e.test.ts` for Text Completions paths and boundaries,
`test/prompt-cache-breakpoints.test.ts` for exact token and rolling-state rules,
and `test/generation-http.test.ts` for admission, OpenAI-compatible wire
payloads, and saved story text.

## Phrase bias and banned strings boundary

A story can set its own phrase bias list and its own banned strings list.
Each list adds to the routed profile's own list. A story list does not
replace the profile's list.

1667 merges every list in one fixed order. The profile's phrase bias list
comes first. The profile's banned strings list comes next. The profile's
numeric logit-bias list comes next. The story's phrase bias list comes
next. The story's banned strings list comes last.

A story entry and a profile entry can name the same token. When they set
different weights for that token, the story entry wins. The story entry
wins because every story list comes after every profile list in the merge
order. 1667 does not block the request in this case. 1667 does not report
an error. 1667 shows the profile entry as overridden by the story.

Two profile entries can also name the same token. Two story entries can
also name the same token. When two entries from the same side set
different weights for a token, 1667 blocks the request. This is the same
rule 1667 already applies to two conflicting profile entries.

1667 still blocks the request when a third entry from the other side names
the same token and wins it. For example, two profile entries conflict on a
token, and a story entry also names that token and wins it. 1667 blocks the
request for the losing profile entry.

1667 checks the block on the same side only. It does not check the block
against whichever entry wins the token overall. In the example, 1667 checks
whether another profile entry took the token from the losing profile entry.
The story entry does not count for this check, because it is on the other
side. 1667 blocks the request because the other profile entry took the
token, and the block message names that profile entry, not the story entry.

Which entry wins a token decides what 1667 sends. It does not decide whether
1667 blocks the request, and it does not decide which entry the block
message names.

`server/sampling-phrase-bias.ts` holds the merge order.
`resolveSamplingLogitBias` resolves the profile's entries and the story's
entries into one merged token map, in the fixed order above. The provider
request and the editor preview both call this same function, so they cannot
compute different token IDs for the same story and profile.

The capability matrix stays the only source for phrase-bias and
banned-string availability. A story list cannot make phrase bias available
on a preset or a model that does not support it. A dry-run connection
supports no sampling parameter at all. A dry-run request refuses when the
profile or the story has phrase bias or banned strings set. A dry-run
request with neither set still generates.

Phrase bias and banned strings apply to a continuation request, a Retake, a
highlighted rewrite, and an autoname request. A summary take does
not use them.

## Aside boundary

Aside is a separate question-and-answer operation. It uses the `utility`
Generation Profile. It does not send the Author Brief, the Author's Note,
story phrase bias, or banned strings.

Side Notes never enter Write prompts. Only the Aside prompt builder may read
Side Note text. Continue, Direct, Retake, Rewrite, title, and summary
builders cannot read Side Notes.

An Aside session uses the story line through its anchored take. An unanchored
session uses the active story line. The Aside prompt includes the questions
and answers from the current session. It does not include a stored Thought.
1667 can show a stored Thought in Aside, but it cannot send that Thought in a
later request.
