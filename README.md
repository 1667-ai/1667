<div align="center">

<img src="docs/assets/1667-rainbow.svg" alt="1667" width="420">

**A full-screen terminal environment for fiction writing with language models.**

[![npm pre-release](https://img.shields.io/npm/v/%401667-ai%2Fcli/next?label=npm%20next)](https://www.npmjs.com/package/@1667-ai/cli)
[![CI and standalone builds](https://github.com/1667-ai/1667/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/1667-ai/1667/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

1667 provides a keyboard interface and a story model with alternative takes.
1667 also provides a direct connection to a selected model provider. This
repository contains the terminal user interface (TUI) and its backend runtime.

[![The 1667 starter onboarding story](docs/assets/starter-onboarding.png)](https://1667.ai)

Build and run 1667 from source. You can also build a local standalone
executable.

## Features

- Write in a full-screen terminal interface with six themes.
- Add sibling takes to any story part.
- Select a take for each story part.
- Read a story as a story line, a tree, or a mass map.
- View Facts and estimated request context in the side rail.
- Manage chapter boundaries and chapter summaries in the Chapters view.
- Edit story parts, facts, and chapter summaries in the full-screen editor.
- Use the embedded backend worker without a network port.
- Cancel a generation. 1667 does not change committed story data.
- Connect to OpenAI-compatible endpoints or Anthropic Messages endpoints.

## Install

1667 is a pre-release. The Shell Installer is not available yet. The homepage
publishes `install.sh` only after a release passes the Managed Installation
gate.

Install the npm pre-release globally:

```sh
npm install --global @1667-ai/cli@next
```

Or run the npm pre-release without a global installation:

```sh
npx --yes @1667-ai/cli@next
```

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
| Generate a take with the same or a new prompt | `r` or `R` |
| Copy the selected story part or story line | `y` or `Y` |
| Undo an added or removed chapter break | `u` |
| Open the map, facts, chapters, or library | `m`, `f`, `c`, or `o` |
| Open commands | `Ctrl+P` or `:` |
| Open settings or the key reference | `,` or `?` |
| Quit | `q` |

The keys `h`, `j`, `k`, and `l` do not move between story parts. In the map,
`l` follows or opens the selected story line. Press `?` for the complete key
reference.

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

## Documentation

- [Run 1667 from source](docs/run-from-source.md)
- [Story storage](docs/story-storage.md)
- [Facts, context, and model providers](docs/model-providers.md)
- [Platforms and standalone builds](docs/platforms-and-builds.md)
- [Development reference](docs/development.md)
- [Technical terms](docs/technical-terms.md)
- [Generation boundaries](docs/generation-boundaries.md)
- [Summary branches](docs/summary-branches.md)
- [Automatic story names](docs/autoname.md)
- [Character card import](docs/character-card-import.md)
- [TUI reference](tui/README.md)

## License

1667 uses the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
