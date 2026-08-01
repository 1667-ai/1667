---
summary: The SillyTavern import command, its file format, and its limits
read_when:
  - importing a SillyTavern chat into a project
  - changing the import command or its limits
  - adding a second import source
---

# SillyTavern import

The `1667 import` command reads SillyTavern chat files into a project. It makes
one new story for each file. It does not write to the file that it reads.

The command also reads Markdown files. It selects the format from the file. A
`.jsonl` file is a SillyTavern chat. For Markdown import, refer to
[Story storage](story-storage.md).

## Before you start

The command needs a project. Make one first:

```
1667 init
```

## Import one file

Give the file path:

```
1667 import chat.jsonl
```

The command prints one line for each file:

```
chat.jsonl: imported "Ashe (imported)" (24 parts) as st1_...
```

The last value is the story ID. Use it to open the story:

```
1667 --story st1_...
```

## Import more than one file

Give more than one path. The command makes one story for each file:

```
1667 import first.jsonl second.jsonl
```

If the command cannot read one file, it continues with the other files. It
prints the failure and stops with an error status. Thus a batch that was
partially successful does not report success.

## Select a different project

The command uses the project that it finds from the current directory. To use a
different project, give its root:

```
1667 import chat.jsonl --data /path/to/project
```

To use the machine-wide project, use `--global`:

```
1667 import chat.jsonl --global
```

Do not use `--data` and `--global` together. They select different projects.

## Supported files

The command reads SillyTavern chat exports in JSON Lines format. The first line
is chat metadata. Each subsequent line is one message. A file that has no
metadata line starts at the messages.

The command reads these message fields:

| Field | Use |
| --- | --- |
| `mes` | The message text |
| `is_user` | The sender: the user, or the character |
| `is_system` | If `true`, the command ignores the message |
| `name` | The sender name |
| `send_date` | The message time |

The command also ignores a message that has no text.

The command reads `user_name` and `character_name` from the metadata line. It
changes `{{user}}` to the user name. It changes `{{char}}` to the character
name. It changes all matches in one pass. It does not scan replacement text
again.

## What becomes a story

Each character message becomes one story part. The user messages before a
character message become the direction for that story part. Thus a chat of 20
messages does not always make 20 story parts.

The command removes the user messages at the end of the file that have no
character message after them.

The story name is the character name and `(imported)`. If the file gives no
character name, the story name is `Imported chat`.

## Limits

- Maximum file size: 20 MB
- Maximum records in one file: 50,000
- Maximum story parts from one file: 5,000
- Maximum sender name length: 200 characters
- Maximum total text after substitution: 4,000,000 characters

A file that is larger than the maximum file size fails before the command reads
it.

## Related commands

The `1667 export` command writes one story to a Markdown file. The `1667 import`
command reads that file again as a new story. It does not write to the story
that made the file.
