---
summary: How to move chats, character cards, and World Info files from SillyTavern to 1667
read_when:
  - moving an existing SillyTavern project to 1667
  - comparing the SillyTavern and 1667 workflows
---

# Move from SillyTavern

The published guide is at
[1667.ai/docs/move-from-sillytavern](https://1667.ai/docs/move-from-sillytavern).

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
| Character Book | Facts | Supported entries keep their activation settings. |
| World Info | Facts | Constant and keyed entries become Facts. |
| API connection | Provider | 1667 has presets for common local servers. |

## Before you start

Make a 1667 project:

```sh
1667 init
```

Exit 1667 if it has this project open. Each import command needs the project
lock.

## Import a chat

Export the chat from SillyTavern as a JSONL file. Then run:

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

The source file does not change. The command reports data that did not fit.

The main chat limits are:

- 20 MB per file.
- 50,000 records per file.
- 5,000 story parts per file.
- 4,000,000 characters after name substitution.

## Import a character card

Open a story. Open the command palette. Select `import character card`. Enter
the card path.

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

Supported Character Book settings include:

- Always-active or keyed activation.
- Primary and secondary keys.
- AND-ANY secondary-key rules.
- Restricted regex keys.
- Scan depth from 1 to 20 story parts.
- Chain activation opt-out.
- The `@@activate` and `@@dont_activate` control lines.

The Fidelity Report names unsupported Character Book settings. For a V3 card,
it also names unsupported card fields. Greetings, example messages, system
prompts, post-history instructions, and assets do not transfer. A V1 or V2
report does not list these omitted card fields.

## Import World Info

Export World Info from SillyTavern as JSON. Then run:

```sh
1667 import-lorebook --story "Story title" world-info.json
```

You can also select `import archive` in the command palette. This adds Facts to
the open story.

1667 keeps these settings when the file provides them:

- Constant or keyed activation.
- Primary and secondary keys.
- AND-ANY and NOT-ANY secondary-key rules.
- Restricted regex keys.
- Scan depth from 1 to 20 story parts.
- Chain activation opt-out.
- The `@@activate` and `@@dont_activate` control lines.

Some World Info settings have no matching Fact setting. These settings include
insertion position and order, firing probability, timed effects, prompt roles,
entry groups, some recursion controls, extra scan sources, macros, retrieval by
meaning, character filters, AND-ALL, and NOT-ALL. The Fidelity Report names
these limits. It gives affected entry counts where they are available.

## Model servers

1667 has presets for Ollama, LM Studio, llama.cpp, and KoboldCpp. The two apps
can use the same local model server. 1667 also supports OpenAI-compatible and
Anthropic endpoints.

## When to keep using SillyTavern

Use SillyTavern for chat roleplay, personas, active group chats, and its card
tools. Use 1667 for a long-form story with alternative takes and a selected
story line. Import lets you move the same material between those types of
work.

## Detailed references

- [SillyTavern chat import](sillytavern-import.md)
- [Character card import](character-card-import.md)
- [Facts, context, and model providers](model-providers.md)
