# Changelog

This file records notable changes to 1667. Product terms use the definitions in
[Technical terms](docs/technical-terms.md).

## Unreleased

- Show live download progress for managed upgrades and the Windows Installer.
  Thanks to @10fra.

- **Prompt-token counting stops for all active provider work.** A count could
  continue before a generation showed its stream. It could also restart while
  a stopped generation was still settling. 1667 now stops an active count when
  provider work starts. It counts once after the provider owner releases the
  operation. This behavior also applies to rewrites and summaries. Thanks
  @10fra for the report.

- **1667 installs and updates in a directory that other software also uses.**
  The Installer and `1667 upgrade` refused an Install Root when any directory
  above it was group-writable or world-writable, was a symbolic link, or
  belonged to another user. Debian and Ubuntu ship `/usr/local` this way,
  Ubuntu gives each user a private group, and Homebrew ships its `bin`
  directory this way, so the refusal named a real permission bit and no real
  exposure. 1667 now judges the Install Root alone: it must be a directory this
  user owns, and no other account can be able to write it. A group-writable
  directory is accepted when the group holds nobody except this user and root,
  which is what those layouts are.

- **A refusal about an Install Root says what is wrong and how to fix it.**
  Each message names the directory, its mode, the account or group that can
  write it, and the command that corrects it.

- **`--force` installs or updates into an Install Root 1667 refused.** The
  Installer and `1667 upgrade` accept it after printing what they accepted. It
  waives no checksum, no attestation, no release identity, and no version
  check.

- **`1667 upgrade` accepts a release that supports one more platform.** The
  upgrade checked the packages of a new release against the platform list its
  own build carried, and refused a release that named one more. The first
  release with Windows support therefore stopped every earlier installation
  from updating, and the refusal came from the installed program, where no
  later fix could reach it. 1667 now checks that each package belongs to this
  product and carries the exact version of the release, so a release that adds
  a platform installs. An installation before 0.4.0 must be installed again.

- **The stable channel finds the current release.** `1667 upgrade` read a
  registry tag that a release does not write, so the stable channel stopped at
  0.2.1 and reported a newer installation as current. The stable channel now
  reads the tag each release writes.

- **Upgrade output says less.** An installation that 1667 can update no longer
  reads a sentence about how it was installed.

- **The dependency audit is clean.** 1667 now uses `fast-uri` 3.1.5. Thanks
  @10fra for the report.

- **Generation Profiles can move between projects.** Import a NovelAI Sampler
  Preset or a Profile Export with `1667 profile import`. Export a shareable
  Profile Export with `1667 profile export`. The command creates a new profile
  and reports values that the selected route cannot use. 1667 also provides
  conservative, balanced, and adventurous prose Starter Profiles.

- **A stopped or expired generation keeps all text that arrived.** After the
  writer stops a generation, the live stream does not move again. The text
  that arrives after the Stop lands in the saved take in one piece. When a
  request deadline ends a generation, the backend now sends the stream text
  that it did not post yet together with the error, and the TUI keeps that
  text with the streamed prose. The failure result does not change.
- **A retried import reports the import that occurred.** A crash could stop a
  Lorebook import or a character-card import after the story transaction
  committed and before the mutation receipt completed. A retry then computed
  a new plan from the changed story, and the report could show a smaller
  import than the import that occurred. 1667 now keeps the bounded import
  plan in the mutation receipt before the import commits. A retry returns
  that plan and its Fidelity Report. The Facts were never duplicated; only
  the report was wrong.
- **Editors now have standard clipboard actions.** Right-click an editable
  text field to open Copy, Paste, and Select all. Press `Ctrl+A` or
  `Command+A` to select all text. Direct supports these actions in its inline
  and full-screen forms. Use `Ctrl+X` or `Command+X` to cut selected text. Use
  `Ctrl+Z` or `Command+Z` to undo an edit. Add `Shift` to redo the edit. Use
  `Command+Arrow` to move to a line end or a buffer end. Use
  `Command+Backspace` to delete to the start of a line. Use `Page Up` or
  `Page Down` to move by one editor page. Thanks @10fra for the request.
