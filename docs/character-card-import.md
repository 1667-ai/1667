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

For a V3-only JSON card, the command prints:

```
/path/to/v3.json: Character Card V3 is not supported yet; export a V2 PNG or JSON card.
```

## Supported files

The command palette and the command line use the same converter. The converter
supports these inputs:

- Character Card V1 JSON
- Character Card V2 JSON with `spec: "chara_card_v2"` and
  `spec_version: "2.0"`
- PNG cards with V1 or V2 JSON in one uncompressed `tEXt` chunk named `chara`

If a PNG has a V3 `ccv3` chunk and a V1 or V2 fallback `chara` chunk, the
converter uses the fallback.

The converter does not fetch URLs. It rejects V3-only cards, CHARX files, WebP
files, compressed PNG text metadata, and ordinary images.

## Field mapping

The `name` field is necessary. The converter reads `description`, `personality`,
and `scenario`.

The entry points use each non-empty field. They ignore empty fields.

The converter changes `{{char}}` to the character name. It changes `{{user}}`
to `the protagonist`. It changes all matches in one case-insensitive pass. It
does not scan replacement text again.

Each non-empty field becomes part of one or more Facts with the `Character` tag.
The converter ignores all other card fields.

## Packing and limits

The converter first packs text at section boundaries. It then uses paragraph,
line, word, and Unicode-safe boundaries. It does not truncate selected text.

- Maximum character card file size: 20 MB
- Maximum decoded card JSON size: 1 MB
- Maximum character name length: 200 UTF-16 code units
- Maximum Fact input length: 4,000 UTF-16 code units
- Maximum result: 128 Fact inputs
- Maximum card import request size: 1 MB

The selected story must have room for the new Facts.

## Related commands

The `1667 import-card` command adds character card Facts to an existing story.
The `1667 import` command makes a new story from each file. The `1667 export`
command writes one story to a file.
