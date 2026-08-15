<div align="center">

<img src="docs/assets/1667-rainbow.svg" alt="1667" width="420">

**A full-screen terminal environment for fiction writing with language models.**

[![npm](https://img.shields.io/npm/v/%401667-ai%2Fcli/latest?label=npm)](https://www.npmjs.com/package/@1667-ai/cli)
[![CI and standalone builds](https://github.com/1667-ai/1667/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/1667-ai/1667/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

1667 provides a keyboard interface and a story model with alternative takes.
1667 also provides a direct connection to a selected model provider. This
repository contains the terminal user interface (TUI) and its backend runtime.

[![1667 in a terminal: a direction is composed, the model streams the next part, two sibling takes are compared, and the path map opens](https://1667.ai/demo-2.gif)](https://1667.ai)

## Features

- Write in a full-screen terminal interface with six themes.
- Add sibling takes to any story part.
- Select a take for each story part.
- Read a story as a story line, a tree, or a mass map.
- View Facts and estimated request context in the side rail.
- Keep one Author's Note for the next continuation or prompted retake.
- Override the default Author Brief for one story.
- Use keys to include a Fact only when the request context matches it.
- Order, rank, and budget Facts so a full context window drops low-value ones first.
- Inspect the next provider request in the request viewer.
- Inspect the alternative tokens the model weighed in the token probability viewer.
- Manage chapter boundaries and chapter summaries in the Chapters view.
- Edit story parts, facts, and chapter summaries in the full-screen editor.
- Use the embedded backend worker without a network port.
- Seal project files at rest with a Vault Password.
- Stop a generation and save model text that already arrived.
- Connect to OpenAI-compatible endpoints or Anthropic Messages endpoints.

## Install

On macOS or Linux, use the Shell Installer:

```sh
curl -fsSL https://1667.ai/install.sh | sh
```

On Windows x64, use the PowerShell Installer:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://1667.ai/install.ps1 | iex"
```

Each Installer verifies the downloaded Release Archive checksum. The Shell
Installer supports macOS and Linux. The PowerShell Installer supports Windows
x64.

Run `1667 upgrade` to update a Managed Installation that the Shell Installer
created. The command shows download progress in a terminal. On Windows, exit
1667 and run the PowerShell Installer again. The Installer shows download
progress. `1667 upgrade` shows the required command.

`1667 upgrade --version <version>` selects an exact published release. The
version can be older than the current version. Before a downgrade, 1667 warns
that the downgrade can make the Vault unreadable or damage Vault data. Back up
the Vault before you continue.

Run `1667 upgrade --list` to show the published launcher releases. 1667 checks
platform support when `--version` selects a release. An exact version reuses
the previous executable when that executable has the selected version.

Install with npm:

```sh
npm install --global @1667-ai/cli@latest
```

npm manages this installation. Use npm to install a later release.

Install from source with the
[source installation procedure](docs/run-from-source.md).
Git manages this installation.

## Keyboard orientation

| Task | Keys |
| --- | --- |
| Move between story parts | `↑` and `↓` |
| Select a sibling take | `←` and `→` |
| Go to the first or last story part | `g` and `G` |
| Go to the previous or next chapter | `[` and `]` |
| Continue the story | `Space` |
| Open the composer | `Enter` or `i` |
| Copy selected editor text | `Ctrl+C` or `Command+C` |
| Cut selected editor text | `Ctrl+X` or `Command+X` |
| Paste text into an editor | `Ctrl+V` or `Command+V` |
| Select all text in an editor | `Ctrl+A` or `Command+A` |
| Undo or redo an editor change | `Ctrl+Z` and `Ctrl+Shift+Z`, or `Command+Z` and `Command+Shift+Z` |
| Go to the start or end of an editor line or buffer | `Command+Arrow` |
| Delete to the start of an editor line | `Command+Backspace` |
| Move by one editor page | `Page Up` or `Page Down` |
| Open the editor action menu | Right-click an editor |
| Add a manual take | `w` |
| Edit the selected story part | `e` |
| Edit the Author's Note | `a` |
| Generate a take with the same or a new prompt | `r` or `R` |
| Copy the selected story part or story line | `y` or `Y` |
| Undo an added or removed chapter break | `u` |
| Open the map, facts, chapters, or library | `m`, `f`, `c`, or `o` |
| Open commands | `Ctrl+P` or `:` |
| Open the request viewer | `Ctrl+R` |
| Open the token probability viewer | `l` |
| Open settings or the key reference | `,` or `?` |
| Quit | `q` |

The keys `h`, `j`, `k`, and `l` do not move between story parts. `l` opens
the token probability viewer instead. In the map, `l` follows or opens the
selected story line. Press `?` for the complete key reference.

## Privacy

1667 stores stories and project settings in the project tier. Demo mode and
dry-run mode send no data to a model provider.

During generation, 1667 sends request context to the selected provider. This
context can contain:

- Story prose
- Facts
- Chapter summaries
- Author's Note
- Author Brief
- User instructions

1667 sends the selected credential in the authentication header when a
connection requires a credential. Select a provider with an acceptable data
policy.

Press `Ctrl+R` to open the request viewer. The request viewer shows the next
request plan. It does not show the authentication header or its credential.

## Documentation

- [Run 1667 from source](docs/run-from-source.md)
- [Story storage](docs/story-storage.md)
- [Facts, context, and model providers](docs/model-providers.md)
- [Move from SillyTavern](docs/move-from-sillytavern.md)
- [SillyTavern import](docs/sillytavern-import.md)
- [Character card import](docs/character-card-import.md)
- [Generation Profile transfer](docs/generation-profile-transfer.md)
- [Platforms and standalone builds](docs/platforms-and-builds.md)
- [Development reference](docs/development.md)
- [Technical terms](docs/technical-terms.md)
- [Generation boundaries](docs/generation-boundaries.md)
- [Summary branches](docs/summary-branches.md)
- [Story line copy and paste](docs/story-line-copy-paste.md)
- [Automatic story names](docs/autoname.md)
- [TUI reference](tui/README.md)

## License

1667 uses the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
