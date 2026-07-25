<div align="center">

# 1667

**A full-screen terminal environment for writing fiction with language models.**

[![CI](https://github.com/1667-ai/1667/actions/workflows/ci.yml/badge.svg)](https://github.com/1667-ai/1667/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

1667 gives you a keyboard-driven writing surface, a branching story model, and a direct connection to the model provider that you choose. This repository holds the terminal user interface (TUI) and the embedded backend runtime that the TUI needs.

## Status

This repository is private during pre-release work for 1667.ai. There is no published installer, package, or release build. You build and run 1667 from source.

## Features

- Write in a full-screen terminal interface with six themes.
- Branch any part of the story into sibling takes, then switch between them.
- Read your story as a path, a tree, or a mass map of every branch.
- Track facts, chapters, and remaining context space in a side rail.
- Edit any part, fact, or chapter summary in a built-in full-screen editor.
- Run one process, because the backend runs in an embedded worker with no network port.
- Cancel a generation at any time, and keep the story consistent.
- Connect to hosted or local models over an OpenAI-compatible or Anthropic Messages endpoint.

## Requirements

- Bun 1.3.14 or newer.
- Node.js 22.
- A terminal that supports 256 colors. Mouse support is optional.

Use npm at the repository root. Use Bun in `tui/`. The TUI worker runs the shared modules in `server/`, so you need both dependency trees.

## Set up the source workspace

```sh
git clone https://github.com/1667-ai/1667.git
cd 1667
npm install
cd tui
bun install
```

## Start 1667

Run these commands from `tui/`.

```sh
bun start                            # open the project found by walking up
bun start -- init                    # create .1667/ in the current folder
bun start -- init --adopt            # adopt a pre-0.2 data directory as this project
bun start -- --global                # one machine-wide library, no folders
bun start -- --story <id>            # open a specific story
bun start -- --data path/to/book     # open this project root
bun start -- export --force          # write the selected branch to <Title>.md
bun start -- --url                   # attach to the server this project published
```

1667 selects a backend in this order: `--demo`, then explicit `--embedded`, then `--url`, then `AI_1667_URL`, then the embedded worker.

Run `bun start -- --help` to see every command and flag.

## Try the demo

Demo mode uses a fixed sample story and never contacts a provider.

```sh
bun start -- --demo
bun start -- --demo --render-once --size 120x36
bun start -- --demo --render-once --size 120x36 --keys "m"
```

`--render-once` prints one frame and exits. `--keys` sends each character through the normal key handler before 1667 captures that frame. Both flags help you check layout changes without an interactive session.

## Where your stories live

1667 finds its stories the way git finds its history: it walks up from the
current directory looking for a `.1667/` folder. That folder is the project, and
the folder holding it is your project root — so `book/` and `screenplay/` keep
separate stories, and starting 1667 anywhere inside either one opens the right
library.

```sh
mkdir book && cd book
1667 init      # creates book/.1667/
1667          # opens it from book/ or any subdirectory
```

Starting outside any project asks once whether to create one here. A
non-interactive start refuses instead of guessing. `--global` opens one
machine-wide library for people who would rather not think about folders, and
`--data <project-root>` opens an explicit one (relative paths welcome).

Three tiers hold three different things:

| Tier | Where | What |
| --- | --- | --- |
| Machine | platform state root | provider secrets, HTTP auth records |
| Project | `.1667/` in the project root | stories, settings, `lock`, `run.json` |
| Working | the project folder | markdown you exported |

Secrets never leave the machine tier: the settings document stores an opaque id,
so a project can be committed, copied, or synced while each machine supplies its
own key. `.1667/.gitignore` keeps the machine-local files out of your commits.

One writer owns a project at a time, enforced by an advisory lock on
`.1667/lock`. A second start refuses and names the process holding it. The lock
lives in the kernel, so a crash releases it — there is nothing to clean up. A
filesystem that accepts every lock is refused by name rather than silently
allowing two writers.

`1667 export` writes the selected branch to `<Story Title>.md` in the project
root, with chapters as `##` headings. 1667 never reads a file it exported: the
loom in `.1667` is the only source of truth, and `e` (your `$EDITOR`) is how text
comes back in. See [ADR 007](docs/adr/007-project-anchored-storage.md).

## Keyboard orientation

| Task | Keys |
| --- | --- |
| Move between parts | `↑` and `↓` |
| Switch sibling takes | `←` and `→` |
| Jump to top or leaf | `g` and `G` |
| Continue the story | `Space` |
| Open the composer | `Enter` or `i` |
| Add your own take | `w` |
| Edit the focused part | `e` |
| Retake, or retake with a new prompt | `r` and `R` |
| Undo | `u` |
| Open map, facts, chapters, library | `m`, `f`, `c`, `o` |
| Open commands | `Ctrl+P` or `:` |
| Open settings or the key list | `,` and `?` |
| Quit | `q` |

`h`, `j`, `k`, and `l` are not navigation keys. `l` follows or opens the selected line in the map. Press `?` in the application for the complete list.

## Model providers

1667 supports three provider modes: `dry-run`, `openai-compatible`, and `anthropic`. Settings include presets for OpenAI, OpenRouter, Anthropic, LM Studio, Ollama, llama.cpp, KoboldCpp, and a custom endpoint. Use `dry-run` to exercise the interface without a network call.

Settings store a credential reference, never the key itself: either paste an API key — kept only in the machine tier's private `secrets.json` (mode `0600`), with an opaque id in the settings document — or name an environment variable and export it. Local servers like Ollama need no key. Prompt caching applies only to the exact official provider hosts, because cache and billing behavior is not portable across gateways. For the reasoning behind these rules, read [ADR 003](docs/adr/003-model-connections-and-generation-profiles.md) and [ADR 004](docs/adr/004-prompt-caching.md).

## Privacy

Your stories and settings stay on your computer, in the project's `.1667/` folder. 1667 does not upload them. When you generate text, 1667 sends prompt context to the model provider that you select in settings. That context can include story prose, facts, chapter summaries, and your instructions. Choose a provider that matches how you want that text handled. In demo mode and `dry-run` mode, 1667 sends nothing to any provider.

## Current platform limits

Local storage is available on macOS and Linux. Project discovery works everywhere, but the machine tier that holds provider secrets and HTTP auth records still needs a native DACL and reparse-safe adapter on Windows, so the Windows candidate refuses the embedded backend in one line and runs demo mode; HTTP attach, HTTP auth, and legacy serve fail closed there too.

Plain HTTP model endpoints are keyless-only. Loopback needs an exact-socket ownership proof (Linux only today). Attaching with `--url` proves the server holds the matching auth record by HMAC on every request; on Bun that HMAC is the whole proof, because Bun's `node:http` client exposes no stable socket identity to pin the connection to as well. Private-network IPs, `.local` names, and single-label LAN hostnames can be enabled per connection with **Allow insecure HTTP (LAN)**; the transport resolves once, refuses any non-LAN answer, and pins the verified address. Public hostnames and every credentialed connection still require an authenticated HTTPS endpoint. See [ADR 003](docs/adr/003-model-connections-and-generation-profiles.md) for the security boundary and remaining platform work.

## Build a standalone executable

```sh
cd tui
bun run build:standalone
./dist/1667 --version
./dist/1667 --version --json
./dist/1667 init && ./dist/1667 --render-once
```

The compiled executable contains the TUI, the backend worker, the dependencies, and the Bun runtime. It runs from any directory and needs no separate Bun installation.

The build checks that the root, TUI, and lockfile versions agree. It reads the build identity back from the executable, starts the embedded worker against a hostile-configuration fixture, and runs the prompt tokenizer smoke vectors. The result is a development artifact. Signing, multi-platform packaging, and publication remain separate gates. See [ADR 005](docs/adr/005-trusted-releases-and-upgrades.md) and [docs/RELEASING.md](docs/RELEASING.md).

## Development gates

Run the backend gates from the repository root:

```sh
npm run typecheck      # JSON Schema check and TypeScript check
npm test               # backend runtime tests
npm run schema:write   # regenerate schema files after a format change
```

Run the TUI gates from `tui/`:

```sh
bun run typecheck
bun test
bun bench/perf.ts      # headless frame performance gates
```

Continuous integration runs every gate on Linux, then builds and executes a packaged candidate on macOS, Linux, and Windows. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

To collect frame diagnostics from an interactive session, set `AI_1667_TUI_PROFILE=1`. After the terminal restores, 1667 writes one JSON report to standard error.

## Repository layout

| Path | Contents |
| --- | --- |
| `tui/` | Terminal client, Bun workspace, and standalone build scripts |
| `server/` | Backend runtime: storage, generation, providers, worker, and HTTP adapters |
| `shared/` | Types and policy that the TUI and the backend both use |
| `schema/` | Generated JSON Schema files that `npm run schema:check` verifies |
| `scripts/` | Schema generators and the release preflight tool |
| `test/` | Node.js test suite for the backend runtime |
| `docs/` | Architecture decision records and design notes |
| `release/npm/` | Launcher sources for future packaging work |
| `plans/` | Implementation plans and working notes |

## Architecture docs

An architecture decision record (ADR) states one decision and the reasons for it. Read the ADR before you change the area that it covers.

- [ADR 001: embedded TUI backend worker](docs/adr/001-embedded-tui-backend-worker.md)
- [ADR 002: TUI frame scheduling](docs/adr/002-tui-frame-scheduling.md)
- [ADR 003: model connections and generation profiles](docs/adr/003-model-connections-and-generation-profiles.md)
- [ADR 004: prompt caching](docs/adr/004-prompt-caching.md)
- [ADR 005: trusted releases and upgrades](docs/adr/005-trusted-releases-and-upgrades.md)
- [ADR 006: story aggregate and mutation coordination](docs/adr/006-story-aggregate-and-mutation-coordination.md)

Supporting notes: [generation boundaries](docs/generation-boundaries.md), [summary branches](docs/summary-branches.md), [autoname](docs/autoname.md), [character card import](docs/character-card-import.md), and the [TUI platform plan](docs/1667-tui-platform-plan.md). The [TUI reference](tui/README.md) describes screen behavior in detail.

## Stable names

The `AI_1667_*` environment variables and the `1667` on-disk identifiers are public contracts for this project. Treat them as fixed names.

| Name | Purpose |
| --- | --- |
| `AI_1667_DATA` | Data directory path |
| `AI_1667_URL` | Base URL of a loopback HTTP backend |
| `AI_1667_TUI_PROFILE` | Set to `1` to write one frame profile report at exit |

## License

1667 is licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
