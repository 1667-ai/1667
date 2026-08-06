---
summary: The move from NovelAI to 1667, with the concept map, the import commands, the privacy model, and the open gaps
read_when:
  - moving a story, a scenario, or a Lorebook from NovelAI
  - answering a question about NovelAI parity
  - changing NovelAI import or export
---

# Move from NovelAI

This guide moves your NovelAI work into 1667. It maps each NovelAI concept to
its 1667 equivalent. It shows the import commands and the
[Fidelity Report](technical-terms.md). It states where your data lives. It also
states what 1667 does not have yet.

## The concept map

| NovelAI | 1667 | What changes |
| --- | --- | --- |
| Memory | An `always` Fact | Import gives the Fact the `memory` tag |
| Lorebook Entry | A `keyed` Fact | Entry keys become Fact keys |
| Author's Note | Author's Note | The text imports; the position resets to the default depth |
| Retry | Take | Each generation makes one take |
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

The Author's Note keeps its name. 1667 sends it near the end of each
continuation request and prompted retake request. Import reads the note text.
It does not read the NovelAI placement. The imported note lands at the default
[Author's Note depth](technical-terms.md): immediately before the last story
part. Change the depth in the Author's Note editor.

A NovelAI retry maps to a [take](technical-terms.md). A take is one
alternative version of a story part. 1667 keeps each take, and the mass map
shows all of them. Import does not read the retry history from a `.story`
file. The Fidelity Report states this omission.

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

The command palette command `import archive` does the same for the open story.
It also reads `.story` and `.scenario` files.

## The Fidelity Report

An import can change or omit data. The Fidelity Report names each change and
each omission. The import commands print the report to standard error, one
line for each file.

Each `.story` import reports this omission:

```
alderaan.story: generation settings and retry history omitted
```

Each `.scenario` import reports the part count, the literal `${…}`
placeholders, and its own omissions:

```
mira.scenario: 3 prose parts; ${…} placeholders kept literally; description, placeholder metadata, tags, context defaults, bias groups, and generation settings omitted
```

Each Lorebook import reports the entry count, the Fact count, and the omitted
NovelAI conditions:

```
world.lorebook: 14 entries read; 12 facts imported; search range, bias groups, and advanced conditions omitted
```

1667 does not read the sampling settings or the retry history from a NovelAI
file. Set the sampling parameters in Settings. Refer to
[Facts, context, and model providers](model-providers.md).

The report adds one item, after a semicolon, for each other change that
occurred:

| Item | Meaning |
| --- | --- |
| `memory truncated to 4,000 characters` | A Fact holds a maximum of 4,000 characters |
| `2 disabled entries skipped` | A disabled Lorebook Entry does not import |
| `3 entries truncated to 4,000 characters` | The entry text was longer than one Fact holds |
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

## What 1667 does not have yet

1667 does not have each NovelAI feature:

- 1667 has no NovelAI provider protocol, and none is planned. It cannot send
  requests to the NovelAI models. Use an OpenAI-compatible host, Anthropic,
  or a local server. Refer to
  [issue 286](https://github.com/1667-ai/1667-archive2/issues/286).
- 1667 does not import `.preset` files, and it ships no starter
  [Generation Profiles](technical-terms.md). Make and name your own
  Generation Profiles in Settings. Refer to
  [issue 290](https://github.com/1667-ai/1667-archive2/issues/290) and
  [Facts, context, and model providers](model-providers.md).
- A Fact key is literal text on one list. 1667 has no regex keys, no
  secondary-key logic, and no recursion. Refer to
  [issue 289](https://github.com/1667-ai/1667-archive2/issues/289).
- 1667 has no text completion protocol. Refer to
  [issue 293](https://github.com/1667-ai/1667-archive2/issues/293).

The [1667-archive2 issue list](https://github.com/1667-ai/1667-archive2/issues)
holds the roadmap for the open items.

## Related documents

- [Technical terms](technical-terms.md) declares the terms this guide uses.
- [Facts, context, and model providers](model-providers.md) explains Facts,
  activation, and provider setup.
- [Story storage](story-storage.md) explains projects and storage tiers.
- [SillyTavern import](sillytavern-import.md) covers chat files.
- [Character card import](character-card-import.md) covers character cards.
