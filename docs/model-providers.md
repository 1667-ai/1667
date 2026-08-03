---
summary: Facts, request context, model providers, credentials, and connections
read_when:
  - configuring a model provider
  - changing Facts or the context meter
  - changing the request viewer
  - changing connection credentials, deadlines, or transport rules
---

# Facts, context, and model providers

## Use Facts and the context meter

Press `Enter` to edit the selected Fact. Double-click a Fact to edit it.

The Fact editor shows the Fact tag in a choice row. Press `Tab` or `Shift+Tab`
to select a Fact tag. Press `Ctrl+T` to type a custom Fact tag. When you save
the Fact, 1667 adds the custom Fact tag to the choice row.

Each Fact has an activation mode. The default mode is `always`. An `always`
Fact is in each continuation request and rewrite request. The `keyed` mode puts
the Fact in a request only when a key matches.

Use `Up Arrow` or `Down Arrow` to move to the activation row. Use `Left Arrow`
or `Right Arrow` to select the activation mode. Put a comma-separated list in
the keys row. A Fact can have a maximum of 32 keys. Each key can have a maximum
of 64 Unicode characters. A key cannot contain a comma.

1667 matches keys without case differences. It matches a complete word or a
complete phrase. For languages that do not use spaces between words, it also
matches a key inside adjacent text. 1667 scans the last three nonempty story
parts in the assembled request context. It also scans the current instruction.

An `always` Fact can keep keys. The keys do not control that Fact until you
select `keyed`.

The Facts panel shows `always`, `✓ keyed`, or `· keyed` for each Fact. The
`✓ keyed` status means that the next request includes the Fact. The side rail
uses `✓` for an active keyed Fact. It uses `·` for an inactive keyed Fact.

In Library or Facts, press `/` to start a filter. The list changes when you
type. Press `Enter` to close the filter.

Select the system prompt row to open the full-screen editor.

The context meter shows the estimated next request. Its pulsing segment
estimates response growth from recent provider text. The configured maximum
output remains the upper limit. The segment changes between two visible
colors.

## Request viewer

Press `Ctrl+R` to open the request viewer. You can also select **Next request**
in the command palette. The request viewer shows the next request plan in
provider order. It shows the routed model and the context window. It shows each
message and its estimated token count.

The request viewer identifies chapter summaries that replace raw story parts.
It also identifies the latest summary take that resets the raw context. The
request viewer does not show provider wire data. It cannot show a credential
because the request plan does not contain credentials.

## Author's Note

Each story can hold one Author's Note. Press `a` to write it. 1667 sends the
Author's Note with each continuation request. 1667 puts it immediately before
the last story part.

The Author's Note is not a Fact. A Fact is reference data. The Author's Note is
an instruction for the next passage.

The message form depends on the protocol. Official OpenAI Chat Completions
receives a late `system` message. Anthropic Messages uses the fold form in the
last `user` message. Compatible, custom, and local endpoints also use the fold
form.

This feature applies to continuation and prompted retake requests. It does not
rewrite a story. It does not create a summary. It does not name a story.

1667 shows a warning when the Author's Note is above 300 estimated tokens.
1667 does not save an Author's Note that has more than 4,000 Unicode scalar
values.

## Provider support

1667 supports these provider protocols:

- Dry run
- OpenAI Chat Completions
- Anthropic Messages

Settings contains these provider choices:

- OpenAI
- OpenAI-compatible
- Anthropic
- LM Studio
- Ollama
- llama.cpp
- KoboldCpp

Use **OpenAI** for the official OpenAI endpoint. Use **OpenAI-compatible** for
OpenRouter and other compatible endpoints. Linux shows local-server choices
only when 1667 can verify exact socket ownership.

Dry-run mode tests the interface without a provider request.

Settings reads the model list from the selected provider. Use `Left Arrow` or
`Right Arrow` to select a model. Press `Enter` to type a custom model name.
Settings reads the list again after you change the provider or the base URL.
Save a new credential target before you use it to read a model list.

## Use Generation Profiles and Generation Routes

A **Generation Profile** is one set of model behavior settings. It contains a
model, a temperature, a maximum output, a reasoning effort, and a cache policy.

