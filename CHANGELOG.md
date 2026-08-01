# Changelog

This file records notable changes to 1667. Product terms use the definitions in
[Technical terms](docs/technical-terms.md).

## Unreleased

- **Facts can now activate only when request context matches their keys.** The
  default `always` mode keeps the existing behavior. The `keyed` mode scans the
  recent assembled story context and the current instruction. The Fact editor
  sets the mode and a comma-separated key list. The Facts panel and side rail
  show the keyed activation state for the next request. Thanks @10fra for the
  request.

- **`1667 export` now writes NovelAI archives.** Use `--format story`,
  `--format scenario`, or `--format lorebook`. Use `--all` to export every
  story. The command reports content changes and omissions for each archive.

- **Stories now have an Author's Note.** Press `a` to write short steering for
  the next continuation or prompted retake. 1667 shows the note cost in the
  context meter and warns above 300 estimated tokens. Thanks @10fra for the
  request.

- **The TUI now shows the next request plan.** Press `Ctrl+R` to open the
  request viewer. It shows each message, the estimated token counts, chapter
  summary replacements, the routed model, and the context window. It does not
  show credentials. Thanks @10fra for the request and the design.

## 0.2.1 - 2026-08-01

- **`1667 import` now imports NovelAI `.story` files.** Supports Editor V2
  MessagePack documents and Editor V1 legacy stories. Story title and section
  prose are converted to 1667 story parts. Container settings, Memory, Author's
  Note, Lorebook, and retry history are not imported. Thanks @10fra for the
  request.
- **`1667 import` now imports 1667-exported Markdown files as new stories.**
  Markdown `#` headings set the story title. `##` headings become chapter
  boundaries. Prose blocks separated by blank lines become story parts.
  Thanks @10fra for the request.
- **1667 now publishes a native Windows x64 package.** The PowerShell Installer
  verifies the Release Archive and manages upgrades. CI tests the Windows
  package, private state DACLs, and Installer on Windows. Thanks @10fra for the
  request.
- **The install command now shows its progress.** It names each stage. It also
  shows the transfer while it downloads. The command was silent until it
  stopped. You could not see the difference between a slow network and a stopped
  command. The command writes the stage lines to a pipe or to a log. It does not
  write the transfer bar to a pipe or to a log.
- **`1667 upgrade` now uses plain language.** The help text, the messages, and
  the refusals tell you what occurred. They also tell you what to do. They do
  not use the internal names for the install model. The `--json` result keeps
  the same fields. It also keeps the same error codes.
- **Settings now reads the model list from the selected provider.** Use
  `Left Arrow` or `Right Arrow` to select a model. Press `Enter` to type a
  custom model name. Settings includes an OpenAI preset. The cache policy is
  not available in Settings. New profiles use the `off` cache policy.

## 0.1.2 - 2026-07-30

- **The Fact editor now shows the Fact tag in a choice row.** Press `Tab` or
  `Shift+Tab` to select a Fact tag. Press `Ctrl+T` to type a custom Fact tag.
- **Library now filters stories while you type.** Press `Enter` to close the
  filter.
- **Settings now shows the complete cache-policy error.** The message wraps
  inside the Settings panel.
- **The system prompt now uses the full-screen editor.** The editor keeps
  multiline text and exact spacing.
- **Composer errors now wrap inside the footer.** A model timeout no longer
  ends at the terminal edge.
- **Settings now shows only useful save state.** A clean panel has no save
  message. A changed panel shows `unsaved draft · s saves`. Thanks @10fra for
  the reports.
- **Release workflows now run inline TypeScript programs as ES modules.** This
  change prevents Node from treating these programs as CommonJS. Thanks @10fra
  for the report.
- **The starter tour now starts with a rainbow 1667 mark.** The mark is part of
  the first story part. It scrolls with the story. The TUI does not add a new
  screen or an editor for the mark.
- **HTTP retries now follow the selected project after a port change.** The
  backend puts a data-directory ID in HTTP health metadata. The TUI keeps an
  unfinished create or import operation for that ID. Git can track the
  data-directory ID. A restart on a different loopback port uses the same
  operation ID. A different project uses a different operation ID, even if it
  uses the old port. The backend also puts a data-directory claim ID in the
  metadata. This ID prevents a live project copy from taking over the client
  connection. The HTTP API protocol goes from 8 to 9. A version 1 retry record
  stays bound to its original loopback origin. A version 2 retry record can
  follow the same data-directory ID to a different port. The backend sends the
  two IDs only after it validates a client capability. On Linux, the legacy
  preview keeps one machine-local identity when its listener restarts. Other
  systems refuse the legacy preview because they cannot retain the data
  directory authority. HTTP server mode also requires Linux for this reason.
  The data filesystem must support durable Linux file handles. On Linux, a
  filesystem remount stops an unfinished HTTP retry. This rule prevents a
  cloned filesystem from taking over the retry. Linux HTTP mode requires Linux
  kernel 6.8 or later. The backend retains the directory authority before it
  creates or reads the data-directory ID. Supervised HTTP mode refuses a
  machine tier inside the project. The supervisor checks the platform before
  it creates state. Every HTTP listener checks the requested machine tier and
  the resolved machine tier. It does this before it writes diagnostics or
  authentication state. If recovery blocks a retry, the client keeps an
  operation ID that an earlier request used. The client removes completed
  retry claims from the active cohort. The legacy preview validates its data
  directory before it creates lease files. A listener factory must use the
  selected project data directory. Thanks @10fra for the report.
