# Changelog

This file records notable changes to 1667. Product terms use the definitions in
[Technical terms](docs/technical-terms.md).

## Unreleased

- **Windows upgrades show the correct next command.** Stable update checks do
  not show beta releases. A PowerShell Installation now gives the PowerShell
  Installer command for a stable release. For beta, 1667 gives commands to
  download and verify the release Installer before it runs. An exact
  prerelease no longer names an Installer file that does not exist.
- **New users start with the Graphite theme.** Existing users keep their saved
  theme. An older config without a theme keeps the Lantern theme. The Theme row
  now appears in Simple Settings.
- **The starter tour ends with setup instructions.** It tells the user how to
  delete the onboarding stories and select a model provider.

## 0.10.4-rc.1 - 2026-08-28

- **Graphite and bone themes use the 1667 website colors.** Select either
  theme in Settings or from the command palette. Both themes include truecolor
  and 256-color palettes.

## 0.10.3 - 2026-08-26

- **This release has no additional product changes.** It contains the same
  behavior as 0.10.3-rc.6.

## 0.10.3-rc.6 - 2026-08-26

- **Aside mouse actions keep their exact target.** Right-clicking selected
  text preserves the selection, active turn, focus, and scroll position. Each
  Use Selection, Use Answer, and visible session hop item works with one
  click, including in narrow or clipped layouts. A failed delete preserves
  its target and error for retry. Existing legacy Side Notes remain available.

## 0.10.3-rc.5 - 2026-08-26

- **Aside text selection works across the full chat width.** Questions and
  answers use distinct `You` and `Assistant` labels, and question rows keep a
  stronger visual treatment without adding a selection-breaking side pane.
  Copying across both roles keeps the complete exchange.
- **Destructive shortcuts use capital `D` consistently.** Aside turns, Facts,
  chapter breaks, tags, Sampling entries, and Generation Profiles require a
  confirmation before deletion. A different action cancels the confirmation.
  Lowercase `d` is non-destructive.

## 0.10.3-rc.4 - 2026-08-26

- **Aside keeps selected text and turn context visible.** Highlighted answer
  text stays highlighted while the Use selection menu is open, including
  during a saved turn update. Up and Down navigation shows the selected
  question from its first line and keeps as much answer visible as the screen
  permits.

## 0.10.3-rc.3 - 2026-08-26

- **Aside shows selected turns and status clearly.** Wrapped lines in the
  selected question keep their highlight. The writing and thinking labels
  animate. Anchored sessions show the correct part and take after reads and
  updates.

## 0.10.3-rc.2 - 2026-08-26

- **Aside keeps long chats readable and selectable.** Wrapped questions keep
  their question style. Scroll history without changing the selected turn,
  including while an answer streams. Highlight saved answer text and
  right-click to copy it or insert it into the composer, a new Fact, or the
  story. The full-answer menu can also create a new Fact. Large Aside
  histories stay responsive. Existing Side Notes remain available.

## 0.10.3-rc.1 - 2026-08-26

- **The tree map draws the whole story in lanes.** Rows are reading order. Each live story
  line owns a two-column lane. A line that ends hands its lane back and the next fork reuses
  it. Lane 0 is the reading line. Press `←` or `→` to jump to the nearest row in the next
  lane. Press `tab` to hide the lanes and open the path view on the same part.

- **The streaming gutter pair stays visible while a long take scrolls.** The
  `writing · esc stops` and `thinking · esc stops · T peeks` lines stick to
  the top of the visible part, the same way the focused verb menu does.

- **Aside now keeps separate chats for story takes.** Use the session and
  anchor controls to review each chat. Existing Side Notes remain available
  in the unanchored bucket. Optional Thoughts stay visible only in Aside and
  do not enter a later model request.

## 0.10.2 - 2026-08-23

- **This release has no additional product changes.** It contains the same
  behavior as 0.10.2-rc.2.

## 0.10.2-rc.2 - 2026-08-23

- **The command palette opens each Settings control.** Search for a Settings
  row or a Sampling control to open it directly. A hidden Advanced row opens
  without changing the saved Settings view.

## 0.10.2-rc.1 - 2026-08-22

