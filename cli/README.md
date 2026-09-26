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
