---
summary: The move from NovelAI to 1667, with the concept map, import commands, privacy model, and model access limit
read_when:
  - moving a story, a scenario, or a Lorebook from NovelAI
  - answering a question about NovelAI parity
  - changing NovelAI import or export
---

# Move from NovelAI

The published guide is at
[1667.ai/docs/move-from-novelai](https://1667.ai/docs/move-from-novelai).

This guide moves your NovelAI work into 1667. It maps each NovelAI concept to
its 1667 equivalent. It shows the import commands and the
[Fidelity Report](technical-terms.md). It states where your data lives. It also
states the model access limit.

## The concept map

| NovelAI | 1667 | What changes |
| --- | --- | --- |
| Memory | An `always` Fact | Import gives the Fact the `memory` tag |
| Lorebook Entry | A Fact | Entry keys and activation become Fact settings |
| Author's Note | Author's Note | The text imports; the position resets to the default depth |
| Retry | Take | Each generation makes one take |
| Sampler Preset | Generation Profile | Supported sampling values become Profile settings |
| `.story` file | Story | One file becomes one story |
| `.scenario` file | Story | The prompt becomes the first story parts |

A [Fact](technical-terms.md) is one note that 1667 sends with a provider
request. An `always` Fact is in each continuation request and rewrite request.
A `keyed` Fact enters the request when the story text matches one of its keys.
1667 matches keys without case differences.

Import turns each Lorebook Entry into one Fact through the
[Entry Mapping](technical-terms.md). Its text becomes the Fact text, and its
keys become the Fact keys. An always-on entry arrives as an `always` Fact. A
disabled entry does not import.

A keyed Fact can use literal or restricted regex keys. It can also use
secondary keys with AND or NOT logic. Scan depth and chain activation control
how far 1667 searches for a match.

The Author's Note keeps its name. 1667 sends it near the end of each
continuation request and prompted retake request. Import reads the note text.
It does not read the NovelAI placement. The imported note lands at the default
[Author's Note depth](technical-terms.md): immediately before the last story
part. Change the depth in the Author's Note editor.

A NovelAI retry maps to a [take](technical-terms.md). A take is one
alternative version of a story part. 1667 keeps each take, and the mass map
shows all of them. Import reads the retry history from a `.story` file. Each
retry becomes a take. The take you had open in NovelAI becomes the selected
story line.

Import does not read NovelAI's own generation settings. The
Fidelity Report states this omission.

Import keeps a retry only when it is a plain new take. A plain new take is a
fresh piece of prose that follows an existing story part or an earlier
retry. Import drops a retry that edits or removes prose already in the story
line. It states the dropped count in the Fidelity Report. A dropped retry
never changes the selected story line, which import always reads in full.

Import reads retry history from the current NovelAI Document format. It also
reads the `datablocks` history from the legacy story format. A legacy retry
must start after a complete imported story part. Import drops a legacy retry
that starts inside one story part. This rule prevents the import from changing
or omitting shared prose.

## Before you start

Export your work from NovelAI first: each story as a `.story` file, and each
Lorebook as a `.lorebook` file.

Then make a 1667 project:

```
1667 init
```

## Import a story or a scenario

Give each `.story` or `.scenario` file to `1667 import`:

```
1667 import alderaan.story
```

The command makes one new story for each file. It does not write to the file
that it reads. It prints one line for each file:

```
alderaan.story: imported "Alderaan" (312 parts, 24 facts) as st1_...
```

The last value is the story ID. Use it to open the story:

```
1667 --story st1_...
```

A `.story` file is a [Container](technical-terms.md). It carries the prose,
the embedded Lorebook, the Memory, and the Author's Note. Import keeps all
four. The Memory becomes one `always` Fact with the `memory` tag. Each
Lorebook Entry becomes one Fact. The Author's Note text stays the Author's
Note.

A `.scenario` file carries a prompt in place of prose. The prompt becomes the
first story parts. The Memory, the Author's Note, and the Lorebook import the
same way.

Import reads Scenario versions 0, 1, and 3. It reads NovelAI Lorebook
versions 1, 3, 4, and 6. An unknown version is refused so that the import does
not guess at a changed file shape.

You can give more than one file. If the command cannot read one file, it
continues with the other files. It prints each failure and exits with an error
status.

## Import a Lorebook

`1667 import-lorebook` adds Facts to a story that already exists. It does not
make a new story, so `--story` is necessary:

```
1667 import-lorebook --story "Alderaan" world.lorebook
```

The command prints one line for each file:

```
world.lorebook: imported 12 facts into "Alderaan"
```

The command reads a `.lorebook` file as JSON or inside a PNG. It reads the
file content to find the format. It does not use the file name.

The PNG reader accepts uncompressed `tEXt` metadata with the `naidata` key.
If a PNG has no archive metadata, the import reports `no lorebook data in this PNG · export the lorebook again from NovelAI`. It does not inspect image pixels or another hidden encoding.

The command palette command `import archive` does the same for the open story.
It also reads `.story` and `.scenario` files.

## The Fidelity Report

An import can change or omit data. The Fidelity Report names each change and
each omission. The import commands print the report to standard error, one
line for each file.

Each `.story` import reports its retry takes and its one fixed omission:

```
alderaan.story: 3 retries imported as unselected takes; generation settings omitted
```

Each `.scenario` import reports the part count, the literal `${…}`
placeholders, and its own omissions:

```
mira.scenario: 3 prose parts; ${…} placeholders kept literally; description, placeholder metadata, tags, context defaults, bias groups, and generation settings omitted
```

Each Lorebook import reports the entry count, the Fact count, and the omitted
NovelAI conditions:

```
world.lorebook: 14 entries read; 12 facts imported; unsupported search ranges, bias groups, and advanced conditions omitted
```

1667 does not read sampling settings from a NovelAI `.story` or `.scenario`
file. Import a NovelAI `.preset` file with `1667 profile import`. Refer to
[Generation Profile transfer](generation-profile-transfer.md).

The report adds one item, after a semicolon, for each other change that
occurred:

| Item | Meaning |
| --- | --- |
| `memory truncated to 100,000 characters` | A Fact holds a maximum of 100,000 characters |
| `2 disabled entries skipped` | A disabled Lorebook Entry does not import |
| `3 entries truncated to 100,000 characters` | The entry text was longer than one Fact holds |
| `1 entry could not be read` | The entry was not a readable record |

## Where your data lives

1667 stores your stories on your machine, in a `.1667/` directory inside a
project root that you select. Refer to [Story storage](story-storage.md).

- 1667 has no account system and no cloud storage.
- 1667 does not collect usage data.
- 1667 stores provider secrets only in the machine tier. During generation,
  it sends the selected secret only to the configured provider.
- 1667 sends your prose only to the configured provider. It sends the prose
  in the generation requests that you start, and in the token-count requests
  that keep the [context meter](technical-terms.md) exact.

The way back stays open. `1667 export --format story`, `--format scenario`,
and `--format lorebook` write NovelAI [Archives](technical-terms.md) from your
stories.

## NovelAI model access

1667 cannot send requests to NovelAI's hosted models. NovelAI's terms do not
give clear permission for a third-party client. The project closed this work as
not planned and does not intend to reopen it.

Use an OpenAI-compatible host, Anthropic, or a local model server. 1667 supports
chat and text completion protocols. The file import and export features do not
depend on NovelAI model access.

## Related documents

- [Technical terms](technical-terms.md) declares the terms this guide uses.
- [Facts, context, and model providers](model-providers.md) explains Facts,
  activation, and provider setup.
- [Story storage](story-storage.md) explains projects and storage tiers.
- [SillyTavern import](sillytavern-import.md) covers chat files.
- [Character card import](character-card-import.md) covers character cards.
