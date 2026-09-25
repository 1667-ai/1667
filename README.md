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

This repository contains the terminal user interface (TUI) and its backend.

[![1667 in a terminal: a direction is composed, the model streams the next part, two sibling takes are compared, and the path map opens](https://1667.ai/demo-4.gif)](https://1667.ai)

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
- [CLI reference](cli/README.md)
- [TUI reference](tui/README.md)

## License

1667 uses the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