- **Settings now controls the guidance for each writing action.** The simple
  view contains the Default Author Brief and Default Continue direction. The
  advanced view also contains the Rewrite, Title, Summary, and Aside guidance.
  Existing default values keep the previous model requests unchanged.

- **A prompt opens in a full-screen editor.** Press Ctrl+S to keep an edited
  prompt in the Settings draft. Save Settings to activate all draft changes.

- **The first prompt save upgrades the Settings data.** An older 1667 release
  refuses the new Settings schema. Use this beta only when that downgrade
  limit is acceptable.

## 0.10.1 - 2026-08-21

- **This release has no additional product changes.** It contains the same
  behavior as 0.10.1-rc.2.

## 0.10.1-rc.2 - 2026-08-21

- **The left story gutter now lights the active `writing` label.** It uses the
  same moving light as `thinking`. Narrow layouts do not schedule hidden
  gutter frames.

## 0.10.1-rc.1 - 2026-08-21

- **This beta has no additional product changes.** It contains the same
  behavior as 0.10.0.

## 0.10.0 - 2026-08-21

- **1667 prepares separate controls for Generation Effort and Thinking Mode.**
  This release reads and runs the successor Settings schema. It refuses to
  change that schema. A later release can write it and show the new controls
  without making this release lose a setting.

- **Fast model responses now appear at a steady reading pace.** 1667 presents
  large stream batches in small steps. Slow streams stay responsive. Stop and
  story storage continue to use the complete received response.

- **The Library word count includes every story branch.** It counts prose from
  all takes and counts each shared part once. Selecting a different take no
  longer changes the stored total.

- **Active work labels now show a moving light.** The `working` and `thinking`
  labels animate while work is active. The text and layout do not move.

## 0.9.11-rc.1 - 2026-08-21

- **Fast model responses now appear at a steady reading pace.** 1667 presents
  large stream batches in small steps. Slow streams stay responsive. Stop and
  story storage continue to use the complete received response.

- **The Library word count includes every story branch.** It counts prose from
  all takes and counts each shared part once. Selecting a different take no
  longer changes the stored total.

- **Active work labels now show a moving light.** The `working` and `thinking`
  labels animate while work is active. The text and layout do not move.

## 0.9.10 - 2026-08-20

- **This release has no additional product changes.** It contains the same
  behavior as 0.9.10-rc.7.

## 0.9.10-rc.7 - 2026-08-20

- **This beta has no additional product changes.** It contains the same
  behavior as 0.9.10-rc.6.

## 0.9.10-rc.6 - 2026-08-20

- **1667 now reports available releases by default.** You can turn update
  checks off in Settings. The check stays silent when the network is not
  available. Existing config files use the new default. A Managed Installation
  notice shows the checked version and channel in the upgrade command. Other
  notices show only the new version.

- **Managed installations at 0.9.9 can upgrade to this release.** The npm
  packages keep the notice that 0.9.9 accepts. Each SPDX SBOM contains the
  current notice. Future notice changes do not break this upgrade path.

- **Subscription plans use one model picker action.** Press Enter to open the
  model picker for a ChatGPT Plan or a Claude Plan. Left Arrow and Right Arrow
  do not change these models.

- **The Settings mode action shows its destination.** The action says
  `m advanced` in simple mode. It says `m simple` in advanced mode.

## 0.9.10-rc.5 - 2026-08-20

- **Settings opens in a simple view.** The simple view shows the system
  prompt, the provider, the model, and the context size. It also shows the
  base URL and the API key when the provider needs them. Press `m` for the
  advanced view, which shows every row. 1667 keeps your choice.

- **A model change finds the context size.** When you select a model, 1667
  asks the provider for the context size and sets it. A size that you type
  stays. 1667 shows a message on the context size row when the request
  fails.

- **ChatGPT and Claude plans show their bundled model catalogs.** Select a
  model in Settings, or enter a model ID manually.

## 0.9.10-rc.4 - 2026-08-20

- **The Shell Installer can update a Managed Installation.** Run the Installer
  again to recover when an old 1667 version refuses a package with updated
  legal notices. The Installer keeps the Installation ID and the previous
  executable. It refuses an unmanaged executable and an automatic downgrade.

## 0.9.10-rc.3 - 2026-08-19

- **This beta has no additional product changes.** It contains the same
  behavior as 0.9.10-rc.2.

