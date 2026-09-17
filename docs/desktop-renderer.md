---
summary: Desktop Renderer controls and parity map
read_when:
  - changing desktop/renderer.ts
  - changing desktop/renderer-view.ts
  - changing desktop/renderer-manuscript-view.ts
  - changing desktop/renderer-composer-view.ts
  - changing desktop/renderer-map-view.ts or renderer-map-layout.ts
  - changing desktop/renderer-braid-view.ts
  - changing desktop/renderer-aside-popover-view.ts or renderer-aside-hop.ts
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
- `w` starts a take, for the focused part, that you write yourself. The new
  take joins the focused part's other takes. It does not add a part after
  the last part.
- `e` edits the focused part.
- `a` opens Aside. `n` opens the Author's Note.
- `y` copies the focused part. `Y` copies the whole story line.
- `t` tags the line. `D` deletes the part.
- `p` toggles directions. `F` toggles the inspector.
- `o`, `f`, `c`, `m`, and `,` open Library, Facts, Chapters, Map, and
  Settings.
- `!` opens the log.

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
Write from here moves focus to that part, so your next Continue, Direct, or
`w` builds on it.

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

A braid strip can show above the composer. It draws one ribbon for your
current story line and one ribbon for each tagged story line that shares
your line up to the focused part. Your ribbon is straight and amber; a
tagged line's ribbon is amber-soft. A ribbon's width shows its word count.
Click a tagged ribbon to switch to that story line. The strip stays hidden
when no other tagged line passes through the focused part. When more than
four lines pass through the focused part, the strip shows your line, the
three nearest tagged lines by where they forked from your line, and a count
of the rest; click the count to open Map at the focused part.

The composer sits at the bottom of Write. At rest it shows one line: a
placeholder direction hint, the mode buttons (**Continue**, **Direct**,
**Write it myself**), and the primary button. Typing grows the field and
shows a title naming the mode. In Continue mode, `↵` sends an empty field.
`⇧↵` always inserts a newline. Once you type text, `⌘↵` sends it. `Escape`
clears focus. **Attach image** attaches a source image. **Save as my own
line** saves the typed text as your own words, with no model call.

**Continue** and **Direct** target the focused part. When the focused part
is the last part, they add text after it, the same as before. When the
focused part is an earlier part, they start a new take there instead. They
never add text after the last part in that case. When they start a new take,
focus moves to it, so your next Continue, Direct, or `w` builds on that new
take instead of starting another one from the same earlier part.

Use the Aside **History** control to select a story position or **Unanchored**
history. Then select a conversation with **Session**. **New session** starts
at the current story position. A selected historical conversation keeps its
original position when you change lines. Click the **⇱** button on the Aside
section's header to pop Aside out into its own window (see "Aside popover"
below). `Escape` docks it back into the inspector.

### Aside popover

The Aside popover shows the same Aside state as the inspector section, at
full width. It opens from the inspector's **⇱** button and closes with
`Escape`, which returns you to the inspector.

The header names the focused part, the shown take, the session number, and
the session title. **History** selects a story position or unanchored
history, the same as the inspector's control. **New session** starts a
session at the current story position. **⇲ dock** closes the popover.

The hop strip lists every position with a saved Aside session. The current
position shows inside brackets, for example `[ ¶ 12 · t2 ×2 ]`. Click another
entry to jump to its position. Hidden entries at either end show as a count,
for example `‹3 …`. Press `g`, with no field focused, to switch the story to
the take of the position the hop strip currently shows.

Below the hop strip, each turn shows its question, its thinking (when the
answer has any, folded under a **thinking** disclosure), and its answer. A
question in progress, or one you just stopped, shows its answer live in the
same place, above the saved turns. **Retake** asks the last question again.
**Use…** opens three actions: **Use as author's note** puts the answer in the
Author's Note field and opens that field in the inspector. It does not save
the field. Save the note yourself to keep it; the story's saved Author's Note
stays the same until you do. **Insert into story…** saves the answer as your
own next take. **Copy** copies the answer text. The question field at the
bottom asks with **Ask ⌘↵**. Aside answers never write to the story on their
own; every write goes through **Use…** or **Insert into story…**.

### Facts

The Facts destination (`⌘`/`Ctrl` plus `3`) shows the Facts for the active
story line and lets you edit one Fact at a time.

The list pane on the left has a scope row: **all**, **in force**, **ended**,
and **unscoped**. Click a scope to show only the Facts in that group. Type
in the filter field to search by name, tag, or text. The budget line shows
how many tokens the Facts in force at the focused part use. Set the Facts
budget in Settings › Story tools.

Each row shows the Fact name, its tag, and its activation. Click **+ New**
to start a new Fact in the sheet. Click a row to open that Fact in the
sheet. Use the up and down arrows on a row to reorder Facts.

The sheet on the right shows the selected Fact's fields: Name, Tag,
Activation, Priority, Keys, and Fact cap. A Fact with one story-wide state
shows a Body field. A Fact with more than one state, an anchored state, or
an End State shows a States list instead. Each state shows its text, its
anchor, and **edit** and **delete** links. Below the Body field or the
States list, use the three links to add a state: anchored at the focused
part, story-wide, or an End State at the focused part. These links are
always available, even for a saved Fact that still shows only a Body
field, so it can gain its first anchored state or End State.

A pending bar appears when your draft differs from the saved Fact. It
names each change. Click **Save fact** (`⌘S`) to save your changes, or
**Revert** to discard them. Click **Delete fact…** to delete the Fact.

