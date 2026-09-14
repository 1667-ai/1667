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
desktop updater does not replace a newer version with an older version.

## Controls

The Desktop Renderer uses the same `StoryApi` contract as the TUI. The Shell
gives the Renderer one `MessagePort` for the active project. The Renderer builds
one Client facade for that port.

The left rail opens, searches, creates, renames, and deletes stories. The center
column edits manuscript parts and starts a Continue or Direct take. The Stop
control cancels the stream and saves the received prose. If that save fails,
the Renderer keeps the text and offers Save or Discard. A stopped summary take
can only be discarded. Provider generation IDs remain attached
to saved text. The right rail holds the
Author's Note, Author Brief, current context, request details, and Aside.

Use **Save edit** to replace the saved part text. Use **Save as take** to keep
the original part and save an edited take. Use **Edit direction** to change
the part's direction. **Retake** generates a new take from the same parent.
If the Host can no longer save a stopped rewrite, use **Copy text** before
you discard it.

Use the Aside **History** control to select a story position or **Unanchored**
history. Then select a conversation with **Session**. **New session** starts
at the current story position. A selected historical conversation keeps its
original position when you change lines.

The workspace tabs cover these TUI surfaces:

- Write: manuscript parts, line focus, manual edits, manual lines, Continue, Direct take,
  Retake, Rewrite, Summary take, line tags, cut, copy, paste, pruning, take navigation,
  deletion, images, and stream reasoning.
- Facts: Fact order, Fact metadata, Fact deletion, Fact creation, Fact state summaries,
  Fact consistency checks, and the story Facts budget.
- Chapters: chapter names, chapter creation, chapter removal and restore, summaries,
  and summary edits.
- Map: branch tree navigation and anchored Fact state links.
- Settings: provider connections, profiles, routes, sampling, output limits,
  reasoning display, writing prompts, and pending changes.
- Inspect: request context, thought, token alternatives, and Generation Record reads.

The Renderer keeps unsaved text in local draft state while a stream or library
refresh changes the view. A save clears its draft after the Host confirms the
save. Discard clears the unsaved text that you selected.

Stop an active generation before you select another story or project. The
Renderer asks before it discards unsaved edits. The theme and direction display
controls keep your choices when you restart the app.

The Renderer uses in-app forms for story, Fact, chapter, tag, vault, and
confirmation actions. It does not use browser prompt or confirm dialogs.

The launcher opens and creates projects, adopts an existing project, unlocks a
vault, signs in to a subscription, and checks or installs updates. The workspace
supports story archive and profile transfer. Keyboard help uses `?`; `⌘` or
`Ctrl` plus `1` through `6` switches tabs, and `⌘` or `Ctrl` plus `Enter` submits
the generation direction.

Set `AI_1667_DESKTOP_APP_PATH` to the built Electron main entry and run
`desktop/test/desktop-electron.e2e.test.ts` to run the desktop lane. The test
creates a temporary project and uses the built-in dry-run connection. It does
not use a provider credential.