Select the **profile** row to see a Generation Profile. Use `Left Arrow` or
`Right Arrow` to select a different Generation Profile. Press `n` to create a
Generation Profile. Press `Shift+N` to duplicate the selected Generation
Profile. Press `e` to rename the selected Generation Profile. Press `d` two
times to delete the selected Generation Profile. Press `s` to save the changes.

A **Generation Route** selects a Generation Profile for one type of work. The
**default route** is required. The **prose route** and the **utility route** are
optional. An optional Generation Route uses the default route when its value is
**same as default**.

Continuation and rewrite operations use the prose route. Chapter summary,
summary take, and story name operations use the utility route. The context
meter uses the active prose route.

Select the **cache** row to set the cache policy. Use `Left Arrow` or
`Right Arrow` to select `off`, `auto`, or `long`. Settings shows an unavailable
message when the selected model cannot use the cache policy.

## Sampling settings

Sampling is an Advanced Settings group. The group starts collapsed.

Press `,` to open Settings. Select `sampling`. Press `Enter` to open the
sampling panel.

The sampling panel holds these parameters:

- Top P, Top K, Min P, frequency penalty, presence penalty, and repeat
  penalty.
- Stop sequences and logit bias.
- DRY multiplier, DRY base, DRY range, and DRY breakers.
- XTC threshold and XTC chance.
- Dynamic temperature range, Mirostat, Mirostat tau, and Mirostat eta.

The panel groups the DRY parameters, the XTC parameters, and the
temperature-shaping parameters under a rule line.

llama.cpp and KoboldCpp are the presets that accept the DRY, XTC, dynamic
temperature, and Mirostat parameters. 1667 does not send these parameters to
another preset.

Select a scalar value. Press `Enter` to edit it. Press `Enter` again to keep
the value. The `mirostat` row reads `off`, `v1`, or `v2`. Press `Left Arrow`
or `Right Arrow` to step through these three states.

`mirostat tau` and `mirostat eta` need Mirostat on. The TUI shows the reason
"Mirostat is off." while Mirostat is off.

Select `stop sequences` or `dry breakers`. Press `n` to add a string. Press
`Enter` to edit the selected string. Press `d` to delete the selected string.
Press `Left Arrow` or `Right Arrow` to reorder the strings.

1667 sends the DRY breakers only when the list holds one or more strings. An
empty list lets the provider use its own breakers. 1667 cannot tell a provider
to use no breakers.

A DRY breaker can hold a maximum of 40 UTF-8 bytes.

Select `logit bias`. Press `n` to add a token-ID and integer-bias row. Press
`Enter` to edit a row. Press `d` to delete a row.

Press `Esc` to return to Settings. Press `s` to save the Settings draft.

The TUI checks each value against the selected protocol, preset, and model.
The TUI renders an unavailable scalar row as `‹ — ›`. The TUI shows a short
reason. The TUI keeps the draft when a save cannot use a configured value.

## Credentials and deadlines

A connection can refer to a stored credential or an environment variable.
1667 stores a pasted credential in the private machine-tier `secrets.json`
file. On POSIX systems, this file has mode `0600`. The project settings document
contains only the opaque secret identifier.

Local servers such as Ollama can use a connection without a credential. 1667
enables prompt cache controls only for exact official provider hosts.

The project settings document at `.1667/settings.v2.state.json` stores the
deadlines for each model connection. New network connections use 120 seconds
for response headers. They use 120 seconds for first content and idle content.
They use 30 minutes for the complete request.

Set `connections.<id>.timeouts.responseHeaderMs`, `firstTokenMs`, `idleMs`, and
`totalMs` to change these deadlines. The Settings panel does not edit these
advanced values.

## Connection security

Plain HTTP provider endpoints cannot use credentials. On Linux, a loopback
endpoint also needs proof that the current user owns the exact socket.

A provider connection can permit plain HTTP on a private network. Set
**insecure HTTP (LAN)** to `on` for that connection. 1667 resolves the host
once. It requires a private-network address. It then pins the verified address.

Public hosts require HTTPS. All connections with credentials also require
HTTPS.