- **Stop keeps model text that already arrived.** 1667 stops the model stream.
  It waits for the request to finish in the background. It then saves the
  arrived text with the generation ID. The saved take becomes the focused take.
  A full result that wins the race uses the same generation ID. 1667 does not
  show a cancellation message for a Stop that the writer requested.
- **Enter now cycles Compose Focus in Settings.** `Enter` advances the Compose
  Focus row like the other closed-choice Settings rows. Paste does not open an
  editor for those rows. Thanks @10fra for the report.
- **The context meter now previews likely response growth.** A slow two-color
  pulse shows an estimate from recent provider prose, not the full output cap.
  The meter uses a small recent median. It excludes human nodes and summary
  nodes. With no usable history, it uses a conservative cold start near 512
  tokens. The estimate clamps to the configured max output tokens and to free
  context capacity for the projected request. The max output cap stays visible
  as secondary text. The pulse bar never uses the cap for size. Thanks @10fra
  for the report and the design.
- **Fact editing now opens directly from the Facts panel.** Press `Enter` or
  double-click a Fact to open its editor. The editor includes the `people`,
  `places`, `rules`, and `items` Fact tags from StoryTavern. A saved custom Fact
  tag becomes available for other Facts. Thanks @10fra for the design.
- **Local story changes commit with one atomic write.** A take switch, a text
  edit, a tag change, a fact change, or a chapter-break change now commits
  through one atomic publish of the story manifest. Before, each of these
  changes also wrote a caller intent, a receipt pair, and a ledger record pair,
  each with its own disk barrier. Those records protect paid model calls, and
  model-backed work keeps all of them. A crash during a local change can lose
  that one change, and only that change. It cannot damage the story, and the
  next start loads the story cleanly. On the tour vault, a take switch dropped
  from about 25 ms to about 14 ms.
- **A provider failure no longer stops the local backend.** A lost connection,
  timeout, or provider error now ends the local generation and keeps 1667
  available. This includes a model connection that fails after it sends
  response headers. A terminal saved-state check also keeps the worker
  available. 1667 reloads the story and tells the writer to try again. 1667
  does not repeat the provider request automatically. If an older interrupted
  request remains, 1667 closes the record that the story identifies. A newer
  blocked request stays replayable across a process stop. It cannot lose the
  older record ID during a request deadline or leave that record in place.
  1667 then reloads the story. The command palette no longer asks the writer
  to acknowledge an unknown generation. The private log records this recovery
  without story text, prompts, endpoints, credentials, or nested failure
  details. 1667 retries warning cleanup in the background if the first cleanup
  fails. The HTTP API protocol and the worker protocol increase from 7 to 8.
  Thus, an older process cannot discard the exact recovery record. Thanks
  @10fra for the reports.
- **`u` now takes back an added or removed chapter break only.** It also
  reversed a take switch, and it said so on each take switch. Two keys did one
  job: `←` and `→` already walk the takes of one part. Worse, a key named undo
  that answers a navigation key implies that it can answer a destructive one. It
  cannot: `d` prunes takes and their children, and nothing brings them back. `u`
  now reaches an added or removed chapter break, which includes the summary of a
  removed break. It does not reach a chapter rename, a summary edit, or any
  prose. The take-switch message no longer names it. Thanks @10fra for the
  report.
- **A fresh install now opens with facts.** The tour carries five facts about
  the instrument. "A Door in the Hedge" carries four facts about its own world.
  The facts overlay no longer opens empty at the point where the tour tells you
  to look in it. The starter vault writes the facts in the same change that
  writes the prose, so a first run does not pay a second write for each story.
- **Settings status text now sits above the footer.** The unsaved-draft notice
  and the pending-save notice moved below the fields, beside the check result.
  The read-only migration banner stays above the fields, because it changes
  what each field below it means. The notice area keeps a constant height, so a
  pending save no longer moves the fields or the rows above them. Thanks
  @10fra for the placement review.
- **A toast now always uses the footer line.** Before, a toast printed under the
  focused story part while the view followed focus, and in the footer after you
  scrolled away. A message about the application no longer enters the
  manuscript, and it no longer moves with the focus. Thanks @10fra for the
  placement review.