## 0.9.10-rc.2 - 2026-08-19

- **A slow generation Stop keeps 1667 open.** If the embedded backend needs
  more than 10 seconds to stop a generation, 1667 now checks the operation
  status. It keeps the application open while the backend answers. It still
  requires a restart if the backend stops answering.

- **Fresh Settings can select a signed-in subscription plan.** When exactly
  one plan is signed in, Settings selects that plan as an unsaved draft. Both
  or neither signed-in plan keeps the current choice. Settings does not replace
  a choice that the user saved.

- **Managed upgrades accept updated legal notices.** An installed version no
  longer compares a new package's `LICENSE` and `NOTICE` files with its own old
  copies. The release process still requires the reviewed files. The updater
  still checks the package contents, metadata, integrity, and source identity.

## 0.9.10-rc.1 - 2026-08-19

- **ChatGPT and Claude subscriptions can connect directly.** Run
  `1667 auth login chatgpt` to connect a ChatGPT plan. Run
  `1667 auth login claude` to connect a Claude plan. Settings can use both
  connections. 1667 keeps the subscription credentials on this machine.

## 0.9.9 - 2026-08-17

- **Settings reads remain available during activation.** 1667 now serializes a
  settings read and a settings authority replacement in one process. A read no
  longer fails while activation replaces the settings authority.

- **Stopped takes keep their thought and finish cleanly.** If **Keep thought**
  is on, a take saved after Stop or a clean timeout keeps the thought that was
  visible during streaming. 1667 also gives an embedded model server more time
  to close after Stop. This prevents a restart-required error during normal
  cleanup.

## 0.9.8 - 2026-08-17

- **Settings shows important controls and help sooner.** The system prompt is
  now near the top of the panel. The panel uses its bottom space to show how
  many settings are above or below the visible list. Select a setting to read
  its complete description. Long descriptions wrap instead of ending at the
  panel edge. The descriptions now explain the effect of each setting.

- **The cache-stable continuation prompt is now an optional experiment.** The
  **prompt layout** row in a Generation Profile is off by default. The off
  value keeps the v0.8.0 Continue and Retake prompt. The on value moves the
  operation-specific contract after the story history. Profile Export files
  preserve the enabled value.

## 0.9.7 - 2026-08-16

- **Internal errors now include useful diagnostic text.** 1667 shows the
  error name, the error message, and a short cause chain. It keeps the
  `err_…` reference as a link to the detailed local log. The visible message
  does not include a stack or a provider response body.

## 0.9.6 - 2026-08-16

- **Stopping an Aside answer keeps the text that arrived.** Press `Esc` after
  answer text appears to save that text as a Side Note. If no answer text
  appears, 1667 restores the question.

- **The PowerShell Installer shows the command that starts 1667.** After the
  installation, the Installer shows the exact executable path. This command
  works when the Install Root is not in `PATH`.

## 0.9.6-rc.2 - 2026-08-15

- **Aside and the Author's Note have new navigation keys.** Press `a` to open
  Aside. Press `n` to edit the Author's Note. To create a story, press `o` to
  open Library, and then press `n`.

## 0.9.6-rc.1 - 2026-08-15

- **A Side Note can now add text to Direct or to the story.** In Aside, press
  `Tab` to focus the saved Side Notes. Press `Enter` to open the use menu.
  **insert into compose** puts the complete answer at the Direct cursor and
  keeps the existing draft. **insert into story…** opens Placement mode. Use
  the Up Arrow and Down Arrow keys to select an existing Part for a new Take,
  or select the final gap for a new Part. Press `Enter` to add the text. Press
  `Esc` to return to Aside without a story change.

## 0.9.5 - 2026-08-14

- **Prompt-plan changes now have a Gemma quality gate.** The gate compares the
  v0.8.0 prompt with a candidate on one frozen story and one fixed profile. It
  uses blind Retake and Continue scores. It requires no score regression for
  any operation, seed, or rubric field. CI checks the committed evidence. It
  does not run Gemma 4 31B.

- **Banned strings now save from Settings.** Adding a banned string no longer
  reports `logitBias must be an object`. Settings now copies each sampling
  value before it sends the settings document to the worker.

## 0.9.5-rc.1 - 2026-08-13

