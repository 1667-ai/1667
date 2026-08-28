---
summary: Write, revise, branch, import, and export prose without a model provider
read_when:
  - changing manual writing actions
  - changing Markdown import or export
  - changing which actions use a model provider
---

# Write without a model

You can use 1667 to organize prose that you write yourself. You do not need to
set up a model provider.

The manual workflow includes these tasks:

- Import a Markdown draft.
- Edit story parts.
- Keep alternative takes.
- Select one story line.
- Add chapters and Facts.
- Use the tree and map views.
- Export the selected story line.

## Start with a Markdown draft

Write your draft in a Markdown file. Use a `#` heading for the story title. Use
`##` headings for chapters. Separate story parts with blank lines.

Import the file:

```sh
1667 init
1667 import draft.md
1667
```

1667 creates a new story. The source file stays unchanged.

## Write and edit takes

Press `w` in an empty story to write the first take.

Press `w` on a story part to write a sibling take. A sibling take is another
version of the same story part.

Press `e` to edit the focused story part. A normal save keeps the earlier text
as another take. The editor also has an action to update the current take.

A direction is optional in the editor. Keep the `≻ direction` marker to edit a
direction. The first `---` line after that marker ends the direction. Remove the
marker to save all remaining text as prose. Prose does not need a `---` line.

Use these keys to move and choose text:

| Task | Keys |
| --- | --- |
| Move between story parts | `↑` and `↓` |
| Select a sibling take | `←` and `→` |
| Go to the first or last story part | `g` and `G` |
| Copy a story part or story line | `y` or `Y` |

The selected take at each point forms the story line. Other takes remain in the
tree. You can select them again at any time.

## Organize the story

| Task | Key |
| --- | --- |
| Open the map | `m` |
| Open the Chapters view | `c` |
| Start a chapter | `C` |
| Open Facts | `f` |
| Tag a story line | `t` |
| Open the Library | `o` |

Chapters, Facts, tags, and maps do not require a provider. You can write chapter
titles, chapter summaries, and Facts yourself.

## Export the selected story line

Run this command in the project:

```sh
1667 export
```

1667 writes a Markdown file to the project root. The file contains the selected
story line. It does not contain unselected takes.

Run the command again after you select different takes. 1667 writes the story
line that is selected at that time.

## Know which actions use a provider

The following actions request model output:

- Continue a story with `Space`.
- Send a direction from the composer with `Enter` or `i`.
- Request a Retake with `r` or `R`.
- Rewrite selected prose from the command palette.
- Create a story name with **autoname story**.
- Generate a chapter summary.
- Send a question in Aside.

Do not use these actions during a manual session. Editing, take selection,
chapters, Facts, maps, import, and export remain available.

## Find your files

1667 stores each project in the `.1667/` directory at the project root. An
exported Markdown file is next to that directory.

Use a Vault Password if you want to seal the project files at rest. See
[Story storage](story-storage.md).

## Related documents

- [Story storage](story-storage.md)
- [Technical terms](technical-terms.md)
- [Facts, context, and model providers](model-providers.md)
