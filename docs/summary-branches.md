---
summary: Model-generated continuity summaries used as same-story context resets
read_when:
  - changing story-tree take creation or context slicing
  - changing summary prompts, budgets, or model generation
  - changing what locks or stays usable while a summary streams
  - debugging stale, truncated, or missing summary takes
---

# Summary takes

A **summary take** is a node inside the current story with `role: "summary"`.
It condenses the active line through an exact part boundary or selection and is
created as a child of that source node. Later generation starts its context at
the most recent summary node, so all earlier prose remains visible in the story
tree without being sent to the model again.

The saved instruction tells later continuations to treat the recap as
established context and resume from its final `BRANCH-POINT STATE`, without
retelling it. The prompt requests chronology and causality; character
knowledge, relationships, goals, possessions, injuries, locations, and state;
setting and world rules; objects, clues, promises, and unresolved threads; plus
point of view, tense, voice, and recurring style cues. Summary generation sends
no story facts and caps temperature at `0.2`, including when no creative
temperature is configured.

The model must return a request-specific completion marker or no take is saved.
Detection tolerates light decoration and a short trailing remark. When the
marker is missing, the provider's finish reason selects the error: output cut
by the token limit names the binding token or context constraint, while a model
that stopped on its own gets a retry message.

## Output budget

The output budget is `min(Max output tokens, 90% of the context window −
prompt)`. The requested word target scales with that budget and is capped
relative to the source (`max(250, 2× source words)`), so a short source is not
padded to thousands of words.

A prefix leaving under roughly 512 output tokens is rejected with `422` before
any model call. The fixes are an earlier summary point or continuing from an
existing summary take. Window-bound truncation therefore says to choose an
earlier point, not to increase Max output tokens.

## Consistency

The source is snapshotted before the model call. If the path already contains
a summary, the next source starts at the latest summary node, matching normal
generation's context reset. Before commit, the server fingerprints the story
title, requested point, and every source node's id and exact text. A mismatch
discards the output and saves no node. Changes outside that context slice or
strictly after the summary point do not invalidate it, so later writing remains
usable while the summary streams.

Closing or cancelling the request aborts the model call. A take is published
only after a complete response passes the marker and fingerprint guards. If a
completed take is eligible for automatic activation, the switch separately
fingerprints the complete launch line (title plus every active node id and exact
text). An edit anywhere on that line leaves the new take inactive. Cancellation
always reloads the story because a final save can win the disconnect race; an
active prose generation keeps ownership of the screen until it settles, then
the refreshed payload is adopted.

## Wire protocol

`POST /api/stories/:id/summary-take` accepts:

```json
{ "nodeId": "node-id", "offset": 123, "expected": "selected suffix" }
```

`offset` and `expected` are optional. Pre-flight failures such as an unknown
node, stale selection, or unfittable prefix are plain HTTP errors. Otherwise
the response is SSE: `delta` events while the model writes, then `done` with
`{ "nodeId": "new-summary-node-id" }`, or a terminal `error` event.

## UI and mutation rules

Entry points are the summary action on every non-summary part and **Summary
take** in the selection popover. Only one summary runs at a time. The header
shows live word progress and Cancel.

Only the summarized prefix, title, and autoname lock while generation runs.
The composer and later parts remain usable. An empty Continue that would append
into the summarized leaf starts a new part instead. Story Map keeps switching,
tagging, and unrelated pruning available, but disables pruning any take
whose subtree contains the summary source.

The server always publishes the finished summary without changing the active
line. Completion at the current leaf extends the current line only when the
client confirms that the reader is still on the same idle story and an atomic
leaf-id plus leaf-text-hash check proves the launch line has not changed.
Completion from an earlier point follows the same guard, then switches to the
alternative continuation. The `u` key does not take back this switch: it takes
back an added or removed chapter break only. If the reader moved stories or
lines, wrote into that leaf, or another generation is active, the result is
retained and announced instead of stealing focus.

A summary take renders as a teal recap card. It can be edited in place,
selection-rewritten, deleted with its subtree, tagged, or continued from.
It cannot itself be regenerated or appended into; Continue always creates a
new child node after it.
