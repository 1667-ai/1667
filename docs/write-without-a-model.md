---
summary: Use 1667 as a manual branching writing tool with no model provider
read_when:
  - changing manual authoring keys
  - changing which actions contact a provider
  - changing Markdown import or export
---

# Write without a model

1667 works as a manual writing tool. The story tree, the takes, the selected
story line, the chapters, the Facts, the map views, and the Markdown export all
operate on your own text. None of them contacts a model provider.

This page describes that workflow. It suits a writer who wants alternative
versions of a passage and one canonical path through them, and who writes every
word.

## What you get with no provider

- A story tree. Each story part holds as many takes as you write.
- One selected take for each story part. The selected path is the story line.
- Chapters with titles and boundaries.
- Facts for characters, places, and rules.
- An Author's Note and an Aside for your own notes.
- Three views of the story: the story line, the tree, and the mass map.
- Markdown export of the selected story line.
- Markdown import of a manuscript you already have.
- A local project directory that holds plain files.

## Which keys contact a provider

1667 sends a request only when you ask for one. These keys and commands ask:

| Action | Keys |
| --- | --- |
| Continue the story | `Space` |
| Open the composer and continue | `Enter` or `i` |
| Generate a take with the same or a new prompt | `r` or `R` |
| Autoname story | The command palette |
| Rewrite a story part | The command palette |

Every other action writes to your project and stops there. Avoid the keys
above, and 1667 makes no network request.

Two commands name a story without a request: **Rename story** in the command
palette, and `e` on the selected story in Library.

## Start a project

```sh
1667 init
1667
```

`1667 init` creates a `.1667/` directory. That directory is your project. Start
1667 in the project root or in one of its subdirectories.

## Write a story part

Press `w` to add a manual take. Type your prose. Save it.

Press `e` to edit the selected story part.

A manual take is an ordinary story part. It has the same status as any other
take in the tree.

## Branch, and choose canon

Add a second take to the same story part to write an alternative version.

| Task | Keys |
| --- | --- |
| Move between story parts | `↑` and `↓` |
| Select a sibling take | `←` and `→` |
| Go to the first or last story part | `g` and `G` |
| Go to the previous or next chapter | `[` and `]` |
| Open the map | `m` |
| Copy the story part or the story line | `y` or `Y` |

The take you select for each story part is canon. The other takes stay in the
tree. Select a different take at any time, and the story line follows your
choice.

The map (`m`) shows the whole tree. The mass map shows every take at once. Use
`l` in the map to follow or open the selected story line.

## Keep chapters, Facts, and notes

| Task | Keys |
| --- | --- |
| Open the chapters view | `c` |
| Open the Facts panel | `f` |
| Edit the Author's Note | `n` |
| Open Aside | `a` |
| Undo an added or removed chapter break | `u` |

Write chapter titles and chapter summaries yourself. Write each Fact yourself.
A Fact holds one piece of durable story truth, such as a character trait or a
rule of the world.

## Bring in a manuscript

```sh
1667 import <file.md>
```

This command reads a Markdown manuscript, or a file that 1667 exported before.
It creates a new story. Your source file does not change.

## Export the story line

```sh
1667 export
```

This command writes `<Story Title>.md` in the project root. The file contains
the selected take for each story part. Chapter titles use `##` headings. The
export omits unselected takes and directions.

Run `1667 export` again after you change your selections. The file follows the
story line that you chose.

## Where your text lives

Your stories stay in the `.1667/` directory in your project root. Exported
Markdown sits beside it in the project root. 1667 has no account, no cloud
service, and no telemetry.

Add a Vault Password to seal the project files at rest. See
[Story storage](story-storage.md).

## Related documents

- [Story storage](story-storage.md)
- [Technical terms](technical-terms.md)
- [Facts, context, and model providers](model-providers.md)
