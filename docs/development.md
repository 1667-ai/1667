---
summary: Diagnostics, development gates, repository layout, and stable names
read_when:
  - troubleshooting an internal error
  - running development or CI gates
  - changing repository structure or a stable name
  - changing the Continue or Retake prompt plan
---

# Development reference

## Troubleshoot internal errors

1667 shows a bounded diagnostic for unexpected embedded and HTTP backend
errors. The diagnostic includes the error name, the error message, and
a short cause chain. It does not include a stack or a provider response body.

After 1667 saves the detailed diagnostic, the error also includes an `err_…`
reference. Use that reference to find the entry in the private machine-tier
log:

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

The error message and the log can contain local paths and exception messages.
1667 omits provider request and response bodies from both outputs. The log can
also contain a stack. 1667 resets the active log before it exceeds 5 MiB.
Inspect the output before you share it.

1667 also saves a diagnostic when the embedded backend stops unexpectedly.
The host-state fields contain operation names and numeric stream progress.
These fields do not contain request input or streamed text.

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
bun run test
```

Run the frame performance gate separately:

```sh
bun bench/perf.ts
```

GitHub CI runs the complete gates on Linux x64. Pull request CI also tests the
macOS arm64, macOS x64, Linux arm64, Linux x64, and Windows x64 packages.
Windows CI runs the native platform contracts, the PowerShell Installer tests,
the upgrade command tests, and the standalone package smoke. CI does not run
the frame performance gate.

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

See [the CI workflow](../.github/workflows/ci.yml).

Set `AI_1667_TUI_PROFILE=1` to collect frame diagnostics. After terminal
restoration, 1667 writes one JSON report to standard error.

Before you change the Continue or Retake prompt plan, read the [Gemma prompt
quality gate](prompt-quality-gate.md). The gate defines the frozen fixture, the
paired v0.8.0 replay, the blind scoring record, and the committed evidence
contract.

## Repository layout

| Path | Contents |
| --- | --- |
| `tui/` | Terminal client, Bun workspace, and standalone build scripts |
| `server/` | Backend storage, generation, providers, worker, and HTTP adapters |
| `shared/` | Types and policies shared by the TUI and backend |
| `schema/` | Generated JSON Schema files |
| `scripts/` | CI, release, schema, and demo-recording tools |
| `test/` | Node.js tests for the backend runtime |
| `docs/` | Release instructions and technical design notes |
| `release/npm/` | Launcher source for the npm packages |

## Record the product demo

`scripts/render-demo.sh` drives the real TUI through its demo fixture with VHS
and writes three artifacts to `demo-out/`, which is not committed:

| Artifact | Consumer |
| --- | --- |
| `1667-demo.mp4` | The homepage video |
| `1667-demo-poster.png` | The homepage poster frame |
| `demo.gif` | The README hero at the top of this repository |

It needs `vhs`, `ffmpeg`, Bun, and `python3` with Pillow. `scripts/demo.tape`
holds the recorded flow, and `test/demo-tape.test.ts` holds it to that flow and
to its capture geometry.

The GIF is framed with the same terminal chrome the homepage puts around every
panel: three dots, a title, a status, over a hairline border. The site draws
that in CSS, which a GIF in Markdown cannot use, so `scripts/demo-chrome.py`
draws it into an image that the recording is composited onto. Its colours are
copied from the homepage's design tokens and the test asserts them, because
nothing else connects the two. `DEMO_FONT` overrides the Berkeley Mono path.

The GIF is served from 1667.ai rather than committed here. The README embeds an
absolute URL because npmjs.com renders the same README for `@1667-ai/cli` and
drops relative image paths. The name carries a revision. Publish each new
recording with the next number, and move the README link. GitHub's camo proxy
caches these images long enough that overwriting one in place does not reach
readers.

Publishing a new recording means copying the GIF into the homepage repository's
`public/`, adding its `_headers` rule, deploying, then updating the README link
here.

The homepage measured chapter timestamps against this recording and samples
pixels at them, so changing the tape's pacing fails a test in that repository.

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

## Development command options

`1667 --help` gives the commands and the options a writer uses. These options
are for development, so the help page names this file instead.

| Option | Effect |
| --- | --- |
| `--demo` | Use the in-memory lantern keeper fixture |
| `--embedded` | Use the embedded backend; this is the default |
| `--diagnostic` | Print read-only startup and project resolution JSON |
| `--print-logs` | Also print unexpected embedded backend errors to stderr |
| `--render-once` | Print one deterministic frame and exit |
| `--size <WxH>` | Set the `--render-once` dimensions; the default is 120x36 |
| `--keys <sequence>` | Send keys through the app before `--render-once` |
| `--debug-density` | Give the demo focus part 20 takes |

Use `1667 serve --legacy-v1 --data <path> [--print-logs]` to run the legacy
backend. This mode is for Linux only, and it refuses `--port`.
