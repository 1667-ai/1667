# 1667 TUI

Full-screen terminal environment for writing fiction with 1667. The default command starts the embedded backend worker with no listening port. `--url` (or `AI_1667_URL`) selects an explicit loopback HTTP/SSE server instead. Demo mode uses the deterministic lantern-keeper fixture.

```sh
npm install --prefix ..  # embedded backend runtime
bun install --frozen-lockfile
bun start -- --story <id>                        # embedded backend
bun start -- --data /path/to/1667-data
bun start -- --url http://127.0.0.1:7373
bun start -- --demo
bun start -- --demo --render-once --size 120x36
bun start -- --demo --render-once --size 120x36 --keys "m"
```

Build a single executable with Bun 1.3.14 or newer, then run it from any directory:

```sh
bun run build:standalone
./dist/1667 --version
./dist/1667 --version --json
./dist/1667
```

On Windows, use `.\dist\1667.exe` for these commands.

The compiled executable contains the TUI, backend worker, dependencies, and Bun runtime. It does not require a separately installed Bun or 1667 server at runtime. Its build identity is injected into both entrypoints, checked during worker startup, and exposed through the JSON version command and HTTP compatibility metadata. Source runs report an explicit `source` development identity; the host-native standalone reports its source commit, dirty state, timestamp, and target.

Packaged embedded storage supports macOS, Linux, and Windows x64. On Windows,
1667 protects the machine tier with an exact current-user and SYSTEM DACL. The
Windows package rejects reparse points. Supervised server mode is available
only on Linux.

`build:standalone` validates that the root, TUI, and npm-lock versions agree.
It reads the embedded identity from the executable.
It starts the embedded worker from a hostile configuration fixture.
It compiles and runs the exact prompt-tokenizer smoke vectors.
Intel macOS and Intel Linux builds use the Bun baseline runtime.
Arm64 builds use the native Bun runtime.
The command creates a development artifact only.
The release workflow does the tagged release validation and packaging.
The release workflow also does the signing, isolated candidate execution, and
publication.

The worker runs the repository's shared `server/` modules, so both the root npm dependencies and the TUI Bun dependencies are required. A root `npm install` satisfies the first command.

Embedded mode creates `./data` in the directory where `1667` was launched. Override it with `--data <path>` or `AI_1667_DATA`; relative paths remain relative to the launch directory. Precedence is `--data`, then `AI_1667_DATA`, then `./data`.

Backend selection: `--demo` → explicit `--embedded` → `--url` → `AI_1667_URL` → embedded worker. The embedded worker and HTTP server use the same story service and refuse to open a data directory already owned by another lock-aware backend process.

NAV uses arrows: `↑/↓` focus parts and `←/→` switch sibling takes. `h/j/k/l` are not navigation keys (`l` is reserved for following/opening a map line). Other keys: Space continues, Enter or `i` opens Direct, `u` undoes an added or removed chapter break, `g/G` top/leaf, `p` directions, `n` new story, `m` map, `f` facts, `o` library, `c` chapters, `C` end chapter, `[`/`]` jump chapters, `t` tag, `d` prune, `e` edit, `w` human sibling, `r` retake with the same prompt, `R` retake after editing that prompt, `z` typewriter, `⌃p` or `:` commands, `,` settings, `?` keys, `q` quit. A story with no parts opens directly in its Direct composer. Settings uses `↑/↓` to select a row, Enter to edit and keep that row in place, and `s` to validate and save the complete draft.

The map is one full-bleed place with `path`, `tree`, and `mass` views. `m` opens at path and cycles the views; Esc returns to writing. Path defaults to `path/all`, including childless sibling takes; `a` toggles `path/branches`, which keeps only continued/tagged lines. Path uses `↑/↓` for depth and `←/→` for sibling takes. Tree and mass use `↑/↓` for rows and `l` to follow or open; mass sorts by size, recent activity, depth, and name with `s`. Sketches start revealed in tree and mass; `a` hides or reveals them there. Enter reroutes through the selected line.

Compose opens as a framed pen-ink field, grows with each Shift+Enter up to `max(6, floor(terminal rows / 3))`, and scrolls internally after the cap. `⌃f` toggles fullscreen without losing the draft. Enter sends; `↑/↓` moves between draft lines; `⌃↑/⌃↓` recalls history; Esc peels fullscreen first, then returns to NAV. Settings can opt into dim-page compose focus. The config keys are `compose_focus` and `compose_max_height` (camel-case JSON aliases remain supported).

The grouped command palette has Suggested, Story, Take, View, and System sections. Search filters labels, descriptions, and shortcut hints. The wide facts rail remains facts plus an honest next-request meter: a known model window shows estimated request size and free space; an unknown window shows no percentage or fake bar. Click the meter or press `⌃g` to expand its voice/facts/recent/summary breakdown.