- **Aside adds non-canon Side Notes to a story.** Use `/aside` or the Command
  Palette to discuss the open story. Each question and answer stays with that
  story. Side Notes never enter Write prompts or Markdown exports. Use
  `/clear` in Aside to remove all Side Notes from the story.

## 0.9.4 - 2026-08-13

- **Banned strings can be added when the raw token bias map is empty.** The
  preview now treats an omitted empty map as an empty map. It continues to
  refuse malformed maps.

## 0.9.4-rc.4 - 2026-08-13

- **`1667 upgrade --list` shows published launcher releases.** It writes one
  version on each line, with the newest version first. Use `--json` to get a
  `versions` array. 1667 checks platform support when `--version` selects a
  release.

- **An exact version can reuse the previous executable.** If
  `.1667-previous` has the version that `--version` selects, 1667 verifies and
  uses it. It does not download that version again. `--rollback` continues to
  use the same file offline.

- **The chapter title editor now has a movable caret.** The left and right
  arrow keys move the caret. Insert, delete, and paste operations use the caret
  position.

- **The mouse now selects fields in the Fact editor.** A click selects the
  Fact text field or choice field under the pointer. Use the left and right
  arrow keys to change a selected choice. The mouse wheel scrolls a long Fact
  body.

- **Chapter summarization now identifies its work and its limits.** The
  status line shows the chapter, the current stage, and that the model does not
  report progress. Press `Esc` to stop the summary request.

- **1667 prepares to save non-canon Side Notes with a story.** This release
  contains the Aside implementation and keeps every entry point closed. It
  cannot open `/aside` yet. This release reads and validates the successor
  story document and refuses to change it. A later release can write that
  document and open Aside without making this release damage the story.

## 0.9.4-rc.3 - 2026-08-13

- **Continuation prompts now match version 0.8.0.** 1667 again sends the
  operation-specific contract before the story. It no longer sends the generic
  story contract or llama.cpp Chat Completions continuation fields.

## 0.9.4-rc.2 - 2026-08-13

- **The Windows Installer keeps inherited permissions on the Install Root.**
  Before this fix, the Installer replaced the Install Root permissions. A
  restricted user shell could create files there but could not replace those
  permissions, so installation failed with an access denied error.

## 0.9.4-rc.1 - 2026-08-13

- **Local Chat Completions keep a continuation on the active assistant
  passage.** The stable prompt now tells the model how to continue the final
  assistant message. 1667 also sends the llama.cpp continuation fields when
  the final message is an assistant message.

## 0.9.3 - 2026-08-13

- **`1667 upgrade --version` can select an older release.** 1667 verifies the
  exact published release before it replaces the current executable. Before it
  downloads a downgrade, it warns that the downgrade can make the Vault
  unreadable or damage Vault data. Back up the Vault before you continue. An
  exact version does not change the saved update channel.

## 0.9.2 - 2026-08-13

- **The dependency audit is clean.** 1667 now uses `fast-uri` 3.1.5.

- **Local model servers keep the story-writing instruction during a
  continuation.** An assistant prefill has no final user message. This path
  could omit the operation contract and make a long continuation lose focus.
  1667 now keeps the mode-independent part of the contract in the stable
  prompt prefix. The mode-dependent part stays in the final user message when
  that message exists.

## 0.9.1 - 2026-08-13

- **You can save an empty Author Brief.** Clear the Author Brief in Settings
  when you do not want a system instruction. 1667 now accepts and saves the
  empty value.

- **Chapter summaries can finish.** 1667 no longer limits a chapter summary to
  the same token count that it asks the model to target. The configured Max
  output tokens value now gives the model space to finish.

- **A generation refusal disappears when generation ends.** If you press a key
  that 1667 refuses during generation, the refusal now clears when generation
  ends. It no longer tells you to stop a generation that has already ended.

- **Sampling refusal text wraps instead of stopping at the panel edge.** A
  refusal now keeps its complete reason and recovery instruction visible.

## 0.9.0 - 2026-08-12

- **A story that fills the context window can summarize again.** Before this
  fix, a story that grew to fill the model's context window could not write
  and could not summarize either: the one operation that shortens the story
  was refused for being too long itself. 1667 now looks backward for an
  earlier point that still fits and summarizes there instead. It tells you
  when the summary covers less than you asked for, and names the point where
  it stopped. It refuses only when no point fits at all, and that message now
  names a fix you can act on.

