---
summary: Copy the story line below one story part and paste it below another part in the same story
read_when:
  - changing story-tree copy or paste behavior
  - changing which story part fields a clone carries forward
  - debugging a stale, oversized, or misplaced paste
---

# Story line copy and paste

A writer can copy the story line below one story part and paste it below a
different story part in the same story. The copy makes a structural clone of
story parts. It does not copy plain text.

## What the copy holds

"Copy story line below" copies the active descendant path below the chosen
story part. It does not copy the story part itself. It copies every story
part on that path, in order, down to the last part.

The writer holds one copied story line at a time. The copy stays bound to
its story. It stays ready to paste until the writer copies a new story line.

## What the paste does

"Paste story line below" clones the copied story parts under the target
story part, in the same order. The paste is one atomic step: it fails whole,
or it succeeds whole. The cloned path becomes the active story line at the
target.

## Field policy

A clone carries forward the source part's prose, instruction, model name,
human-take marker, human-edit attribution, and rewritten spans. These fields
let a reader read and continue the clone on its own, the same way they could
read and continue the source.

A clone never carries the source part's generation ID or captured token
probabilities. Both name one specific generation attempt. The clone is not
that attempt. A clone never carries a chapter break or a Tag either. Both
name the *original* story part's identity and position. The paste must not
put two story parts under the same name.

A chapter summary can be neither a copy source nor a paste target. A chapter
summary is a structural dead end: no story line continues below it, and no
story part can attach below it.

## Validation

The server rejects a paste before it changes the story when:

- The source story part or the target story part is missing.
- The source story part or the target story part is a chapter summary.
- The story line below the source changed since the writer copied it.
- The copied story line has more than 5,000 story parts.
- The target story part is the source story part, or one of the source
  story part's own parts.

## Wire protocol

`POST /api/stories/:id/nodes/:nodeId/paste-line` accepts:

```json
{ "sourceNodeId": "source-part-id", "expectedLeafId": "leaf-part-id" }
```

`nodeId` in the URL names the target story part. `expectedLeafId` names the
last part of the copied story line, captured at copy time. A mismatch means
the copied story line changed since the copy, and the server answers `409`.
A successful response carries the full story payload, with `path` ending at
the new leaf.

## UI and mutation rules

"Copy story line below" and "Paste story line below" sit on the existing
story part action menu. The last story part of the active story line hides
"Copy story line below": nothing continues below it to copy. Every story
part hides "Paste story line below" until the writer copies a story line.

The client holds only the source story part's id and its story line's last
part id between the two actions. It never holds the copied prose. The paste
request re-derives and re-validates the live story line from that id, the
same way every other multi-step mutation in 1667 re-checks a captured id
against the live story instead of trusting held content.
