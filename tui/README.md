# 1667 TUI

The TUI is the full-screen terminal interface for 1667. It has no executable
of its own. The `1667` command lives in [`cli/`](../cli/README.md). By
default, it starts the TUI over an embedded backend worker, without a network
port.

Install the TUI dependencies before you run the CLI from source or build the
standalone executable:

```sh
cd ..
npm ci
cd tui
bun install --frozen-lockfile
```

See [Run 1667 from source](../docs/run-from-source.md) and
[Story storage](../docs/story-storage.md).

## Use the TUI

Use the arrow keys to move between story parts and sibling takes. Press
`Ctrl+P` from every surface to open the command palette. In the story view,
`:` also opens it. Press `Escape` to return to the prior surface. If the
command palette is already open, `Ctrl+P` keeps it open. Press `?` for the
complete key reference.

The command palette provides contextual Fact workflows. It shows the Fact
commands that apply to the current surface, such as opening Facts, adding a
Fact State, editing a Fact, and using the Map Fact lens.

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
bun run test
bun bench/perf.ts
```