- **You can attach an image to a request.** Paste an image, or run `attach
  image` and give a path. The composer shows a row for each attached image.
  1667 sends the images with your instruction, and the take keeps them, so a
  later request in the same line sends them again. 1667 offers this only when
  the selected model states that it accepts images. 1667 does not offer image
  attachment when it cannot tell.

## 0.8.0 - 2026-08-11

- **1667 no longer ends a generation while a model server is still
  processing the prompt.** Prefill is the model server's work before it
  sends the first output token. The server sends no stream output while it
  does this, and a large prompt takes longer to prefill than a short prompt.
  1667 cannot tell a server that is still prefilling apart from a server
  that failed, so it now waits for the first token until the connection's
  own total deadline, not the shorter first-token value alone. The headers
  deadline is unchanged: a server that has not returned response headers
  still ends the generation quickly.

- **Three connection deadlines are editable in Settings.** The new
  **headers**, **idle**, and **total** rows sit under the **connection**
  section. Each value already lived in the settings document, and Settings
  now shows and edits it directly instead of a hand edit of the settings
  file. There is no row for the first-token deadline, because 1667 waits for
  the first token until the **total** deadline and a first-token value
  cannot change a request. To give a slow prompt more time, raise **total**.

- **1667 prepares to send images to a model.** This release contains the
  complete Image Input implementation and keeps every entry point closed. It
  cannot attach an image yet. 1667 releases a new storage schema in two steps:
  this release reads and validates the successor story and settings documents
  and refuses to change them, and the next release writes them. That order lets
  a writer go back one version without losing a story or a setting. The next
  release opens the feature.

## 0.7.0 - 2026-08-10

- **The log now shows a release note with its paragraphs and list kept.**
  Before this fix, the log joined a release note into one line, and it
  showed the raw `**` and backtick marks. The log now keeps each paragraph
  and each list item on its own line. It also shows bold text and code text
  in their own style, with the marks removed.

- **Every generated take keeps its request details.** Press `h` on a take to
  open the Generation Record Viewer. It shows the provider, the model, the
  effective settings, provider adjustments, and the ordered request pipeline.
  It keeps the request text from that generation after a later edit. It never
  stores a credential, a custom header value, or a base URL.

## 0.6.1 - 2026-08-10

- **Alt count no longer loses a long generation on KoboldCpp.** KoboldCpp
  sends the alternative tokens of a whole generation in one message, so that
  message grows with the generation. Past about a thousand tokens it crossed a
  size limit, and 1667 ended the generation and dropped the prose. The limit
  now follows the output limit for the generation, up to a fixed ceiling. A
  message within that limit but still too large to keep gives no alternative
  token for that take, and the generation keeps its prose. A message past the
  ceiling still ends the generation, the same as any other oversized response
  from the model.

- **A Fact can now hold up to 100,000 characters, and an over-long Fact says
  so.** The old limit was 4,000 characters, well under what a NovelAI
  Lorebook entry or a SillyTavern World Info entry allows. The token budget
  already governs what a request sends, so the character limit no longer
  needs to be so tight. The Fact editor shows a character count as a Fact
  nears the new limit. It also refuses an over-limit Fact right away, with a
  message that names the limit. Before this fix, the refusal could arrive
  after the writer's next keystroke had already cleared it from view.

- **1667 shows the release notes after an upgrade.** The first run of a new
  build shows a toast: `Updated to <version> · press ! for what changed`.
  Press `!` to open the log. The log shows the release note for each version
  between your last run and this one. An existing installation that predates
  this feature shows the release note for the version it lands on, because
  1667 cannot know its earlier version. 1667 shows this one time for each
  upgrade. A fresh install shows nothing, because a new writer has no earlier
  version to compare against.

## 0.6.0 - 2026-08-10

- **1667 shows what a model thinks before it writes.** Some models write
  reasoning text before prose. 1667 calls this text a thought and keeps it
  apart from your story. The margin shows `⟳ thinking` while the model works,
  then the word `thought` on a story part that has one. Press `T` to unfold it
  above the prose, behind a rail. The new **Reasoning** row in Settings selects
  off, marker, or open, and the new **Keep thought** row selects whether 1667
  saves each thought with its take.