- **A token probability viewer shows the alternative tokens the model
  weighed.** Press `l` on a story part to open it. The viewer shows the
  take's prose with the selected token marked, and below it the alternative
  tokens the model weighed at that position with their probabilities and log
  probabilities. Use the arrow keys to move between tokens and between
  alternatives, and `Tab` to move to the next story part. Token
  probabilities are off by default, because the alternatives make each
  response much larger. Set the alternative count on a Generation Profile to
  turn them on. OpenAI, OpenRouter, llama.cpp, KoboldCpp, and LM Studio send
  the fields. Ollama and a custom endpoint do not, because neither documents
  them. Anthropic Messages has no such field at all. When a model refuses
  the fields, 1667 sends the request again without them, and the generation
  keeps its prose. 1667 stores the alternatives beside the take that
  produced them, so they survive a restart, and removes them once no take
  refers to them. Thanks @10fra for the request.
- **Facts now support a move order, a priority, and a token budget.** Select a
  Fact in the Facts panel and press `Shift+Up Arrow` or `Shift+Down Arrow` to
  move it. The Fact editor gains a priority row (`low`, `normal`, or `high`,
  selected with the arrow keys) and a budget row (a token count, or empty for
  no cap), controlling which Facts drop first when a request does not fit
  the model's context window. Open the command palette and select
  **facts budget** to cap the combined tokens every Fact in a request may
  spend. A request that does not fit now drops droppable Facts by priority
  instead of failing outright, and the context meter and the Facts panel
  state what was dropped, and why. Thanks @10fra for the request.
- **The Sampling group now accepts phrase bias and banned strings.** Type a
  text phrase and a weight. Or type a banned string. 1667 tokenizes the
  phrase four ways: as typed, with a leading space, with a capital letter,
  and with both. 1667 biases a phrase only when every one of the four forms
  is one token. Where a phrase needs more than one token in a form, 1667
  refuses the phrase at commit and shows the token IDs, so a writer can see
  why. 1667 never spreads one phrase over more than one token, because that
  action would also change every other place those tokens appear. A phrase
  entry and a banned string merge into the same logit bias field as a token
  ID entry. A token ID that a writer sets by hand keeps priority over the
  merged value. Two phrase entries can tokenize to the same token. For
  example, "hello" and "Hello" share a form. When both entries want the same
  weight for that token, 1667 keeps both entries and biases every token
  either one names. When the entries want different weights, 1667 refuses a
  new entry at commit if it would lose the token, the same way it refuses a
  multi-token phrase. If a later commit causes an existing entry to lose the
  token, 1667 keeps that entry in the draft and marks it. 1667 refuses to
  save the settings while a marked entry stays in the draft. 1667 also
  refuses to send the request. 1667 names the entry that kept the token and
  the exact forms that lost their bias. A banned string makes the text
  unlikely. It does not make the text impossible, because the same text can
  come from different token boundaries. Phrase bias works for an OpenAI
  model on the tokenizer list, for llama.cpp, and for KoboldCpp, which 1667
  asks to tokenize the text directly. Banned strings work the same way for
  OpenAI and llama.cpp. They do not yet work for LM Studio, Ollama,
  OpenRouter, or a custom endpoint. 1667 shows a clear reason when a
  phrase, a banned string, or logit bias itself is not available for the
  routed model.
- **KoboldCpp banned strings send the literal text, not a token bias.** 1667
  sends a KoboldCpp banned string to its own banned-string field instead of
  tokenizing it. This needs no tokenizer at all, so 1667 accepts a banned
  string of more than one token on KoboldCpp, where every other preset
  refuses it. A banned string on KoboldCpp still only makes the text
  unlikely, the same promise as every other preset. A banned string cannot
  name the same word as a phrase bias entry in the same scope. 1667 refuses
  to save this combination. 1667 also refuses to send it, and names the
  conflicting phrase bias entry.
- **A story can now set its own phrase bias and banned strings.** Open the
  command palette. Select **phrase bias** or **banned strings**. Each list
  adds to the profile's own list; it does not replace it. 1667 merges the
  profile's lists first, then the story's lists. When a story entry and a
  profile entry name the same token with different weights, the story entry
  wins. 1667 does not block the request in this case. When two profile
  entries, or two story entries, name the same token with different weights,
  1667 still blocks the request, the same as it already does for two
  profile entries. 1667 blocks the request even when a third entry from the
  other side also names that token and wins it. Thanks @10fra for the
  request.
