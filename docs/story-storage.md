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

## Vault encryption

Use `1667 encrypt` to seal the project files of a stopped vault:

```sh
1667 encrypt
```

1667 asks for the Vault Password two times. A non-interactive command must use
`--passphrase-file <path>`. The passphrase file must be outside `.1667/`.

Use `1667 decrypt` to unseal the project files:

```sh
1667 decrypt
```

A start in a sealed vault asks for the Vault Password. The prompt permits three
attempts. The `export`, `import`, `import-card`, `import-lorebook`, and `profile`
commands accept `--passphrase-file <path>`. The `serve` command does not open a
sealed vault.

Keep the Vault Password in a safe location. 1667 cannot recover a lost Vault
Password. An interrupted operation stays safe. Run the same `encrypt` or
`decrypt` command again to complete the operation.

Vault encryption protects new project file contents on disk. It does not remove
plaintext from old backups, snapshots, sync history, or freed disk blocks. It
does not protect process memory or operating system swap. Generation sends the
required story content to the selected provider. An export writes plaintext to
the working tier.

File names and directory names stay plaintext. They show story identifiers,
object counts, object sizes, and writing activity. Object file names also show
content hashes.

These control files stay plaintext:

- `lock`
- `data-id` and its scratch file
- `owner.json` and its publication files
- `run.json`
- `.gitignore`
- `vault.json`
- `.1667-vault-unseal-progress/` during an unseal operation
- `stories/<id>/.1667-cleanup-needed`

The unseal progress directory contains one record for each file that 1667
unsealed. 1667 removes the directory after it publishes the format-4 marker.

Provider secrets stay in the machine tier. Vault encryption does not change the
machine tier.

## Story objects

1667 stores story prose in the project tier as text revisions and chunks. A
story can also hold these other kinds of stored object:

- The alternative tokens the model weighed for one take, when that take
  requested them.
- The thought a model wrote before its prose, when the take keeps one.
- A Normalized Image that the writer attached to one take.

1667 names each stored object with the SHA-256 of its exact bytes. Each time
1667 saves the project, it removes a stored object that no take refers to.

1667 also keeps one Draft Lease for each attached image that no take refers to
yet. A Draft Lease protects its image from removal. The lease expires after 24
hours. 1667 then removes the lease first and the image afterwards.