- **A model that thinks for a long time no longer stops at the first-token
  deadline.** 1667 waited for prose. A model that thinks first sent no prose,
  so the deadline ended the generation while the model was still working. 1667
  now accepts any stream activity, and reasoning text counts.

## 0.5.5 - 2026-08-10

- **Settings loads a provider's only model before Save.** A provider or base
  URL change could return one model while the model row stayed blank. The
  writer then had to save or select the model. Settings now selects the model
  when the current model is blank. It does not replace a model name that the
  writer typed.

## 0.5.4 - 2026-08-09

- Show live download progress for managed upgrades and the Windows Installer.

## 0.5.3 - 2026-08-09

- **Prompt-token counting stops for all active provider work.** A count could
  continue before a generation showed its stream. It could also restart while
  a stopped generation was still settling. 1667 now stops an active count when
  provider work starts. It counts once after the provider owner releases the
  operation. This behavior also applies to rewrites and summaries.

## 0.4.2 - 2026-08-07

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

## 0.4.1 - 2026-08-07

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

## 0.4.0 - 2026-08-07

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

## 0.3.0 - 2026-08-05

- **Editors now have standard clipboard actions.** Right-click an editable
  text field to open Copy, Paste, and Select all. Press `Ctrl+A` or
  `Command+A` to select all text. Direct supports these actions in its inline
  and full-screen forms. Use `Ctrl+X` or `Command+X` to cut selected text. Use
  `Ctrl+Z` or `Command+Z` to undo an edit. Add `Shift` to redo the edit. Use
  `Command+Arrow` to move to a line end or a buffer end. Use
  `Command+Backspace` to delete to the start of a line. Use `Page Up` or
  `Page Down` to move by one editor page.

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
  refers to them.

- **Facts now support a move order, a priority, and a token budget.** Select a
  Fact in the Facts panel and press `Shift+Up Arrow` or `Shift+Down Arrow` to
  move it. The Fact editor gains a priority row (`low`, `normal`, or `high`,
  selected with the arrow keys) and a budget row (a token count, or empty for
  no cap), controlling which Facts drop first when a request does not fit
  the model's context window. Open the command palette and select
  **facts budget** to cap the combined tokens every Fact in a request may
  spend. A request that does not fit now drops droppable Facts by priority
  instead of failing outright, and the context meter and the Facts panel
  state what was dropped, and why.

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
  other side also names that token and wins it.

- **Character card import now reads Character Card V3.** This covers V3 JSON
  and the `ccv3` PNG chunk; when a PNG has both `ccv3` and a V1 or V2 `chara`
  fallback, 1667 reads `ccv3`. A V3 or V2 card's embedded `character_book`
  becomes Facts through the same Entry Mapping as `1667 import-lorebook`: a
  constant entry becomes an always-active Fact, and a keyed entry keeps its
  keys. The Fidelity Report names the `character_book` mechanisms a Fact has
  no place for, and the V3 fields this converter does not import — greetings,
  example messages, assets, creator notes, the system prompt, the
  post-history instructions, the character version, tags, and the creator.
  CHARX, the zip container, stays unsupported.

- **The Author's Note now has a depth setting.** Depth sets how many story
  parts from the end the note lands before. The default depth, 1, is today's
  placement: immediately before the last story part. Open the Author's Note
  editor and press `⌥-` or `⌥=` to change it. The request viewer shows the
  placement the note actually used.

- **Stories can now override the default Author Brief.** Open the command
  palette. Select **Author brief**. A story Author Brief overrides the
  machine-wide default for that story's continuation, prompted retake,
  highlighted rewrite, and autoname requests. A story with no Author Brief of
  its own keeps the machine-wide default.

- **The context meter and the request viewer now count tokens.** Before, they
  counted four characters for each token. 1667 now uses the tokenize source of
  the preset: the bundled tokenizer for the official OpenAI host, the count
  endpoint for the official Anthropic host, and the tokenize endpoint of
  llama.cpp or KoboldCpp. An exact count shows no mark. A near-exact count
  shows `≈`. A preset with no tokenize source keeps the `~` estimate. 1667
  counts the request after you stop typing, so a count never delays a
  keystroke. If the model server does not answer, 1667 keeps the estimate.