The Fact check card runs a consistency check against the Facts in force.
Click **Check chapter** to check the focused chapter, or **Check line** to
check the whole story line. The check reads the story and reports
contradictions; it does not change a Fact or a part. Findings show above
the sheet. Each finding names the Fact, quotes the contradicting text, and
offers **Open ¶** to focus the part on Write, **Open fact** to open the
Fact in the sheet, and **Dismiss** to remove the finding from view.

### Chapters

The Chapters destination (`⌘`/`Ctrl` plus `4`) shows the active story line
as a ruler and a table of chapters.

Click **+ Break at ¶ n** to add a chapter break after the focused part.
Click **Restore removed** after you remove a break to bring it back.

The ruler draws each part as a segment. The width of a segment shows the
part's word count. A triangle marks the focused part. A darker segment
shows a chapter with a current summary. Click a segment to focus that part
on Write.

Each chapter break shows a handle on the ruler. The handle sits at the
boundary after the break's part. Drag the handle to move the break to a
new part. You can also focus the handle, then press the Left or Right
arrow key to move the break by one part. A chapter always keeps at least
one part. A break stops at its neighbor's edge.

A break's own summary cannot move with it: it would no longer match what
it claims to cover. If the break has a summary, 1667 asks before it moves
the break. Confirm to move the break and remove the summary. Cancel to
keep the break and the summary where they were. Press `u` to undo a move;
`u` does not bring the removed summary back. Use **Summarize** to make a
new one.

The table below lists each chapter with its part range, word count, and
summary state. Click a row to focus the chapter's first part on Write. Use
**Rename** to change a chapter's title. Use **Summarize** to create or
replace its summary; the button is disabled while a part in the chapter is
generating. Use **Edit summary** to change a saved summary by hand. Use
**Remove** to delete a break; the destination keeps the removed break so
you can restore it.

### Map

The Map destination (`⌘`/`Ctrl` plus `5`) draws the story as a stemma. Your
story line runs as a straight, 3px amber spine, one circle per part. A
circle's size shows the part's word count. A ring around a circle marks the
shown take at a fork with more than one take. A diamond marks a summary
part.

Every other take leaves the spine on a curved, amber-soft line. A take with
no words and no further takes shows small and faint, with a `✕` label. A
take untouched for more than three weeks shows faint. A run of takes with
one take each collapses to one bar; click the bar to focus its newest take.
A fork with many sibling takes shows the eight most recently touched takes
and folds the rest into one bar.

The map draws at most 120 circles and bars at once. When the story has more
parts than fit, it shows a window of parts around the focused part and folds
the parts outside the window into one bar at each end.

Move the pointer over the stage to open a lens. The lens is a dashed band
that follows the pointer along the spine. Where the lens sits, a folded run
opens into its separate takes. You can then see and click each take. The
lens does not move again until the pointer leaves it; this stops the newly
opened takes from pushing the run out from under the pointer. Move the
pointer off the stage to close the lens and fold the runs again.

While the pointer is off the stage, the arrow keys move a map cursor across
every part and take instead. When the map cursor lands on a take that has
left your line, the lens opens where that take's line leaves your line.

Click a circle to focus that take. `Escape` returns to Write at the same
part. Below the map, an accessible list repeats every drawn circle and bar
as a button, and a Fact lens list repeats every anchored Fact State as a
button.

The stage keeps its own scroll position. If you scroll the stage and then
do something unrelated, Map does not reset your view. When you open Map,
or when the shown window of parts changes, the stage scrolls so the
current part sits in the middle.

For a story with 2 or more parts, a minimap strip sits under the stage. The
strip shows the whole story line to scale by word count. A tick on the
strip marks a chapter break. A small mark on the strip shows a part with
other takes. A rectangle on the strip shows which part of the stage you
can see.

Drag the rectangle to move your view. Click the strip outside the
rectangle to jump there. When the part you land on is already drawn, the
stage scrolls to it right away. When the part is outside the drawn window,
Map redraws around it after you let go.

To move the rectangle from the keyboard, focus it with `Tab`, then press
the left or right arrow key. Each press moves the view by about half its
own width.

### Log

The log (`!`) lists every status message and error this session, newest
first. It has no filter and no clear button — it is a plain record of what
the app told you. `Escape` closes it.

### Inspect

Inspect (`⌘`/`Ctrl` plus `6`) shows the same sections as the inspector, as a
full destination: request context, thought, token alternatives, and
Generation Record reads.

Settings (`⌘`/`Ctrl` plus `,`): see "Settings" below.

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
keys on a focused chevron, to step the value; hold Shift to step by ten. Drag
the track handle to set the value directly by position; the value applies
when you release the handle. Type into the value to set it directly. A value
that does not parse pins the track handle to ember and keeps the invalid text
in the field; it does not block further typing. A boolean shows as two
words, `on` and `off`, in adjacent buttons; the desktop never shows a
checkbox, a switch, or a range slider.

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
`desktop/test/desktop-map.e2e.test.ts` checks the stemma, a click on an
off-path take, the `Escape` return to Write, and the braid strip.
`desktop/test/desktop-map-layout.test.ts` checks the stemma layout — the
budget, the collapsed runs, and a timing run for 2,000 parts — with no
Electron window.
`desktop/test/desktop-aside-popover.e2e.test.ts` checks the popped-out Aside
window, its hop strip, and the log.
`desktop/test/desktop-aside-hop-layout.test.ts` checks the popover's hop
strip against the hop-strip layout function directly, with no Electron
window.
