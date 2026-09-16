---
summary: Desktop Renderer controls and parity map
read_when:
  - changing desktop/renderer.ts
  - changing desktop/renderer-view.ts
  - changing desktop/renderer-manuscript-view.ts
  - changing desktop/renderer-composer-view.ts
  - adding a desktop Renderer integration test
---

# Desktop Renderer

The desktop app provides graphical writing controls on macOS, Windows, and
Linux. The desktop app and the TUI use the same project files. Close the project
in one app before you open it in the other app.

## Install on macOS

The Mac download has no Developer ID signature or Apple notarization.
These are Apple checks that identify the publisher and inspect the app.
macOS can block the first start.

1. Download the Mac disk image for your processor.
2. Open the disk image.
3. Copy **1667** to **Applications**.
4. Open **1667** from **Applications**.
5. If macOS blocks the app, open **System Settings > Privacy & Security**.
6. Select **Open Anyway** for **1667**.
7. Confirm that you want to open the app.

Use this exception only for a download that you trust. See
[Apple's instructions for opening an app](https://support.apple.com/102445).

Mac updates require a manual installation. Use **Download update** to open the
release page for the available version. Save your work before you quit 1667.
Then replace the app in **Applications** with the new app. Your project files
are stored separately from the app.

## Run from source

Install the root dependencies with `npm ci`. Then run these commands:

```sh
cd desktop
npm ci
npm run build:app
npx electron app/main.cjs
```

Use **Create project** for a new project. Use **Open project** for an existing
project. The launcher keeps a list of recent projects. Use **File > New Window**
to open another window. Each window can select its own project.
Use **Projects** to return to the launcher. Use **Back to story** to return to
the current project.

Use **Seal** to encrypt and lock the project. Enter the same new password twice.
Use **Unlock project** to open a sealed project. Use **Unseal permanently**
to remove its encryption.

Use the launcher's update controls to select stable or beta updates. The
desktop updater does not offer an older version. Windows and Linux can install
the update from the app. macOS uses the manual installation above.

## Controls

The Desktop Renderer uses the same `StoryApi` contract as the TUI. The Shell
gives the Renderer one `MessagePort` for the active project. The Renderer builds
one Client facade for that port.

`renderer-controls.ts` holds the shared controls every destination uses: a
button (four kinds — primary, secondary, quiet, destructive), a segmented
choice of up to four options, a settable number with chevrons and a track, a
labeled field, a text area, a select, a chip, and a two-word boolean toggle.
Pick a control by the kind of value it holds, not by how you want it to
look. The desktop never shows a checkbox, a switch, or a range slider.

### Shell

A 44px titlebar spans the top of the window. It shows the 1667 mark, a
breadcrumb, the save state, the command palette chip, and the connection chip.
The breadcrumb shows the story title, the current story line if one is
tagged, and a destination summary. Only the title segment truncates.

A 56px icon rail sits at the left. It holds six destinations in a fixed
order — Library, Write, Facts, Chapters, Map, Inspect — plus Settings pinned
to the bottom. Click a rail icon, or use `⌘`/`Ctrl` plus `1` through `6` for
the first six destinations and `⌘`/`Ctrl` plus `,` for Settings. The active
destination shows a graphite block behind its icon. An amber dot marks a
destination that needs attention: Facts when a consistency check has fresh
findings, Settings when a revision is pending, and Library when an update is
available.

A 320px inspector sits at the right. It stays contextual to the focused
manuscript part and shows six sections in a fixed order: takes at the focused
part, Facts in force at that part, Aside, Author's Note, Author Brief, and
the request context. Click a section's header to collapse it to its count;
a section never disappears completely. Below 960px window width, the
inspector docks under the main column instead of beside it.

A toast shows the last status message at the bottom-left of the window. It
has no timeout. The next click or key press clears it, unless you click the
toast itself. An error banner shows above the toast the same way.

### Keys

The desktop uses the TUI keymap when no field has focus. Press `?` for the
list.

The desktop reads the keymap from `tui/src/reference-bindings.ts`. It does not
copy the keymap by hand. A letter key acts only when no text field, list box,
or dialog has focus. A button or a link does not count as a field, so a
letter key still acts when one of those has focus.

These keys work with no field focused:

- The arrow keys move the focused part and switch between its takes.
- `g` and `G` jump to the first and the last part.
- `r` retakes the focused part with its saved direction.
- `R` retakes the focused part with a new direction.
- `w` starts a take that you write yourself.
- `e` edits the focused part.
- `a` opens Aside. `n` opens the Author's Note.
- `y` copies the focused part. `Y` copies the whole story line.
- `t` tags the line. `D` deletes the part.
- `p` toggles directions. `F` toggles the inspector.
- `o`, `f`, `c`, `m`, and `,` open Library, Facts, Chapters, Map, and
  Settings.

Press `⌘`/`Ctrl` plus `K`, or the titlebar chip, to open the command palette.
Type to filter the list. Use the arrow keys to move through it, `Enter` to
run the selected command, and `Escape` to close it.

`Escape` peels one layer at a time. It closes an open popover first, then a
dialog, then a focused field. In Map, it then returns to Write at the same
focused part.

These chords use `⌘` on macOS and `Ctrl` on Windows and Linux: `⌘1` through
`⌘6` for the destinations, `⌘,` for Settings, `⌘K` for the command palette,
`⌘`/`Ctrl` plus `Enter` to send from the composer, and `⌘S` to save the
focused edit.

### Library

The Library destination (`⌘`/`Ctrl` plus `1`) opens, searches, creates,
imports, renames, exports, and deletes stories. It also holds the project
path and the Reveal folder, Projects, Seal, Unseal, and Refresh library
controls. Opening a project with no story selected lands on Library.
Selecting or creating a story switches to Write.

### Write

Write (`⌘`/`Ctrl` plus `2`) shows the manuscript as plain paragraphs with a
gutter to their left. Each part has a waymark: `¶ n` always, `×k` when the
part has k takes, `✎` for a human-written or human-edited part, and `◈` for
a summary. Click a part to focus it. The focused part gets a 2px amber edge
on the left of its prose.

Double-click a part, or press `e` on the focused part, to edit it. Editing
replaces the prose with a text field at the same measure. Below the field:
**Save edit** (or `⌘S`) replaces the saved part text. **Save as take** keeps
the original part and saves the edit as a new take. **Edit direction**
changes the part's direction. **Discard** drops the draft. `Escape` leaves
edit mode and keeps the draft; the gutter shows `✎` until you save it.

Hover or focus a part to show its toolbar above its first line: **Retake**
(`r`) makes a new take from the same direction. **Rewrite** rewrites the
selected text, or the whole part when nothing is selected. **Direct** (`i`)
focuses the composer in Direct mode. **Tag** (`t`) names the story line
through this part. The **···** button opens more actions: Take from cut,
Fact from selection, New Fact here, Copy line below, Paste below, Write from
here, Summary take, Prune unused takes, Remove tag, Inspect, and Delete part.

When a part has more than one take, the gutter shows `‹ take j/k ›` and a
take gauge: dots for up to 12 takes, a positional track beyond that. Click a
take, a dot, or press the arrow keys to switch. Switching a take shows a
toast that names the take and the part. Switching a tagged line from the
Library names the tag instead.

A streaming take grows at the end of the manuscript with a blinking caret
and a gutter that reads `⟳ writing · esc stops`. The composer is blocked
while a take streams. If a save fails, the Renderer keeps the text and
offers Save or Discard. A stopped summary take can only be discarded.
Provider generation IDs remain attached to saved text. If the Host can no
longer save a stopped rewrite, use **Copy text** before you discard it.

The composer sits at the bottom of Write. At rest it shows one line: a
placeholder direction hint, the mode buttons (**Continue**, **Direct**,
**Write it myself**), and the primary button. Typing grows the field and
shows a title naming the mode. `⇧↵` inserts a newline, `⌘↵` sends, `Escape`
clears focus. **Attach image** attaches a source image. **Save as my own
line** saves the typed text as your own words, with no model call.

Use the Aside **History** control to select a story position or **Unanchored**
history. Then select a conversation with **Session**. **New session** starts
at the current story position. A selected historical conversation keeps its
original position when you change lines.

The other destinations cover these TUI surfaces:

- Facts (`⌘`/`Ctrl` plus `3`): Fact order, Fact metadata, Fact deletion, Fact creation,
  Fact state summaries, Fact consistency checks, and the story Facts budget.
- Chapters (`⌘`/`Ctrl` plus `4`): chapter names, chapter creation, chapter removal and
  restore, summaries, and summary edits.
- Map (`⌘`/`Ctrl` plus `5`): branch tree navigation and anchored Fact state links.
- Inspect (`⌘`/`Ctrl` plus `6`): request context, thought, token alternatives, and
  Generation Record reads.
- Settings (`⌘`/`Ctrl` plus `,`): see "Settings" below.

### Settings

Settings (`⌘`/`Ctrl` plus `,`) has two panes. A left list names eight
sections: Routes, Profiles, Connections, Sampling, Output & reasoning,
Writing prompts, Story tools, and Desktop. Click a section, or use the arrow
keys when the list has focus, to show its sheet on the right. The active
section shows a 2px amber left edge. Below the list: the active revision
number, the pending revision number, and the pending change count.

Routes names which Generation Profile answers each kind of request: Default,
Prose, and Utility. Profiles lists every profile and lets you create,
duplicate, rename, and delete one. Connections holds a profile's provider,
authentication, timeouts, and model discovery. Sampling holds temperature and
the other sampling scalars, plus the stop, logit bias, phrase bias, banned
strings, and DRY breaker lists. Output & reasoning holds the output token
limit, reasoning effort and display, and the prompt cache policy. Writing
prompts holds the prompts the Renderer sends for prose, titles, summaries,
rewrites, and Aside. Story tools holds the story's Facts budget and the
buttons that open phrase bias and banned strings for the open story. Desktop
holds the theme picker and the directions toggle.

A settable number — temperature, a token limit, a timeout — shows as
`‹ value ›` with a track underneath. Click the chevrons, or press the arrow
keys on a focused chevron, to step the value; hold Shift to step by ten. Type
into the value to set it directly. A value that does not parse pins the track
handle to ember and keeps the invalid text in the field; it does not block
further typing. A boolean shows as two words, `on` and `off`, in adjacent
buttons; the desktop never shows a checkbox, a switch, or a range slider.

Editing a field only changes your local draft. A bar at the bottom of the
sheet area appears once your draft differs from the last-applied settings. It
names each change in words — for example, "temperature 0.8 → 0.65" — and
offers **Apply revision `n`** and **Discard**. Apply sends the draft and
shows a toast when the new revision takes effect. Discard reverts the draft
without contacting the Host. A separate notice, with its own **Retry
activation** and **Discard pending** buttons, appears when a saved revision
failed to activate — for example, because the provider check failed.

The theme picker shows all eight desktop themes as cards. Each card renders
its own sample sentence in its own serif type and colors, so you can compare
themes before you pick one. The active theme's card shows a 2px amber left
edge.

The Renderer keeps unsaved text in local draft state while a stream or library
refresh changes the view. A save clears its draft after the Host confirms the
save. Discard clears the unsaved text that you selected.

Stop an active generation before you select another story or project. The
Renderer asks before it discards unsaved edits. The theme and direction display
controls keep your choices when you restart the app. New installs start on the
graphite theme.

The Renderer uses in-app forms for story, Fact, chapter, tag, vault, and
confirmation actions. It does not use browser prompt or confirm dialogs.

The launcher opens and creates projects, adopts an existing project, unlocks a
vault, signs in to a subscription, and checks or installs updates. The workspace
supports story archive and profile transfer.

Set `AI_1667_DESKTOP_APP_PATH` to the built Electron main entry and run
`desktop/test/desktop-electron.e2e.test.ts` to run the desktop lane. The test
creates a temporary project and uses the built-in dry-run connection. It does
not use a provider credential. `desktop/test/desktop-shell.e2e.test.ts` checks
the shell's grid geometry, breadcrumb truncation, theme switching, the
destination shortcuts, the Settings attention dot, and part focus.
`desktop/test/desktop-keys.e2e.test.ts` checks focus and take-switching keys,
the keys sheet, and the command palette.
`desktop/test/desktop-keys-contract.integration.test.ts` checks the key
registry against the TUI's own reference, with no Electron window.
`desktop/test/desktop-manuscript.e2e.test.ts` checks focus versus edit mode,
the hover toolbar and its `···` menu, the take gauge, and the composer
states.
