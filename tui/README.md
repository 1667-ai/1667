# 1667 TUI

The TUI is the full-screen terminal interface for 1667. By default, it starts
an embedded backend worker without a network port.

## Run from source

Install the root dependencies and the TUI dependencies:

```sh
cd ..
npm ci
cd tui
bun install --frozen-lockfile
```

Start the TUI:

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

## Build a standalone executable

Use Bun 1.3.14 or newer:

```sh
bun run build:standalone
./dist/1667 --version
./dist/1667 --version --json
./dist/1667 --demo --render-once --size 120x36
```

On Windows, use `.\dist\1667.exe`.

The executable contains the TUI, the backend worker, its dependencies, and the
Bun runtime. It does not need Bun or Node.js at run time.

The build checks the root, TUI, and lockfile versions. It also checks the
embedded worker and the prompt tokenizer. The output is a development
candidate. The command does not sign, archive, or publish it.

The release publishes packages for macOS, Linux, and Windows x64. See
[Platforms and standalone builds](../docs/platforms-and-builds.md).

## Use the TUI

Use the arrow keys to move between story parts and sibling takes. Press
`Ctrl+P` or `:` to open the command palette. Press `?` for the complete key
reference.

Press `Ctrl+R` to open the request viewer. The request viewer shows the next
request plan in provider order. It shows each message and its estimated token
count. It also shows chapter summary replacements and the latest summary take
that resets the raw context.

Press `l` on a story part to open the token probability viewer. It shows the
take's prose with the alternative tokens the model weighed at the selected
token, if the story stored them.

Select a take. Press `h` to open the Generation Record Viewer. You can also
select **generation records** in the command palette. The viewer shows each
model request that created or changed the selected take, if the story stored
one. See [Model providers](../docs/model-providers.md#generation-record).

## Run the gates

```sh
bun run typecheck
bun test
bun bench/perf.ts
bun run build:standalone
```
