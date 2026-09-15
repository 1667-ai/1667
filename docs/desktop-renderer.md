---
summary: Desktop Renderer controls and parity map
read_when:
  - changing desktop/renderer.ts
  - changing desktop/renderer-view.ts
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

### Library

The Library destination (`⌘`/`Ctrl` plus `1`) opens, searches, creates,
imports, renames, exports, and deletes stories. It also holds the project
path and the Reveal folder, Projects, Seal, Unseal, and Refresh library
controls. Opening a project with no story selected lands on Library.
Selecting or creating a story switches to Write.

### Write

Write (`⌘`/`Ctrl` plus `2`) edits manuscript parts and starts a Continue or
Direct take. The Stop control cancels the stream and saves the received
prose. If that save fails, the Renderer keeps the text and offers Save or
Discard. A stopped summary take can only be discarded. Provider generation
IDs remain attached to saved text. Click a part to focus it in the inspector.

Use **Save edit** to replace the saved part text. Use **Save as take** to keep
the original part and save an edited take. Use **Edit direction** to change
the part's direction. **Retake** generates a new take from the same parent.
If the Host can no longer save a stopped rewrite, use **Copy text** before
you discard it.

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
- Settings (`⌘`/`Ctrl` plus `,`): the theme selector, the directions toggle, provider
  connections, profiles, routes, sampling, output limits, reasoning display,
  writing prompts, and pending changes.

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
supports story archive and profile transfer. Keyboard help uses `?`, and `⌘`
or `Ctrl` plus `Enter` submits the generation direction.

Set `AI_1667_DESKTOP_APP_PATH` to the built Electron main entry and run
`desktop/test/desktop-electron.e2e.test.ts` to run the desktop lane. The test
creates a temporary project and uses the built-in dry-run connection. It does
not use a provider credential. `desktop/test/desktop-shell.e2e.test.ts` checks
the shell's grid geometry, breadcrumb truncation, theme switching, the
destination shortcuts, the Settings attention dot, and part focus.
