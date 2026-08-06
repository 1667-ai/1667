---
summary: Character card import interfaces, file formats, field mapping, and limits
read_when:
  - importing a character card from the command palette
  - importing a character card from the command line
  - changing character card conversion or limits
---

# Character card import

The TUI and command line import a character card into an existing story. The
converter turns the character fields into Facts. The entry points save the
Facts in the selected story. Both entry points use the `Character` tag.

## Import from the command palette

Open the command palette. Select `import character card`:

```
import character card
```

Type the path to a character card file. Press `Tab` to complete the path. Press
`Enter` to import the file.

The card in this example has the name `Mira`. Its `description` and
`personality` fields are not empty. Its `scenario` field is empty. The TUI
shows this status message after a successful import:

```
imported 1 fact for "Mira" · description and personality · scenario was empty
```

The TUI adds the Facts to the current story. It uses the `Character` tag.

A V3 card, or any card with a `character_book`, can carry more to report than
the status message holds. The status message then ends with `! full report`
or `full report in the log`. Open the log to read the whole Fidelity Report.

## Import from the command line

The `1667 import-card` command adds Facts to one existing story. It does not
make a new story.

Use this command:

```
1667 import-card --story "Card target" --data /path/to/project /path/to/mira.json
```

The file in this example has the name `Mira`. Its `description` and
`personality` fields are not empty. Its `scenario` field is empty. The command
prints this line:

```
/path/to/mira.json: imported 1 fact for "Mira" into "Card target" — used description, personality; skipped scenario
```

`--story` is necessary. It accepts a story ID or a story title. It has no
default. It names the story that receives the card Facts.

Use a story ID when more than one story has the same title. The command also
matches titles with any letter case.

Use `--data <path>` to select a project. Use `--global` to select the
machine-wide project. If you omit both options, the command finds the project
from the current directory or a parent directory. Do not use both options.

Give one or more files. The command processes the files in the order that you
give them. It continues after a file error. It exits with status 1 if any file
fails.

If you omit `--story`, the command prints:

```
1667: import-card requires --story, because card Facts join a story that already exists
```

The command also prints the [Fidelity Report](technical-terms.md) to standard
error, one line for each file. A plain V1 or V2 card prints
`no fidelity limitations reported`. See
[Fields the converter does not import](#fields-the-converter-does-not-import)
for what a V3 card can name there.

## Supported files

The command palette and the command line use the same converter. The converter
supports these inputs:

- Character Card V1 JSON
- Character Card V2 JSON with `spec: "chara_card_v2"` and
  `spec_version: "2.0"`
- Character Card V3 JSON with `spec: "chara_card_v3"` and a `spec_version`
  that starts with `3.` (for example `3.0` or `3.1`)
- PNG cards with V1, V2, or V3 JSON in one uncompressed `tEXt` chunk

A PNG chunk named `ccv3` holds V3 JSON. A PNG chunk named `chara` holds V1 or
V2 JSON. If a PNG has both chunks, the converter reads `ccv3` and ignores
`chara`.

The converter does not fetch URLs. It rejects an unsupported `spec_version`,
CHARX files, WebP files, compressed PNG text metadata, and ordinary images.
CHARX is a zip file; the converter has no zip reader.

## Field mapping

The `name` field is necessary. The converter reads `description`, `personality`,
and `scenario`.

The entry points use each non-empty field. They ignore empty fields.

The converter changes `{{char}}` to the character name. It changes `{{user}}`
to `the protagonist`. It changes all matches in one case-insensitive pass. It
does not scan replacement text again.

Each non-empty field becomes part of one or more Facts with the `Character` tag.
The converter ignores all other card fields, except `character_book`.

## The character_book

A V2 or V3 card can carry a `character_book`: an embedded lorebook. The
converter turns each entry into a Fact through the same
[Entry Mapping](technical-terms.md) that `1667 import-lorebook` uses.

| `character_book` entry | Fact |
| --- | --- |
| `content` | Fact text |
| `name`, or `comment` if `name` is empty | Fact tag |
| `keys` | Fact keys |
| `constant: true` | Always-active Fact |
| `enabled: false` | The entry does not import |

A `character_book` entry can ask for behavior that a Fact has no place for.
The Fidelity Report names each one:

| `character_book` field | What the report says |
| --- | --- |
| `secondary_keys` | The Fact keys on one list, not two |
| `position`, `insertion_order`, or `priority` | The Fact lands where 1667 puts Facts |
| `selective` | The Fact has no AND/NOT key logic |
| `case_sensitive` | The Fact key matches a whole key and ignores letter case |
| `use_regex: true` | The Fact key is literal text, not a pattern; the entry's keys do not import |
| A leading `@@decorator` line in `content` | The line is removed from the Fact text |

Every leading `@@decorator` line is removed from the Fact text. Most are read
only to be removed and named in the Fidelity Report — `@@depth` reports the
same way a `position`, `insertion_order`, or `priority` field does, `@@role`
reports that the entry lost a prompt role, and the activation-timing
decorators (`@@activate_only_after`, `@@activate_only_every`,
`@@keep_activate_after_match`, `@@dont_activate_after_match`) report a lost
timed effect. Any other decorator is still named, generically.

`@@activate` and `@@dont_activate` are acted on, the same way
[`1667 import-lorebook`](#related-commands) acts on them in a SillyTavern
World Info file: `@@activate` makes the entry an always-active Fact, and
`@@dont_activate` keeps the entry out of the story entirely, unless
`@@activate` is also present, in which case `@@activate` wins. Only the exact
control line is honored; a decorator this converter does not recognize, or a
malformed one, leaves the prose without deciding activation.

An entry the converter cannot read at all — for example, an array element that
is not an object — still counts toward "entries read." It does not silently
disappear from the count.

## Fields the converter does not import

A V3 card can carry fields this converter does not use. When one is present,
the Fidelity Report names it:

| V3 field | What the report says |
| --- | --- |
| `first_mes`, `alternate_greetings`, `group_only_greetings` | `N greetings not imported` |
| `mes_example` | `example messages not imported` |
| `assets` | `N assets not imported` |
| `creator_notes` | `creator notes not imported` |
| `system_prompt` | `system prompt not imported` |
| `post_history_instructions` | `post-history instructions not imported` |
| `character_version` | `character version not imported` |
| `tags` | `N tags not imported` |
| `creator` | `creator not imported` |

The report names only the fields a card carries. It does not list a field the
card leaves out.

## Packing and limits

The converter first packs text at section boundaries. It then uses paragraph,
line, word, and Unicode-safe boundaries. It does not truncate selected text.

- Maximum character card file size: 20 MB
- Maximum decoded card JSON size: 1 MB
- Maximum character name length: 200 UTF-16 code units
- Maximum Fact input length: 4,000 Unicode scalar values
- Maximum result: 128 Fact inputs
- Maximum card import request size: 1 MB

The 128-Fact limit and the 1 MB request limit apply to the Character Facts and
the `character_book` Facts together. A card whose own text needs more than 128
Facts is refused outright — that many Facts do not fit any story, so shortening
the text is the only fix. Within that ceiling, the Character Facts are the
first claim on the room the target story has left; the `character_book` gets
whatever room and request budget remain, dropping entries from the end of the
list if it does not all fit. If the story's remaining room is smaller than the
Character Facts alone, the Character Facts themselves are trimmed from the
end, the same way. The Fidelity Report gives the dropped count either way.

The selected story must have room for at least one new Fact, or nothing
imports and the report says so.

## Related commands

The `1667 import-card` command adds character card Facts to an existing story.
The `1667 import` command makes a new story from each file. The `1667 export`
command writes one story to a file.
