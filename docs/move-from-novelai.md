---
summary: The move from NovelAI to 1667, with the concept map, import commands, privacy model, and model access limit
read_when:
  - moving a story, a scenario, or a Lorebook from NovelAI
  - answering a question about NovelAI parity
  - changing NovelAI import or export
---

# Move from NovelAI

[Read the published guide.](https://1667.ai/docs/move-from-novelai)

This guide shows how to import NovelAI `.story`, `.scenario`, `.lorebook`, and
`.preset` files into 1667. It explains supported transfers, import limits, data
storage, and model access.

## The concept map

| NovelAI | 1667 | What changes |
| --- | --- | --- |
| Memory | An `always` Fact | Import gives the Fact the `memory` tag |
| Lorebook Entry | A Fact | Entry keys and activation become Fact settings |
| Author's Note | Author's Note | The text imports; the position resets to the default depth |
| Retry | Take | A retry can become one take when it adds fresh prose without changing earlier prose |
| Sampler Preset | Generation Profile | Supported sampling values become Profile settings |
| `.story` file | Story | One file becomes one story |
| `.scenario` file | Story | The prompt becomes the first story parts |

A [Fact](technical-terms.md) is one note that 1667 sends with a provider
request. An `always` Fact is in each continuation request and rewrite request.
A `keyed` Fact enters the request when the story text matches one of its keys.
1667 ignores letter case for literal keys. Regex keys are case-sensitive unless
they use the `i` flag.

Import turns each Lorebook Entry into one Fact through the
[Entry Mapping](technical-terms.md). Its text becomes the Fact text, and its
keys become the Fact keys. An always-on entry arrives as an `always` Fact. A
disabled entry does not import.

A keyed Fact can use literal or restricted regex keys. It can also use
secondary keys with AND or NOT logic. Scan depth sets how many recent story
parts 1667 searches. Chain activation lets the text of an active Fact activate
other Facts.

The Author's Note keeps its name. 1667 sends it near the end of each
continuation request and prompted retake request. Import reads the note text.
It does not read the NovelAI placement. The imported note lands at the default
[Author's Note depth](technical-terms.md): immediately before the last story
part. Change the depth in the Author's Note editor.

A NovelAI retry maps to a [take](technical-terms.md). A take is one
alternative version of a story part. 1667 keeps each imported take, and the
mass map shows all of them. Import reads the retry history from a `.story`
file. The retry you had open in NovelAI becomes the selected take for its story
part.

Import does not read NovelAI's own generation settings. The
Fidelity Report states this omission.

Import keeps a retry only when it adds fresh prose after an existing story part
or an earlier retry. Import drops a retry that edits or removes prose already
in the story line. It states the dropped count in the Fidelity Report. A
dropped retry never changes the selected story line, which import always reads
in full.

Import reads retry history from the current NovelAI Document format. It also
reads the `datablocks` history from the legacy story format. A legacy retry
must start after a complete imported story part. Import drops a legacy retry
that starts inside one story part. This rule prevents the import from changing
or omitting shared prose.

Import can omit the complete retry history if replay work reaches its safety
limit. The Fidelity Report states `retry history omitted: replay work limit
reached`.

## Before you start

Export each file from NovelAI:

- In the Story tab, select **Export Story**, then **To File** for a `.story`
  file or **As Scenario** for a `.scenario` file.
- In the Lorebook, select the export button for a `.lorebook` file.
- In the Config Preset settings, select the export button for a `.preset` file.

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

Each `.story` or `.scenario` file must not exceed 20 MB. 1667 also applies
these structure limits:

- A MessagePack array or map in a current `.story` file must not exceed 50,000
  items.
- The `fragments` list in a legacy JSON `.story` file must not exceed 50,000
  items. The command refuses a file that exceeds this limit.
- If the legacy `datablocks` list exceeds 50,000 items, the selected story line
  imports without its retry history. The Fidelity Report lists the retry
  history as malformed.
- Decoded MessagePack and JSON input must not exceed 500,000 values.

The selected story line must fit within 5,000 parts and 4,000,000 UTF-16 code
units. Retry takes use the remaining capacity. If they reach either limit, the
selected story line imports without the remaining retry takes. The Fidelity
Report lists this omission.

The last value is the story ID. Use it to open the story:

```
1667 --story st1_...
```

A `.story` file is a [Container](technical-terms.md). It carries the prose,
the embedded Lorebook, the Memory, and the Author's Note. The Memory becomes
one `always` Fact with the `memory` tag. 1667 tries to turn each enabled
Lorebook Entry into one Fact. Empty or invalid text and the story's Fact limit
can prevent this transfer. Check the Fidelity Report for skipped or changed
entries. The Author's Note text stays the Author's Note.

A `.scenario` file carries a prompt in place of prose. The prompt becomes the
first story parts. The Memory, the Author's Note, and the Lorebook import the
same way.

Import reads Scenario versions 0, 1, and 3. It reads NovelAI Lorebook versions
1, 3, 4, and 6. The command refuses an unknown Scenario version or a standalone
Lorebook with an unknown version. If a story or scenario contains an unknown
Lorebook version, the prose imports without its Lorebook Facts. The Fidelity
Report names the omitted Lorebook version.

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

The Lorebook JSON must not exceed 1 MB.

The PNG reader accepts uncompressed `tEXt` metadata with the `naidata` key.
If a PNG has no archive metadata, the import reports `no lorebook data in this PNG · export the lorebook again from NovelAI`. It does not inspect image pixels or another hidden encoding.

To add a `.lorebook` or World Info JSON file to the open story, select `import
archive` in the command palette. This command does not read a PNG Lorebook. Use
`1667 import-lorebook` for that file.

The in-app command can import `.story` and `.scenario` files, but it does not
write their Fidelity Report. Use `1667 import` for these files so that you can
check the report.

## The Fidelity Report

An import can change or omit data. The Fidelity Report lists the changes and
omissions described below. It does not list Unicode normalization, line-ending
changes in prose, paragraph splitting or trimming, title whitespace trimming,
or title truncation after 4,096 Unicode characters. The import commands print
the report to standard error, one line for each file.

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
[Generation Profile transfer](generation-profile-transfer.md). A `.preset`
file must not exceed 64 KiB (65,536 bytes).

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

You can export your 1667 stories as NovelAI [Archives](technical-terms.md).
Exit 1667 first. These commands export the most recently updated story:

```
1667 export --format story
1667 export --format scenario
1667 export --format lorebook
```

Use `--story st1_...` to select a story by its ID. Use `--all` to export every
story.

These Archives are transfer files, not complete backups:

- Of the available prose branches, a `.story` or `.scenario` Archive contains
  only the selected story line. Both formats also contain Facts, Memory, and
  the Author's Note. A `.story` Archive has no retry history.
- A `.lorebook` Archive contains Facts but no prose.
- The exports can omit alternate takes, directions, summaries, chapter breaks,
  the first chapter title, tags, and Side Notes. The Fidelity Report counts
  chapter breaks but does not name a lost first chapter title.
- The exports omit Fact names. The Fidelity Report states this loss. The
  exports also omit Fact secondary keys, secondary-key mode, scan depth,
  recursion, priority, per-Fact token budgets, creation times, and source story
  part links. The Fidelity Report does not list these other losses.
- The exports omit the Facts budget, Author's Note depth, story phrase bias,
  and banned strings. Both `.story` and `.scenario` omit the Author Brief. Only
  the `.scenario` Fidelity Report names that loss. The exports also omit Image
  Attachments, thoughts, token probabilities, and Generation Records.
- For each prose part, the exports omit the model name, whether you wrote the
  part, human-edit ranges, rewritten ranges, and creation and update times. The
  exports also omit the story origin.

The export command writes a Fidelity Report to standard error. Check it for
changes and omissions. Refer to
[Story storage](story-storage.md#export-a-story) for the content and selection
rules of each format.

## NovelAI model access

1667 does not send requests to NovelAI's hosted models. The project does not
plan this integration.

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
