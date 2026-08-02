---
summary: Requirements and commands to run 1667 from source
read_when:
  - running 1667 from a source checkout
  - using demo mode or render-once mode
  - changing backend selection
---

# Run 1667 from source

## Requirements

- Bun 1.3.14 or a later compatible version
- Node.js 22
- A terminal with support for 256 colors
- Optional mouse support

Use npm in the repository root. Use Bun in `tui/`. The TUI worker uses shared
modules from `server/`. Install both dependency trees.

## Prepare the workspace

```sh
git clone https://github.com/1667-ai/1667.git
cd 1667
npm ci
cd tui
bun install --frozen-lockfile
```

## Start 1667

Run these commands from `tui/`.

```sh
bun start                            # Open the nearest project
bun start -- init                    # Create .1667/ in this directory
bun start -- init --adopt            # Adopt the default legacy data
bun start -- --global                # Open the machine-wide project
bun start -- --story <id>            # Open one story
bun start -- --data path/to/book     # Open one project root
bun start -- export --force          # Export the selected story line
bun start -- export --all --format story # Export all stories as archives
bun start -- --url                   # Use the server in run.json
```

1667 selects a backend in this order:

1. `--demo`
2. An explicit `--embedded` option
3. `--url`
4. `AI_1667_URL`
5. The embedded worker

Run `bun start -- --help` for the commands and the usual options. Run
`bun start -- <command> --help` for one command.

## Use the demo

Demo mode uses a fixed sample story. Demo mode does not contact a model
provider.

```sh
bun start -- --demo
bun start -- --demo --render-once --size 120x36
bun start -- --demo --render-once --size 120x36 --keys "m"
```

`--render-once` writes one frame to standard output. It then stops. `--keys`
sends each character to the normal key handler before the frame capture.