A story can also hold a Generation Record: the durable record of one model
request that created or changed a take. 1667 loads a Generation Record only
when you open it. A Generation Record never contains a credential, a custom
header value, a base URL, or provider response text. See [Generation
Record](model-providers.md#generation-record).

## Project lock

One writer can own a project. An advisory lock on `.1667/lock` enforces this
limit. A second process refuses to open the project. The error identifies the
owner process. The operating system releases the lock after a process failure.

1667 refuses a file system that does not enforce the lock.

## Reserved file publication

1667 writes some control files one time and then does not change them. These
are reserved files. The data-directory ID and each mutation receipt record
are reserved files.

A publication writes a scratch file with the suffix `.1667-publish-v1.tmp`.
It makes the bytes durable. It then links the scratch file to the reserved
name. In this commit window, the two names point to one file. The
publication then removes the scratch name.

A committed reserved file has one name. A reader refuses a reserved file
that has two or more names.

One owner operates on one reserved name at one time. In one process, 1667
does the operations on the same reserved name in sequence. Across
processes, the project lock or the applicable machine-tier lock gives this
ownership. Crash recovery runs only with this ownership. A read does not
change the file system when no scratch name is present.

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

A `.story` Archive contains the selected prose in order. It also contains the
Facts, the Memory, and the Author's Note. It does not contain directions,
unselected takes, summary parts, chapter boundaries, retry history, or
Generation Records.

A `.scenario` Archive contains the selected prose in one prompt. It contains
the same Facts, Memory, and Author's Note as a `.story` Archive. It does not
create placeholder variables. It does not contain the Author Brief, because a
Scenario carries the story's own Author's Note.

A Fact tagged `memory` becomes the Archive Memory. Memory is always in context,
so that Fact loses its activation mode and its keys. The other Facts go to the
Lorebook. The fidelity report gives this.

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

A `.story` export and a `.story` import carry the same items, so a story that
1667 exports and then imports keeps its Facts, its Memory, and its Author's
Note.

## Import a story

`1667 import <file.md>` reads a 1667-exported Markdown file or manuscript. It
creates a new story.

- `#` headings set the story title.
- `##` headings create chapter boundaries.
- Prose blocks separated by blank lines become story parts.

You can also import SillyTavern chat JSONL files with `1667 import <chat.jsonl>`.
A chat message can carry more than one swipe: more than one generated reply at
that point in the chat. 1667 reads the open swipe as the story part, and every
other swipe as an unselected take next to it.

You can also import NovelAI `.story` files with `1667 import <file.story>`.
1667 reads Editor V2 documents and Editor V1 legacy stories. Each ordered V2
text section becomes a story part. Each nonblank line of the joined V1 story
text becomes a story part. 1667 does not infer chapter boundaries.

An Editor V2 document can hold retry history: every earlier generation at a
point in the story, not only the one you kept. 1667 reads a plain retry as an
unselected take, next to the part it retried. It keeps the take you had open in
NovelAI as the selected story line. It drops a retry that edits or removes
prose already in the story line, and it states the count in the Fidelity
Report. Container generation settings are not imported.

## Import an Archive

`1667 import` makes a new story. It accepts `.md`, `.jsonl`, `.story`, and
`.scenario` files.

`1667 import-card` adds Facts to a story that exists. `1667 import-lorebook`
also adds Facts to a story that exists.

Select `import archive` in the command palette to import an Archive in the TUI.
A `.lorebook` file or a World Info `.json` file adds Facts to the open story. A
`.scenario` file or a `.story` file creates a new story.

Use this command to import a Container or a Scenario:

```sh
1667 import <file.story-or-scenario>
```

Use this command to import a Lorebook:

```sh
1667 import-lorebook --story <id-or-title> <file.lorebook>
```

The command also reads a SillyTavern World Info file, which uses the `.json`
name. 1667 reads the file to know which format it has. It does not use the file
name.

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

A World Info Entry uses different names for the same values.

| World Info Entry value | Fact value |
| --- | --- |
| `content` | Fact text |
| `comment` | Fact tag |
| `key` | Fact keys |
| `keysecondary` | Fact secondary keys |
| `selectiveLogic: 0` | AND secondary-key logic. Any secondary key can match. |
| `selectiveLogic: 2` | NOT secondary-key logic. No secondary key can match. |
| `selectiveLogic: 1` or `3` | Unsupported secondary-key logic. The secondary keys are omitted. |
| `world_info_logic: 0` or `2` | Legacy secondary-key logic. Used only when `selectiveLogic` is absent. |
| `scanDepth` from 1 to 20 | Fact scan depth |
| `scanDepth: null` or an absent `scanDepth` | The default Fact scan depth |
| `excludeRecursion: true` | Chain activation off |
| `constant: true` | Always active |
| Other `constant` values | Keyed activation |
| `disable: true` | No Fact |

Current World Info files use `selectiveLogic`. If both logic fields are
present, 1667 uses `selectiveLogic` and reports the conflict. A malformed
current value does not fall back to the legacy field.

A Fact can use literal keys or restricted regex keys. 1667 imports valid regex
keys. It also imports the supported secondary-key logic, scan depth, and chain
activation setting.

These World Info mechanisms do not import: insertion positions, firing
probability, delayed recursion, timed effects, AND-ALL or NOT-ALL logic,
literal-key matching rules, retrieval by meaning, character or trigger
filters, prompt roles, and `{{macro}}` expansion. The Fidelity Report gives
the number of Entries that lose each one.

A literal Fact key matches a whole key and ignores letter case. A World Info
Entry can ask for a different literal-key rule. Thus, a literal key can match
at a different moment after the import.

Entries in the same World Info group are exclusive: SillyTavern uses one of
them. Their Facts can be active together.

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

A transport can retry an import with the same mutation ID after a crash. 1667
keeps the bounded import plan in the mutation receipt before the import
commits. The retry returns the plan and the Fidelity Report of the import that
occurred. The retry does not add the Facts again.