- **1667 no longer announces a clean startup recovery.** The message `startup
  recovery complete · state reloaded` reported an internal step at each start.
  1667 still reloads state at each start. It now reports the recovery only with
  a warning, or when the reload opens a different story. Thanks @10fra for the
  report.
- **Bookmarks are now tags.** A tag is a name and a status on the end of one
  story line. The old name told you that the mark kept a reading position. It
  does not. It names one version of the story, and the reading position is the
  story line you are on. Press `t` to tag a line. The `b` key no longer tags.
  Each tag has a status: Canon, Alt, Draft, Discarded, or Summary. Stories on
  disk do not change, and no migration is necessary. The HTTP API protocol goes
  from 5 to 6, because the story payload, the tag routes and the request body
  changed. A client and a backend from different builds must be updated
  together: an older client is now refused when it connects, instead of
  connecting and then failing to read a story. Thanks @10fra for the
  terminology review.
- **A displaced Canon line becomes Alt.** Only one story line can be Canon. When
  you make a second line Canon, the first line becomes Alt and keeps its name,
  its colour, and its date. Before, the first line lost its status. It then
  looked the same as a line with no tag. Thanks @10fra for the report.
- **1667 withholds its Windows x64 package.** The
  Windows machine tier installs a protected DACL for the current user and
  SYSTEM. Native tests reject reparse points. The launcher does not pin
  `@1667-ai/windows-x64`. npm fails an optional dependency softly. Thus, a
  launcher that named an unpublished package would install without an error.
  It would then fail at each launch. npm does not permit a replacement of a
  published version. A Windows user who runs the launcher gets the source build
  route. Routine CI does not build this target.
- **Pull request CI now builds three release targets.** Pull request CI builds
  macOS arm64, Linux arm64, and Linux x64. A push to `main` also builds macOS
  x64. CI does not build Windows x64. Thanks @10fra for the CI coverage
  decision.
- **Migrated StoryTavern bundles open in 1667.** 1667 accepts the predecessor
  manifest and text-revision identifiers without changing content hashes. New
  story writes use 1667 identifiers. Thanks @10fra for the migration report.
- **Unexpected backend failures now have private local diagnostics.** 1667
  writes bounded machine-tier logs, returns safe persisted references across
  HTTP and embedded-worker boundaries, and can mirror new entries with
  `--print-logs`. Thanks @10fra for the failure-reporting design.
- **Public documentation now describes the current repository.** The README
  states the public status and exact CI coverage. The release guide specifies
  five release packages and five release targets. Obsolete plan documents are
  removed. Thanks @10fra for the documentation audit.
- **Repository documentation shows build status and uses a defined language
  standard.** The README shows CI and standalone-build status for `main`.
  `AGENTS.md` requires ASD-STE100 for technical documentation and README files.
  Thanks @10fra for defining the standard.
- **Generation does not block local writer actions.** Provider work uses short
  durable phases. The final phase applies an operation-specific result to the
  current story. Concurrent edits remain unchanged. Linux tests cover Stop
  saves, deleted sources, manual names, and provider termination. Thanks
  @10fra for the CI failure analysis.
- **Stories use project-root storage.** 1667 searches parent directories for a
  `.1667/` project. `1667 init` creates a project. `1667 --global` opens one
  machine-wide project. `--data` selects a project root and accepts a relative
  path. An interactive start can create an absent project.
- **Provider secrets use the machine tier.** Project settings contain an
  opaque secret identifier. Each machine supplies its own secret. A project
  with a legacy `secrets.json` file fails closed and identifies the machine
  tier.
- **`1667 export` writes the selected story line to the project root.** Chapter
  titles use `##` headings. A name collision adds a suffix. `--force` permits
  replacement. 1667 does not read an exported file.
- **Project locks control concurrent writers.** A server selects a free port
  and writes `.1667/run.json`. A bare `1667 --url` uses this record. Lock
  contention identifies the owner process. The operating system releases a
  lock after a process failure.
- **`1667 init --adopt` moves legacy data into a project.** It first moves
  provider secrets to the machine tier. It refuses the operation before any
  move when it cannot adopt the complete source.
- **Project storage accepts ordinary file systems that enforce locks.** This
  change removes `--initialize-new`, `--offline-exclusive`, and the fixed
  `127.0.0.1:7373` listener. It also removes the old file-system allowlist,
  absolute `--data` requirement, and project-tier privacy scan. Strict privacy
  checks apply to the machine tier.
- **The key reference explains each visible key.** The reference groups keys
  by task. It uses available terminal columns and supports arrow-key scroll.
  Thanks @10fra for the new reference design.
- **The TUI shows the build identity.** The status bar shows the identity. The
  key reference also shows it when a narrow terminal hides the status bar.
- **1667 has an independent repository.** The terminal application and its
  embedded runtime moved out of the previous repository.