- **`1667 import-lorebook` now reads a SillyTavern World Info file.** Give the
  `.json` file to the command or to `import archive` in the command palette.
  1667 reads the file to know its format. A constant Entry becomes an always
  active Fact, and a keyed Entry keeps its keys. The Fidelity Report gives the
  World Info mechanisms that a Fact has no place for.

- **Settings now includes a collapsed Sampling group.** Open the group to
  edit scalar values, stop sequences, and logit bias rows. The TUI shows a
  short reason for an unavailable value. An unavailable scalar row shows
  `‹ — ›`. A save keeps the draft when a configured value is unavailable.

- **The Sampling group now offers DRY, XTC, dynamic temperature, and
  Mirostat.** llama.cpp and KoboldCpp are the presets that accept these
  parameters. The panel groups the new rows under a rule line for each
  parameter family. `mirostat` reads `off`, `v1`, or `v2`. `mirostat tau` and
  `mirostat eta` open once Mirostat is on.

- **A NovelAI `.story` or `.scenario` export now carries the Facts, the Memory,
  and the Author's Note.** An export and an import carry the same items, so a
  story that leaves 1667 and comes back keeps the world that steers it. A
  Scenario now carries the story's own Author's Note in place of the author
  brief.

- **`1667 --help` is now one page for each command.** The first page gives the
  commands and the usual options, and it fits a short terminal. Use
  `1667 <command> --help` for what one command accepts. This command also
  replaces the error that `1667 import --help` gave before.

- **1667 can now import character cards into an existing story.** The command
  palette opens a path prompt with `Tab` completion. The `1667 import-card`
  command accepts one or more JSON or PNG files. It adds their Facts to the
  story that `--story` names.

## 0.2.1 - 2026-08-01

- **Facts can now activate only when request context matches their keys.** The
  default `always` mode keeps the existing behavior. The `keyed` mode scans the
  recent assembled story context and the current instruction. The Fact editor
  sets the mode and a comma-separated key list. The Facts panel and side rail
  show the keyed activation state for the next request.

- **`1667 export` now writes NovelAI archives.** Use `--format story`,
  `--format scenario`, or `--format lorebook`. Use `--all` to export every
  story. The command reports content changes and omissions for each archive.

- **Stories now have an Author's Note.** Press `a` to write short steering for
  the next continuation or prompted retake. 1667 shows the note cost in the
  context meter and warns above 300 estimated tokens.

- **The TUI now shows the next request plan.** Press `Ctrl+R` to open the
  request viewer. It shows each message, the estimated token counts, chapter
  summary replacements, the routed model, and the context window. It does not
  show credentials.

- **`1667 import` now imports NovelAI `.story` files.** Supports Editor V2
  MessagePack documents and Editor V1 legacy stories. Story title and section
  prose are converted to 1667 story parts. Container settings, Memory, Author's
  Note, Lorebook, and retry history are not imported.
- **`1667 import` now imports 1667-exported Markdown files as new stories.**
  Markdown `#` headings set the story title. `##` headings become chapter
  boundaries. Prose blocks separated by blank lines become story parts.
- **1667 now publishes a native Windows x64 package.** The PowerShell Installer
  verifies the Release Archive and manages upgrades. CI tests the Windows
  package, private state DACLs, and Installer on Windows.
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
  message. A changed panel shows `unsaved draft · s saves`.
- **Release workflows now run inline TypeScript programs as ES modules.** This
  change prevents Node from treating these programs as CommonJS.
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
  selected project data directory.
- **Stop keeps model text that already arrived.** 1667 stops the model stream.
  It waits for the request to finish in the background. It then saves the
  arrived text with the generation ID. The saved take becomes the focused take.
  A full result that wins the race uses the same generation ID. 1667 does not
  show a cancellation message for a Stop that the writer requested.
- **Enter now cycles Compose Focus in Settings.** `Enter` advances the Compose
  Focus row like the other closed-choice Settings rows. Paste does not open an
  editor for those rows.
