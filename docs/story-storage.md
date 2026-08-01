---
summary: Project discovery, storage tiers, locking, migration, and export
read_when:
  - selecting a project root
  - changing story storage or project locking
  - migrating or exporting story data
---

# Story storage

1667 searches the current directory and its parent directories for a `.1667/`
directory. The directory that contains `.1667/` is the project root.

Use separate project roots for separate story libraries.

```sh
mkdir book
cd book
1667 init
1667
```

`1667 init` creates `book/.1667/`. A start in `book/` opens this project. A
start in one of its subdirectories also opens this project.

An interactive start outside a project asks for permission to create a project.
A non-interactive start does not create a project. `--global` opens the
machine-wide project. `--data <project-root>` opens an explicit project root.
The option accepts a relative path.

## Storage tiers

1667 uses three storage tiers:

| Tier | Location | Contents |
| --- | --- | --- |
| Machine | Platform state root | Provider secrets, HTTP authentication records, and the `global/` project |
| Project | `.1667/` in the project root | Stories, settings, `lock`, and `run.json` |
| Working | Project root | User files, including exported Markdown files |

1667 stores provider secrets only in the machine tier. The settings document
contains an opaque secret identifier. During generation, 1667 sends the
selected secret only to the configured provider.

HTTP server mode requires the machine tier outside the project.

The project `.gitignore` excludes machine-local provider secret files. It also
excludes `lock` and `run.json`.

## Project lock

One writer can own a project. An advisory lock on `.1667/lock` enforces this
limit. A second process refuses to open the project. The error identifies the
owner process. The operating system releases the lock after a process failure.

1667 refuses a file system that does not enforce the lock.

## Migrate legacy data

Use this command to migrate a stopped legacy data directory:

```sh
npm run migrate-data -- /path/to/legacy-data /path/to/project/.1667
```

Run this command from the repository root. The destination must not exist.
Migration preserves the source. Migration accepts a legacy directory that
contains only `settings.json`. Migration also accepts StoryTavern story
bundles. 1667 keeps their content hashes valid. It writes 1667 format
identifiers when it next changes a story.

## Export a story

`1667 export` writes Markdown to `<Story Title>.md` in the project root. The
Markdown contains the selected take for each story part. The export omits
unselected takes and directions. Chapter titles use `##` headings.

Use `--format` to write an Archive:

```sh
1667 export --format story
1667 export --format scenario
1667 export --format lorebook
```

A `.story` Archive contains the selected prose in order. It does not contain
Facts, directions, the Author's Note, unselected takes, summary parts, chapter
boundaries, or retry history.

A `.scenario` Archive contains the selected prose in one prompt. It puts the
author brief in the instruction context. It puts Facts in the Lorebook. It
does not include the Author's Note. It does not create placeholder variables.

A `.lorebook` Archive contains one entry for each Fact. A Fact tag becomes a
category. The entry keeps the Fact activation mode and Fact keys.

The command writes the path of each file to standard output. For an Archive,
it writes a fidelity report to standard error. The report gives the number of
items that the export changes or omits.

Use `--all` to export every story. The command writes the newest story first.
It uses numeric suffixes when two story titles make the same file name.

If the file exists, 1667 adds a numeric suffix such as `-2`. Use `--force` to
replace the selected output file. During an `--all` export, `--force` keeps
separate file names for title collisions.

`--story <id>` selects a story. Without this option, export uses the most
recently updated story.

No option selects a story line. Select the story line in the TUI before export.

1667 imports `.story` and `.scenario` Archives with `1667 import`. It imports a
`.lorebook` Archive with `1667 import-lorebook`.

A `.story` import reads Facts, Memory, and the Author's Note. A `.story` export
does not write these items.

## Import a story

`1667 import <file.md>` reads a 1667-exported Markdown file or manuscript. It
creates a new story.

- `#` headings set the story title.
- `##` headings create chapter boundaries.
- Prose blocks separated by blank lines become story parts.

You can also import SillyTavern chat JSONL files with `1667 import <chat.jsonl>`.

You can also import NovelAI `.story` files with `1667 import <file.story>`.
1667 reads Editor V2 documents and Editor V1 legacy stories. Each ordered V2
text section becomes a story part. Each nonblank line of the joined V1 story
text becomes a story part. 1667 does not infer chapter boundaries. Container
generation settings and retry history are not imported.

## Import an Archive

`1667 import` makes a new story. It accepts `.md`, `.jsonl`, `.story`, and
`.scenario` files.

`1667 import-card` adds Facts to a story that exists. `1667 import-lorebook`
also adds Facts to a story that exists.

Use this command to import a Container or a Scenario:

```sh
1667 import <file.story-or-scenario>
```

Use this command to import a Lorebook:

```sh
1667 import-lorebook --story <id-or-title> <file.lorebook>
```

The Entry Mapping makes one Fact from each enabled Lorebook Entry.

| Lorebook Entry value | Fact value |
| --- | --- |
| `text` | Fact text |
| `displayName` | Fact tag |
| `category` | Fact tag when `displayName` is empty |
| `keys` | Fact keys |
| `forceActivation: true` | Always active |
| Other `forceActivation` values | Keyed activation |
| `enabled: false` | No Fact |

Memory becomes one always active Fact. The Fact tag is `memory`. Memory uses
the first Fact slot.

The Author's Note becomes the story's Author's Note. A `.story` import and a
`.scenario` import use the same context position.

A `.scenario` import keeps `${…}` text. It does not import the placeholder
metadata.

The command writes the new story summary to standard output. The summary gives
the story part count and the Fact count.

The command writes a Fidelity Report to standard error. The Fidelity Report
gives the item counts. It also gives the changes and omissions.
