<div align="center">

# 1667

**A full-screen terminal environment for fiction writing with language models.**

[![CI and standalone builds](https://github.com/1667-ai/1667/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/1667-ai/1667/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

1667 provides a keyboard interface and a story model with alternative takes.
1667 also provides a direct connection to a selected model provider. This
repository contains the terminal user interface (TUI) and its backend runtime.

This README uses the Technical Names in
[Technical terms](docs/technical-terms.md).

## Status

This public repository contains pre-release source.

| Item | Current status |
| --- | --- |
| Source repository | GitHub provides public access. |
| Standalone candidates | CI builds and tests five targets on `main` and four targets on pull requests. CI does not publish these files. |
| Installer | The repository does not contain an `install.sh` script. |
| npm package | 1667 does not publish an npm package. |
| GitHub release | A maintainer dispatches `Release (GitHub)`. It publishes one archive per published target as a pre-release, with a build-provenance attestation on every file. `windows-x64` is held from publication. |

Build and run 1667 from source. You can also build a local standalone
executable.

## Features

- Write in a full-screen terminal interface with six themes.
- Add sibling takes to any story part.
- Select a take for each story part.
- Read a story as a story line, a tree, or a mass map.
- View facts and estimated request context in the side rail.
- Manage chapter boundaries and chapter summaries in the Chapters view.
- Edit story parts, facts, and chapter summaries in the full-screen editor.
- Use the embedded backend worker without a network port.
- Cancel a generation. 1667 does not change committed story data.
- Connect to OpenAI-compatible endpoints or Anthropic Messages endpoints.

## Source requirements

- Bun 1.3.14 or a later compatible version
- Node.js 22
- A terminal with support for 256 colors
- Optional mouse support

Use npm in the repository root. Use Bun in `tui/`. The TUI worker uses shared
modules from `server/`. Therefore, install both dependency trees.

## Prepare the source workspace

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
bun start -- --url                   # Use the server in run.json
```

1667 selects a backend in this order:

1. `--demo`
2. Explicit `--embedded`
3. `--url`
4. `AI_1667_URL`
5. The embedded worker

Run `bun start -- --help` for all commands and options.

## Use the demo

Demo mode uses a fixed sample story. Demo mode does not contact a model
provider.

```sh
bun start -- --demo
bun start -- --demo --render-once --size 120x36
bun start -- --demo --render-once --size 120x36 --keys "m"
```

`--render-once` writes one frame to standard output and then stops. `--keys`
sends each character to the normal key handler before frame capture.

## Story storage

1667 searches the current directory and its parent directories for a `.1667/`
directory. The directory that contains `.1667/` is the project root.

Use separate project roots for separate story libraries.

```sh
mkdir book
cd book
1667 init
1667
```

`1667 init` creates `book/.1667/`. A start in `book/` or one of its
subdirectories opens this project.

An interactive start outside a project asks for permission to create a project.
A non-interactive start does not create a project. `--global` opens the
machine-wide project. `--data <project-root>` opens an explicit project root.
Relative paths are valid.

1667 uses three storage tiers:

| Tier | Location | Contents |
| --- | --- | --- |
| Machine | Platform state root | Provider secrets, HTTP authentication records, and the `global/` project |
| Project | `.1667/` in the project root | Stories, settings, `lock`, and `run.json` |
| Working | Project root | User files, including exported Markdown files |

1667 stores provider secrets only in the machine tier. The settings document
contains an opaque secret identifier. During generation, 1667 sends the
selected secret only to the configured provider.

The project `.gitignore` excludes machine-local provider secret files, `lock`,
and `run.json`.

One writer can own a project. An advisory lock on `.1667/lock` enforces this
limit. A second process refuses to open the project and identifies the owner
process. The operating system releases the lock after a process failure.

1667 refuses a file system that does not enforce the lock.

Use this command to migrate a stopped legacy data directory:

```sh
npm run migrate-data -- /path/to/legacy-data /path/to/project/.1667
```

Run this command from the repository root. The destination must not exist.
Migration preserves the source. Migration also accepts a legacy directory that
contains only `settings.json`. Migration accepts StoryTavern story bundles.
1667 keeps their content hashes valid. It writes 1667 format identifiers when
it next changes a story.

`1667 export` writes the selected story line to `<Story Title>.md` in the
project root. The selected story line is the take that each story part
currently holds. The export omits unselected takes and directions. Chapter
titles use `##` headings. `--story <id>` selects a story. Export otherwise uses
the most recently updated story. No option selects a story line. Select the
story line in the TUI before export. 1667 does not read an exported file. Use
the 1667 editor to change story data.

## Keyboard orientation

| Task | Keys |
| --- | --- |
| Move between story parts | `↑` and `↓` |
| Select a sibling take | `←` and `→` |
| Go to the first or last story part | `g` and `G` |
| Continue the story | `Space` |
| Open the composer | `Enter` or `i` |
| Add a manual take | `w` |
| Edit the selected story part | `e` |
| Generate a new take | `r` or `R` |
| Undo an added or removed chapter break | `u` |
| Open the map, facts, chapters, or library | `m`, `f`, `c`, or `o` |
| Open commands | `Ctrl+P` or `:` |
| Open settings or the key list | `,` or `?` |
| Quit | `q` |

The keys `h`, `j`, `k`, and `l` are not navigation keys. In the map, `l`
follows or opens the selected story line. Press `?` for the complete key list.

## Model providers

1667 supports these provider protocols:

- Dry run
- OpenAI Chat Completions
- Anthropic Messages

Settings contain presets for these providers and local servers:

- OpenAI
- OpenRouter
- Anthropic
- LM Studio
- Ollama
- llama.cpp
- KoboldCpp
- Custom endpoint

Dry-run mode tests the interface without a provider request.

A connection can refer to a stored credential or an environment variable.
1667 stores a pasted credential in the private machine-tier `secrets.json`
file. On POSIX systems, this file has mode `0600`. The project settings contain
only the opaque secret identifier.

Local servers such as Ollama can use a connection without a credential. 1667
enables prompt cache controls only for exact official provider hosts.

## Privacy

1667 stores stories and project settings in the project tier. Demo mode and
dry-run mode send no data to a model provider.

During generation, 1667 sends request context to the selected provider. This
context can contain:

- Story prose
- Facts
- Chapter summaries
- User instructions

1667 sends the selected credential in the authentication header when a
connection requires a credential. Select a provider with an acceptable data
policy.

## Current platform support

1667 supports these release targets:

- macOS arm64
- macOS x64
- Linux arm64
- Linux x64
- Windows x64

Plain HTTP provider endpoints cannot use credentials. On Linux, a loopback
endpoint also needs proof that the current user owns the exact socket.

A provider connection can permit plain HTTP on a private network. Enable
**Allow insecure HTTP (LAN)** for that connection. 1667 resolves the host once
and requires a private-network address. It then pins the verified address.

Public hosts and all connections with credentials require authenticated HTTPS.

## Build a standalone executable

```sh
cd tui
bun run build:standalone
./dist/1667 --version
./dist/1667 --version --json
./dist/1667 --demo --render-once --size 120x36
```

On Windows, use `.\dist\1667.exe` for these commands.

The build writes `tui/dist/1667` on macOS and Linux. The build writes
`tui/dist/1667.exe` on Windows. The executable contains the TUI, backend worker,
dependencies, and Bun runtime. You can move the executable to a different
directory. The executable does not need Bun or Node.js at run time.

The build verifies the root version, TUI version, and lockfile version. It reads
the build identity from the executable. It also tests the embedded worker and
the prompt tokenizer.

This file is a development candidate. The build does not sign or publish the
file. It does not create an archive or an installer.

See [the release instructions](docs/RELEASING.md).

## Troubleshoot internal errors

1667 gives unexpected embedded and HTTP backend errors a safe public message.
After 1667 saves a diagnostic, the public error includes an `err_…` reference.
Use that reference to find the entry in the private machine-tier log:

- macOS: `~/Library/Application Support/1667/State/log/1667.log`
- Linux: `$XDG_STATE_HOME/1667/log/1667.log`, or
  `~/.local/state/1667/log/1667.log` when unset
- Windows: `%LOCALAPPDATA%\1667\State\log\1667.log`

If 1667 cannot write the log, it omits the reference. It also prints a safe
warning to stderr.

Add `--print-logs` to print new diagnostics to stderr:

```sh
1667 --print-logs
```

1667 omits provider request and response bodies from the log. The log can
contain local paths and exception messages. 1667 resets the active log before
it exceeds 5 MiB. Inspect the log before you share it.

## Development gates

Run the backend gates from the repository root:

```sh
npm run typecheck      # Check JSON Schema and TypeScript
npm test               # Run backend runtime tests
npm run schema:write   # Regenerate schema files
```

Run the TUI gates from `tui/`:

```sh
bun run typecheck
bun test
```

Run the frame performance gate separately:

```sh
bun bench/perf.ts
```

GitHub CI runs the root build, root tests, TUI type check, TUI tests, and
standalone build on Linux x64. CI also runs the root tests, TUI tests, and
standalone build on each release target. CI does not run the separate frame
performance gate.

Four release targets run on every pull request: macOS arm64, Linux arm64,
Linux x64, and Windows x64. macOS x64 runs on every push to `main` and on
demand, not on pull requests. It is approximately ten times slower than the
other targets. It runs on a runner that GitHub will retire. The runner has
sufficient contention to cause intermittent wall-time test failures. Thus, CI
does not use macOS x64 as a pull request gate. A regression occurs on the
`main` commit that introduced it.

On native macOS arm64, the local CI script runs the root build, root tests, TUI
type check, TUI tests, and standalone build. The script runs the root tests and
TUI tests in Docker for Linux arm64 and Linux x64. The local script does not
build Linux standalone candidates. It does not test macOS x64 or Windows x64.

```sh
scripts/ci-local.sh
scripts/ci-local.sh --status
```

`--status` also publishes a commit status. A complete successful run records a
pass for the exact commit.

The Linux tests use Docker. These tests include the Linux-only loopback
ownership tests.

Use the optional pre-push hook only after a complete local run:

```sh
git config core.hooksPath .githooks
```

See [the CI workflow](.github/workflows/ci.yml).

Set `AI_1667_TUI_PROFILE=1` to collect frame diagnostics. After terminal
restoration, 1667 writes one JSON report to standard error.

## Repository layout

| Path | Contents |
| --- | --- |
| `tui/` | Terminal client, Bun workspace, and standalone build scripts |
| `server/` | Backend storage, generation, providers, worker, and HTTP adapters |
| `shared/` | Types and policies shared by the TUI and backend |
| `schema/` | Generated JSON Schema files |
| `scripts/` | CI, release, and schema tools |
| `test/` | Node.js tests for the backend runtime |
| `docs/` | Release instructions and technical design notes |
| `release/npm/` | Launcher source for future npm packages |

## Technical documents

- [Technical terms](docs/technical-terms.md)
- [Generation boundaries](docs/generation-boundaries.md)
- [Summary branches](docs/summary-branches.md)
- [Automatic story names](docs/autoname.md)
- [Character card import](docs/character-card-import.md)
- [TUI reference](tui/README.md)

## Stable names

The names in this table are public contracts. Do not change a name without a
compatible migration.

| Name | Purpose |
| --- | --- |
| `AI_1667_DATA` | Select an explicit project root for embedded mode |
| `AI_1667_STATE` | Select an absolute machine-tier directory |
| `AI_1667_URL` | Select the base URL of a loopback 1667 HTTP backend |
| `AI_1667_NO_UPDATE_CHECK` | Set to `1` to disable background update checks |
| `AI_1667_TUI_PROFILE` | Set to `1` to write a frame profile at exit |

## License

1667 uses the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