- **The context meter now previews likely response growth.** A slow two-color
  pulse shows an estimate from recent provider prose, not the full output cap.
  The meter uses a small recent median. It excludes human nodes and summary
  nodes. With no usable history, it uses a conservative cold start near 512
  tokens. The estimate clamps to the configured max output tokens and to free
  context capacity for the projected request. The max output cap stays visible
  as secondary text. The pulse bar never uses the cap for size.
- **Fact editing now opens directly from the Facts panel.** Press `Enter` or
  double-click a Fact to open its editor. The editor includes the `people`,
  `places`, `rules`, and `items` Fact tags from StoryTavern. A saved custom Fact
  tag becomes available for other Facts.
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
  Thus, an older process cannot discard the exact recovery record.
- **`u` now takes back an added or removed chapter break only.** It also
  reversed a take switch, and it said so on each take switch. Two keys did one
  job: `←` and `→` already walk the takes of one part. Worse, a key named undo
  that answers a navigation key implies that it can answer a destructive one. It
  cannot: prune removes takes and their children, and nothing brings them back. `u`
  now reaches an added or removed chapter break, which includes the summary of a
  removed break. It does not reach a chapter rename, a summary edit, or any
  prose. The take-switch message no longer names it.
- **A fresh install now opens with facts.** The tour carries five facts about
  the instrument. "A Door in the Hedge" carries four facts about its own world.
  The facts overlay no longer opens empty at the point where the tour tells you
  to look in it. The starter vault writes the facts in the same change that
  writes the prose, so a first run does not pay a second write for each story.
- **Settings status text now sits above the footer.** The unsaved-draft notice
  and the pending-save notice moved below the fields, beside the check result.
  The read-only migration banner stays above the fields, because it changes
  what each field below it means. The notice area keeps a constant height, so a
  pending save no longer moves the fields or the rows above them.
- **A toast now always uses the footer line.** Before, a toast printed under the
  focused story part while the view followed focus, and in the footer after you
  scrolled away. A message about the application no longer enters the
  manuscript, and it no longer moves with the focus.
- **1667 no longer announces a clean startup recovery.** The message `startup
  recovery complete · state reloaded` reported an internal step at each start.
  1667 still reloads state at each start. It now reports the recovery only with
  a warning, or when the reload opens a different story.
- **Bookmarks are now tags.** A tag is a name and a status on the end of one
  story line. The old name told you that the mark kept a reading position. It
  does not. It names one version of the story, and the reading position is the
  story line you are on. Press `t` to tag a line. The `b` key no longer tags.
  Each tag has a status: Canon, Alt, Draft, Discarded, or Summary. Stories on
  disk do not change, and no migration is necessary. The HTTP API protocol goes
  from 5 to 6, because the story payload, the tag routes and the request body
  changed. A client and a backend from different builds must be updated
  together: an older client is now refused when it connects, instead of
  connecting and then failing to read a story.
- **A displaced Canon line becomes Alt.** Only one story line can be Canon. When
  you make a second line Canon, the first line becomes Alt and keeps its name,
  its colour, and its date. Before, the first line lost its status. It then
  looked the same as a line with no tag.
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
  x64. CI does not build Windows x64.
- **Migrated StoryTavern bundles open in 1667.** 1667 accepts the predecessor
  manifest and text-revision identifiers without changing content hashes. New
  story writes use 1667 identifiers.
- **Unexpected backend failures now have private local diagnostics.** 1667
  writes bounded machine-tier logs, returns safe persisted references across
  HTTP and embedded-worker boundaries, and can mirror new entries with
  `--print-logs`.
- **Public documentation now describes the current repository.** The README
  states the public status and exact CI coverage. The release guide specifies
  five release packages and five release targets. Obsolete plan documents are
  removed.
- **Repository documentation shows build status and uses a defined language
  standard.** The README shows CI and standalone-build status for `main`.
  `AGENTS.md` requires ASD-STE100 for technical documentation and README files.
- **Generation does not block local writer actions.** Provider work uses short
  durable phases. The final phase applies an operation-specific result to the
  current story. Concurrent edits remain unchanged. Linux tests cover Stop
  saves, deleted sources, manual names, and provider termination.
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
- **The TUI shows the build identity.** The status bar shows the identity. The
  key reference also shows it when a narrow terminal hides the status bar.
- **1667 has an independent repository.** The terminal application and its
  embedded runtime moved out of the previous repository.