Six themes ship: lantern, iron gall, parchment, bond, hi-contrast dark, and hi-contrast light. TUI preferences are written to a private sibling file, flushed, and atomically published over the prior complete configuration. An interrupted or failed save leaves the prior complete configuration readable.

Mouse: wheel scrolls the story or active list, a part click moves focus, and clicking its prompt expands or collapses the full text. The focused part's left gutter stays pinned while long prose scrolls; its take arrows, take dots, and all six writing actions are clickable. Map/list rows select and a second click opens; story/footer action labels run the action they name; rail facts open in the facts panel; right-click opens a part menu. Drag selects story text, including expanded prompts, and selection excludes the facts rail. Right-clicking a part preserves that highlight: **Copy selection** copies exactly it, while **New fact from selection** opens the shared editor with the selected text and an optional `tag:` line. With no selection, Copy retains its whole-part behavior. Clicking outside a floating panel closes it.

The chapters overlay combines the storyline TOC with the model-context meter. Use `s` to summarize/refresh, `e` to rename, `n` to create a break after the focused prose part, and guarded `d` to remove a break. Chapter summary rows expand with Enter and open in the full-screen TUI editor with `e`.

The `:` command palette includes **Prune unused takes**. It previews one atomic cleanup, then requires `d` to confirm. Continued takes, every tagged line, single takes, and one leaf per fork survive.

`--keys` is a render-once fixture hook: each character travels through the same resolver and handler as an interactive keypress before the frame is captured.

Generation cancellation crosses the worker protocol, aborts the provider request, discards uncommitted streamed deltas, and reloads the authoritative story. Stream delivery uses a 16ms/32KiB batch with an eight-batch, 256KiB acknowledged credit window. Shutdown durably tombstones foreground mutation cancellations before notifying the worker, drains requests, releases the data-directory lease, and then terminates the worker.

For frame diagnostics, launch the interactive client with `AI_1667_TUI_PROFILE=1`. After terminal teardown it writes one bounded JSON report to stderr with scheduler coalescing, application prepare/render/surface/presentation distributions, cold-wrap slices/cache counts, and OpenTUI native renderer statistics. `bun bench/perf.ts` runs the headless p50/p95/max performance gates.

Every mutating worker call enters a durable main-thread outbox with its semantic input, originating protocol version, and a timestamped 128-bit-random mutation ID. A replacement worker reuses the exact ID and input schema. The worker binds them to a canonical fingerprint in its durable receipt before parsing. Cancellation is durably tombstoned before the worker cancel message. Thus, a cancelled provider operation does not replay after a crash. Receipts replay completed outcomes. They reject changed-payload reuse. They recover deterministic entity creation after a crash. A provider failure ends the local mutation and does not stop the worker. A terminal saved-state check also keeps the worker available. 1667 archives the request and reloads the story. The writer can then try again. If the worker stops during a provider request, 1667 archives the active outbox intent. At the next start, 1667 closes the retained provider record and reloads the story. It does not replay the provider request. Unseen IDs expire after 24 hours. Retained receipts remain authoritative after that retry window.

HTTP mode proves the server on each exact TCP connection before it sends a capability or request body. It then preflights product and API compatibility before each operation. It sends the negotiated client protocol and the random server-instance ID with the operation. Protocol v4 adds source-bound edited-take creation. Thus, older independent servers are rejected before an inline `e` save can reach them. The loopback server binds each mutation to that exact instance before dispatch. This closes the restart gap between health negotiation and a story mutation. If preflight first reports recovered state, the triggering mutation is not sent. The client closes an interrupted provider record and reloads the authoritative story and settings. If recovery leaves an empty library, only the replacement-story create is permitted. Provider-backed generation requests use the 30-minute generation-class deadline. Ordinary unary HTTP actions retain a 15-second bound.

`e` opens the built-in full-screen multiline editor on `instruction\n---\nprose`. The first delimiter separates the two fields. `Ctrl+S` creates a new sibling take and keeps the original part. `Ctrl+O` writes the draft over the focused part. Classic terminals cannot tell `Ctrl+Shift+S` from `Ctrl+S`, so `Ctrl+O` is the portable same-take chord; terminals that report modified keys may also use `Ctrl+Shift+S`. Each key keeps that meaning for the whole edit session. `w` opens the same editor with an empty human sibling take. Facts and chapter summaries use this editor too; generation settings stay inside their menu as single-line fields. The system-prompt row uses a quoted JSON string while editing so escaped newlines, tabs, and exact spacing survive inline changes. Shift+Arrow selects text with the same highlight used by mouse selection; `Ctrl+C` copies an active selection, `Cmd+V` pastes on macOS (`Ctrl+Shift+V` in conventional Linux terminals), and Esc cancels without mutating anything. 1667 also remembers its latest in-app copy, so copied prose can be pasted into an editor when the terminal cannot expose a readable system clipboard. Down on the final line moves to its end so Enter can append a new line.