- **Character card import now reads Character Card V3.** This covers V3 JSON
  and the `ccv3` PNG chunk; when a PNG has both `ccv3` and a V1 or V2 `chara`
  fallback, 1667 reads `ccv3`. A V3 or V2 card's embedded `character_book`
  becomes Facts through the same Entry Mapping as `1667 import-lorebook`: a
  constant entry becomes an always-active Fact, and a keyed entry keeps its
  keys. The Fidelity Report names the `character_book` mechanisms a Fact has
  no place for, and the V3 fields this converter does not import — greetings,
  example messages, assets, creator notes, the system prompt, the
  post-history instructions, the character version, tags, and the creator.
  CHARX, the zip container, stays unsupported. Thanks @10fra for the request.
- **The Author's Note now has a depth setting.** Depth sets how many story
  parts from the end the note lands before. The default depth, 1, is today's
  placement: immediately before the last story part. Open the Author's Note
  editor and press `⌥-` or `⌥=` to change it. The request viewer shows the
  placement the note actually used.
- **Stories can now override the default Author Brief.** Open the command
  palette. Select **Author brief**. A story Author Brief overrides the
  machine-wide default for that story's continuation, prompted retake,
  highlighted rewrite, and autoname requests. A story with no Author Brief of
  its own keeps the machine-wide default. Thanks @10fra for the request.
- **The context meter and the request viewer now count tokens.** Before, they
  counted four characters for each token. 1667 now uses the tokenize source of
  the preset: the bundled tokenizer for the official OpenAI host, the count
  endpoint for the official Anthropic host, and the tokenize endpoint of
  llama.cpp or KoboldCpp. An exact count shows no mark. A near-exact count
  shows `≈`. A preset with no tokenize source keeps the `~` estimate. 1667
  counts the request after you stop typing, so a count never delays a
  keystroke. If the model server does not answer, 1667 keeps the estimate.
  Thanks @10fra for the request.
- **`1667 import-lorebook` now reads a SillyTavern World Info file.** Give the
  `.json` file to the command or to `import archive` in the command palette.
  1667 reads the file to know its format. A constant Entry becomes an always
  active Fact, and a keyed Entry keeps its keys. The Fidelity Report gives the
  World Info mechanisms that a Fact has no place for. Thanks @10fra for the
  request.

- **Settings now includes a collapsed Sampling group.** Open the group to
  edit scalar values, stop sequences, and logit bias rows. The TUI shows a
  short reason for an unavailable value. An unavailable scalar row shows
  `‹ — ›`. A save keeps the draft when a configured value is unavailable.
  Thanks @10fra for the report.
- **The Sampling group now offers DRY, XTC, dynamic temperature, and
  Mirostat.** llama.cpp and KoboldCpp are the presets that accept these
  parameters. The panel groups the new rows under a rule line for each
  parameter family. `mirostat` reads `off`, `v1`, or `v2`. `mirostat tau` and
  `mirostat eta` open once Mirostat is on. Thanks @10fra for the request.
- **A NovelAI `.story` or `.scenario` export now carries the Facts, the Memory,
  and the Author's Note.** An export and an import carry the same items, so a
  story that leaves 1667 and comes back keeps the world that steers it. A
  Scenario now carries the story's own Author's Note in place of the author
  brief. Thanks @10fra for the report.

- **`1667 --help` is now one page for each command.** The first page gives the
  commands and the usual options, and it fits a short terminal. Use
  `1667 <command> --help` for what one command accepts. This command also
  replaces the error that `1667 import --help` gave before. Thanks @10fra for
  the report.

- **1667 can now import character cards into an existing story.** The command
  palette opens a path prompt with `Tab` completion. The `1667 import-card`
  command accepts one or more JSON or PNG files. It adds their Facts to the
  story that `--story` names. Thanks @10fra for the request.

## 0.2.1 - 2026-08-01

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
