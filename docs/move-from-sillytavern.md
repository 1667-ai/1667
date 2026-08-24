---
summary: How to move chats, character cards, and World Info files from SillyTavern to 1667
read_when:
  - moving an existing SillyTavern project to 1667
  - comparing the SillyTavern and 1667 workflows
---

# Move from SillyTavern

1667 is a full-screen terminal app for long-form fiction. It imports
SillyTavern chats, swipe history, character cards, Character Books, and World
Info files. It runs on macOS, Linux, and Windows x64.

## Term map

| SillyTavern | 1667 | What changes |
| --- | --- | --- |
| Swipe | Take | The open swipe is selected. Other swipes stay as unselected takes. |
| Chat | Story | Character messages become story parts. |
| User message | Direction | User messages before a reply guide that story part. |
| Character card | Facts | Supported card text becomes editable Facts. |
| Character Book | Facts | Supported activation settings transfer. |
| World Info | Facts | Enabled constant and keyed entries become Facts. |
| API connection | Provider | 1667 has presets for common local servers. |

## Before you start

Make a 1667 project:

```sh
1667 init
```

Exit 1667 if it has this project open. Each import command needs the project
lock.

## Import a chat

Export the chat from SillyTavern as a JSONL file. The
[SillyTavern JSONL export](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/#export-as-jsonl)
does not include images or file attachments. Save those files separately
before you import the chat. Then run:

```sh
1667 import chat.jsonl
```

The command creates one new story.

- Each character message becomes one story part.
- User messages before a character message become its direction.
- The open swipe becomes the selected take.
- Other swipes become unselected takes.
- `{{char}}` and `{{user}}` use the names in the chat.
- System messages and empty messages do not import.
- User messages at the end without a reply do not import.

For a group chat, 1667 keeps real sender names. If the prose does not contain a
sender name, the importer adds `Name: ` before the text. 1667 does not provide
a group-chat runtime.

The source file does not change. The command refuses the chat and creates no
story if the input exceeds one of these limits:

- 20 MB per file.
- 50,000 records per file.
- 50,000 total swipe records per file.

The selected story line must fit within 5,000 story parts and 4,000,000
characters after name substitution. The command refuses the chat if the
selected line exceeds either limit. Alternate swipes use the remaining part
and text capacity. The command omits an alternate swipe that does not fit. It
creates the story and reports the omitted swipe count.

## Import a character card

Open a story. Open the command palette. Select `import character card`. Enter
the card path.

A story can contain 128 Facts. Card import uses the remaining Fact capacity.
It imports Character Facts before Character Book Facts. If the story has no
remaining capacity, the command imports nothing. The Fidelity Report gives the
number of Facts that did not fit.

You can also use the command line:

```sh
1667 import-card --story "Story title" card.json
```

1667 reads these files:

- Character Card V1 JSON.
- Character Card V2 JSON.
- Character Card V3 JSON.
- PNG cards with V1, V2, or V3 data in an uncompressed `tEXt` chunk.

1667 does not read CHARX, WebP, compressed PNG text, or an ordinary image.

The card name, description, personality, and scenario become Facts. Empty
fields do not import. A V2 or V3 `character_book` also becomes Facts.

The converter changes `{{user}}` to `the protagonist`. It changes `{{char}}`
to the V3 nickname, when present, or to the card name. These substitutions
apply to card text and Character Book content. The Fidelity Report does not
name these substitutions.

Supported Character Book settings include:

- Always-active or keyed activation.
- Primary and secondary keys.
- AND-ANY secondary-key rules.
- Restricted regex keys.
- Scan depth from 1 to 20 story parts.
- Chain activation opt-out.
- The `@@activate` and `@@dont_activate` control lines.

The Fidelity Report names unsupported Character Book settings. For a V3 card,
it names unsupported greetings, example messages, assets, creator notes,
prompts, version data, tags, and creator data. A V1 or V2 report does not list
these omitted card fields. The converter also does not import these card
metadata fields: `creator_notes_multilingual`, `source`, `creation_date`,
`modification_date`, or `extensions`. It does not import Character Book `name`,
`description`, or `extensions`. It does not import entry `id` or `extensions`.
The Fidelity Report does not name these metadata fields.

## Import World Info

Export World Info from SillyTavern as JSON. Then run:

```sh
1667 import-lorebook --story "Story title" world-info.json
```

You can also select `import archive` in the command palette. This adds Facts to
the open story.

The World Info JSON file must not exceed 1 MB. Each imported Fact can contain
at most 100,000 characters. The command truncates longer entry text and reports
the change. A story can contain 128 Facts, including existing Facts. The import
keeps entries in source order until it reaches the remaining Fact capacity. A
request that adds Facts must also fit within 1 MB. The command drops later Facts
that do not fit this request limit. The Fidelity Report gives each affected
count.

1667 keeps these settings when the file provides them:

- Constant or keyed activation.
- Primary and secondary keys.
- AND-ANY and NOT-ANY secondary-key rules.
- Restricted regex keys.
- Scan depth from 1 to 20 story parts.
- Chain activation opt-out.
- The `@@activate` and `@@dont_activate` control lines.

A disabled entry does not import. An entry with `@@dont_activate` does not
import unless its leading decorators also include `@@activate`. In that case,
`@@activate` has priority and makes an always-active Fact. The Fidelity Report
gives the count and reason for skipped entries. It does not identify the
individual entries.

Some World Info settings have no matching Fact setting. These settings include
insertion position and order, firing probability, timed effects, prompt roles,
entry groups, some recursion controls, extra scan sources, retrieval by
meaning, character filters, AND-ALL, and NOT-ALL. The Fidelity Report names
these limits. It gives affected entry counts where they are available.

Macros in entry text and primary keys stay as literal text. The Fidelity Report
gives the affected entry count. Macros in secondary keys also stay literal, but
the report does not name them.

## Model servers

1667 has presets for Ollama, LM Studio, llama.cpp, and KoboldCpp. The two apps
can use the same local model server. 1667 also supports OpenAI-compatible and
Anthropic endpoints.

## When to keep using SillyTavern

Use SillyTavern for chat roleplay, personas, active group chats, and its card
tools. Use 1667 for a long-form story with alternative takes and a selected
story line. Import copies supported material from SillyTavern into 1667. It
does not export material back to SillyTavern.

## Detailed references

- [SillyTavern chat import](sillytavern-import.md)
- [Character card import](character-card-import.md)
- [Facts, context, and model providers](model-providers.md)
