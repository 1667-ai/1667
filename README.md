<div align="center">

<img src="docs/assets/1667-rainbow.svg" alt="1667" width="420">

**Write and revise branching fiction from your terminal.**

[![npm](https://img.shields.io/npm/v/%401667-ai%2Fcli/latest?label=npm)](https://www.npmjs.com/package/@1667-ai/cli)
[![CI and standalone builds](https://github.com/1667-ai/1667/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/1667-ai/1667/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

1667 is a full-screen terminal app for fiction writing. Write story parts, keep
alternative takes, and select the story line that you want to read. Connect a
model when you want generated prose, or write every take yourself.

This repository contains the terminal user interface (TUI) and the backend.

[![1667 in a terminal: a direction is composed, the model streams the next part, two sibling takes are compared, and the path map opens](https://1667.ai/demo-4.gif)](https://1667.ai)

## What you can do

- Write and edit story parts in a full-screen terminal.
- Keep several takes for one story part without replacing earlier text.
- Select one take at each point to form a story line.
- View the selected line, the full tree, or a compact map.
- Organize long stories with chapters, summaries, Facts, and notes.
- Import an existing manuscript and export the selected story line as Markdown.
- Seal project files with a Vault Password.
- Choose from eight themes.

## Write with or without a model

You do not need a model provider to edit prose, create takes, select a story
line, manage chapters and Facts, or import and export Markdown. See
[Write without a model](docs/write-without-a-model.md).

When you want generated prose, connect a provider in Settings. 1667 supports
ChatGPT and Claude plan connections. It also supports OpenAI-compatible and
Anthropic Messages endpoints.

You can inspect the next provider request before you send it. You can also set
an Author Brief, directions, Facts, and sampling controls. See
[Facts, context, and model providers](docs/model-providers.md).

## Install

On macOS or Linux, use the Shell Installer:

```sh
curl -fsSL https://1667.ai/install.sh | sh
```

On Windows x64, use the PowerShell Installer:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://1667.ai/install.ps1 | iex"
```

After installation, open a new PowerShell window. Start 1667 with this command:

```powershell
1667.exe
```

Include `.exe` when you start 1667. The command `1667` does not start the app
because PowerShell treats it as a number.

Each Installer verifies the downloaded Release Archive checksum. The Shell
Installer supports macOS and Linux. The PowerShell Installer supports Windows
x64.

Create a project, then start 1667:

```sh
mkdir my-story
cd my-story
1667 init
1667
```

`1667 init` creates a `.1667/` directory in the project. Run `1667` from the
project or one of its subdirectories.

Run `1667 upgrade` to update a Managed Installation that the Shell Installer
created. The command shows download progress in a terminal.

On Windows, run this command to switch to the beta channel and install its
current release:

```powershell
1667.exe upgrade --channel beta
```

1667 downloads and verifies the beta release. It starts a local update
process. Windows replaces the locked `1667.exe` file after the command exits.
Wait for the update to finish. Then start `1667.exe` again. You do not need a
separate Installer download or attestation command.

If the saved channel is stable, run `1667.exe upgrade` for a stable Windows
update. To switch from beta to stable, run
`1667.exe upgrade --channel stable`. 1667 shows the applicable PowerShell
Installer command. Exit 1667 before you run that command. The Installer shows
download progress.

Install with npm:

```sh
npm install --global @1667-ai/cli@latest
```

npm manages this installation. Use npm to update it.

1667 checks the public npm registry for updates. The check does not send your
story, prompts, account data, or settings. You can turn off **update checks**
in Settings.

Install from source with the
[source installation procedure](docs/run-from-source.md).
Git manages this installation.

## Connect a subscription plan

1667 can use a ChatGPT Plus or Pro plan, or a Claude Pro or Max plan. These
connections do not need a separate API key.

Sign in to ChatGPT:

```sh
1667 auth login chatgpt
```

Sign in to Claude:

```sh
1667 auth login claude
```

Then select **ChatGPT plan** or **Claude plan** in Settings.

These connections are experimental community integrations. Your provider
applies its subscription limits, terms, and data controls.

## Keyboard orientation

| Task | Keys |
| --- | --- |
| Move between story parts | `↑` and `↓` |
| Select a sibling take | `←` and `→` |
| Go to the first or last story part | `g` and `G` |
| Go to the previous or next chapter | `[` and `]` |
| Continue the story | `Space` |
| Open the composer | `Enter` or `i` |
| Add a manual take | `w` |
| Edit the selected story part | `e` |
| Open Aside | `a` |
| Edit the Author's Note | `n` |
| Generate a take with the same or a new prompt | `r` or `R` |
| Copy the selected story part or story line | `y` or `Y` |
| Undo an added or removed chapter break | `u` |
| Open the map, facts, chapters, or library | `m`, `f`, `c`, or `o` |
| Open commands | `Ctrl+P` or `:` |
| Open the request viewer | `Ctrl+R` |
| Open the token probability viewer | `l` |
| Open settings or the key reference | `,` or `?` |
| Quit | `q` |

The `q` key also quits when Aside is open.

The keys `h`, `j`, `k`, and `l` do not move between story parts. `l` opens
the token probability viewer instead. In the map, `l` follows or opens the
selected story line. Press `?` for the complete key reference.

## Privacy

1667 stores stories and project settings in the project's `.1667/` directory.
Provider credentials stay on your machine. Demo mode and dry-run mode do not
contact a model provider.

During generation, 1667 sends request context to the selected provider. This
context can contain:

- story prose,
- Facts,
- chapter summaries,
- the Author's Note and Author Brief,
- directions and other guidance, and
- your current instruction.

Choose a provider whose data policy meets your needs.

Press `Ctrl+R` to open the request viewer. The request viewer shows the next
provider request without showing the credential.

## Documentation

- [Run 1667 from source](docs/run-from-source.md)
- [Write without a model](docs/write-without-a-model.md)
- [Story storage](docs/story-storage.md)
- [Facts, context, and model providers](docs/model-providers.md)
- [Move from SillyTavern](https://1667.ai/docs/move-from-sillytavern)
- [SillyTavern import](docs/sillytavern-import.md)
- [Character card import](docs/character-card-import.md)
- [Move from NovelAI](https://1667.ai/docs/move-from-novelai)
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
