# 1667 CLI

The CLI provides the `1667` command. By default, it starts the terminal UI
over an embedded backend worker, without a network port.

## Run from source

Install the root dependencies and the TUI dependencies. The CLI has no
dependencies of its own. It reaches the TUI and the backend through the
repository's `node_modules`.

```sh
cd ..
npm ci
cd tui
bun install --frozen-lockfile
cd ../cli
```

Start 1667:

```sh
bun start
bun start -- --story <id>
bun start -- --data /path/to/project
bun start -- --demo
bun start -- --demo --render-once --size 120x36
bun start -- --url http://127.0.0.1:7373
```

`--data` selects a project root. Without this option, 1667 searches the current
directory and its parent directories for `.1667/`.

HTTP server mode is available only on Linux. See
[Run 1667 from source](../docs/run-from-source.md) and
[Story storage](../docs/story-storage.md).

## `1667 web` (experimental)

`1667 web` opens your project and serves a page in your browser. The server
answers requests from your computer only.

```sh
bun start -- web
bun start -- web --data /path/to/project
bun start -- web --port 4000
bun start -- web --no-open
```

The command prints a URL with a private token. Open the URL in a browser.
By default, the command opens the URL for you.

The page shows your project name and your Library. The Library lists your
stories. You can create a story, open a story, rename a story, and delete a
story. You can pick a light or dark look. You can pick a color palette.

An open story shows its story parts in order. You can move between story
parts with the arrow keys. You can pick a different take for a story part.
After the last take, the next take is the first take. Before the first
take, the previous take is the last take. Your place in the story survives
a page reload. Your place in the story survives a restart of `1667 web`.
The terminal app and `1667 web` share this same place.

Press Space, or click Continue, to write the next part. The page shows the
new words as they arrive. Press Escape, or click Stop, to stop early.
`1667 web` keeps the words that arrived, and saves them.

If you open a different story while `1667 web` writes, it keeps writing in
the first story. A bar at the bottom of the page tells you which story it
still writes in. Press Escape from any page to stop it, or click Stop in
that bar. Only one story writes at a time.

If the connection to `1667 web` breaks while it writes, the page keeps the
new words on screen but does not save them. Click Copy to copy them. Click
Retry to save them again. Click Discard to clear them.

If you have words that are not saved, `1667 web` warns you before you
reload the page or close the tab. Save the words, or copy them, first.

#### Direct the story

Press Enter or `i` to go to the box at the bottom of the page. Type what
happens next. Press Enter to send it. Press Shift+Enter to add a line. A
line above the box tells you where the new words go. If the box is empty,
Enter is the same as Continue. The box stays open while the story writes.
You cannot send while the story writes. Your words stay in the box.

If a send fails, or if you stop it before any words arrive, your words come
back to the box. Press Control and Up Arrow, or press Up Arrow in an empty
box, to find the directions you sent before.

#### Take a part again

Press `r` to write a new take of the selected part. The new take uses the
same direction. Press Shift+R to change the direction first. The box
changes to "Retake part N". Press Escape to leave it. You cannot take a
summary again.

#### Edit a part

Press `e` to edit the selected part. The editor replaces the words of the
part. Press Control+S, or Command+S on a Mac, to save the edit as a new
take. Press Control+Shift+S, or Command+Shift+S, to save the edit in the
part itself. Press Escape to close the editor. If you changed the words,
press Escape again to throw them away. If the part changed in another
window, `1667 web` keeps your words. Save again to replace the new words
with yours.

Press `w` to write your own take of the selected part. In a story with no
parts, press `w` to write the first part.

#### Part menu and delete

Press `x`, or click the dots at the top of a part, to open the part menu.
Press Shift+D to delete the selected part and the parts below it.
`1667 web` asks first. While the story writes, you cannot delete a part,
take a part again, or save an edit. Your words stay.

### Run the web page in development mode

`bun run web:dev` starts `1667 web` and a Vite development server together.
Vite reloads your page changes right away. Open the printed
`http://127.0.0.1:5173/#token=...` address.

```sh
bun run web:dev
bun run web:dev -- --data /path/to/project
```

## Build a standalone executable

Use Bun 1.4.0 or newer:

```sh
bun run build:standalone
./dist/1667 --version
./dist/1667 --version --json
./dist/1667 --demo --render-once --size 120x36
```

On Windows, use `.\dist\1667.exe`.

The executable contains the CLI, the TUI, the backend worker, its
dependencies, and the Bun runtime. It does not need Bun or Node.js at run
time.

The build checks the root, TUI, and lockfile versions. It also checks the
embedded worker and the prompt tokenizer. The output is a development
candidate. The command does not sign, archive, or publish it.

The release publishes packages for macOS, Linux, and Windows x64. See
[Platforms and standalone builds](../docs/platforms-and-builds.md).

## Run the gates

```sh
bun run typecheck
bun run test
bun run build:standalone
```
