---
summary: Facts, request context, model providers, credentials, and connections
read_when:
  - configuring a model provider
  - changing Facts or the context meter
  - changing the request viewer
  - changing token probabilities
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

Below the keys row, the Fact editor shows a priority row and a budget row.
Use `Up Arrow` or `Down Arrow` to reach them. See
[Fact priority and Fact budget](#fact-priority-and-fact-budget).

The Facts panel shows `always`, `✓ keyed`, or `· keyed` for each Fact. The
`✓ keyed` status means that the next request includes the Fact. The side rail
uses `✓` for an active keyed Fact. It uses `·` for an inactive keyed Fact.

In Library or Facts, press `/` to start a filter. The list changes when you
type. Press `Enter` to close the filter.

### Arrange Facts

Facts appear in a request in the order that they appear in the Facts panel.
Select a Fact. Press `Shift+Up Arrow` or `Shift+Down Arrow` to move it up or
down. Clear the tag filter and the text filter first. The move keys work only
on the full, unfiltered list.

### Fact priority and Fact budget

Each Fact has a priority: `low`, `normal`, or `high`. The default priority is
`normal`. 1667 uses priority to choose which Fact to drop first when a
request does not fit the model's context window.

Open the Fact editor and move to the priority row. Use `Left Arrow` or
`Right Arrow` to select `low`, `normal`, or `high`.

An `always` Fact at `normal` or `high` priority never drops. A `keyed` Fact
can drop at any priority. Set an `always` Fact to `low` priority to let it
drop too.

A Fact can also have a Fact budget: a limit on its own estimated token count.
1667 drops a Fact that goes over its Fact budget. This rule applies even to
an `always` Fact at `normal` or `high` priority. A Fact budget is an
instruction on that one Fact. It always overrides the priority exemption.
1667 never shortens a Fact's text. A Fact rides whole in a request, or 1667
drops it whole.

Open the Fact editor and move to the budget row. Type a whole number of
tokens. Leave the row empty to remove the Fact budget.

A story can hold a Facts budget: a limit on the combined estimated token
count of every Fact in a request. When the total goes over the Facts budget,
1667 drops the lowest-priority Facts first until the total fits.

Open the command palette and select **facts budget**. Type a whole number of
tokens, then press `Ctrl+S`. Leave the field empty and press `Ctrl+S` to
remove the Facts budget.

### See a Fact's priority

The Facts panel status column and the side rail show a Fact's priority next
to its activation status. `↓` marks a `low` priority Fact. `↑` marks a
`high` priority Fact. A `normal` priority Fact shows no priority mark.

### Fit a request into the context window

When a request does not fit the model's context window, 1667 first applies
the Facts budget. If the request still does not fit, 1667 drops droppable
Facts by priority, one at a time, until it fits.

1667 rejects the request only when it still does not fit after 1667 drops
every droppable Fact.

The context meter states how many Facts a request dropped, and why.

Select the system prompt row to open the full-screen editor. This machine-wide
value is the default Author Brief. A story that sets its own Author Brief uses
that value instead.

The context meter shows the size of the next request. Its pulsing segment
estimates response growth from recent provider text. The configured maximum
output remains the upper limit. The segment changes between two visible
colors. The growth segment is always an estimate, because no tokenizer can
count text that the model did not write.

## Token counts

A token count has one of three grades. Each grade has its own mark:

| Grade | Mark | Example |
| --- | --- | --- |
| exact count | none | `8.1k` |
| near-exact count | `≈` | `≈8.1k` |
| token estimate | `~` | `~8.1k` |

The tokenize source of the preset gives the grade:

| Preset | Tokenize source | Grade |
| --- | --- | --- |
| OpenAI, official host | The bundled tokenizer | exact count |
| Anthropic, official host | `POST /v1/messages/count_tokens` | exact count |
| llama.cpp | `POST /apply-template`, then `POST /tokenize` | near-exact count |
| KoboldCpp | `POST /api/extra/tokencount` | near-exact count |
| LM Studio, Ollama, OpenRouter, custom | None | token estimate |

A near-exact count comes from the model server. 1667 cannot prove that the
server applies the same chat template to a generation request, so it does not
call the count exact. A token estimate counts four characters for each token.

The bundled tokenizer counts with the encoding of the selected model. Different
OpenAI models use different encodings. If the bundled tokenizer does not know
the model, 1667 keeps the token estimate. A new model and a fine-tuned model
can have this result.

The Anthropic source and the two local sources count a complete message array.
They cannot give a count to one message. For these sources the total is a
counted number. Each category and each message keeps its estimate.

1667 counts the request after you stop typing. It counts the request again when
you open the request viewer. A count never delays a keystroke. If the model
server does not answer, 1667 keeps the estimate and shows no error.

## Request viewer

Press `Ctrl+R` to open the request viewer. You can also select **Next request**
in the command palette. The request viewer shows the next request plan in
provider order. It shows the routed model and the context window. It shows each
message and its token count. It also shows the grade of the count.

The request viewer identifies chapter summaries that replace raw story parts.
It also identifies the latest summary take that resets the raw context. The
request viewer does not show provider wire data. It cannot show a credential
because the request plan does not contain credentials.

## Author's Note

Each story can hold one Author's Note. Press `a` to write it. 1667 sends the
Author's Note with each continuation request. 1667 puts it immediately before
the last story part by default.

The Author's Note has a depth setting. Depth sets how many story parts from
the end the note lands before. The default depth is 1. Open the Author's Note
editor. Press `⌥-` to decrease the depth or `⌥=` to increase it. The request
viewer shows the placement the note actually used.

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

## Author Brief

Each story can hold one Author Brief. Open the command palette with `Ctrl+P`
or `:`. Select **Author brief**. This command has no direct key.

A story Author Brief overrides the default Author Brief when you set it. The
default Author Brief is the system prompt row in Settings. 1667 falls back to
the default Author Brief when a story has none of its own.

1667 sends the resolved Author Brief with every continuation request, prompted
retake, highlighted rewrite, and autoname request. The Author's Note applies to
fewer operations: only continuation and prompted retake requests.

1667 does not save an Author Brief that has more than 65,536 Unicode scalar
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
model, a temperature, a maximum output, a reasoning effort, a cache policy,
and an alternative count.

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

Select the **alt count** row to set the token probability count. Use
`Left Arrow` or `Right Arrow` to select `off` or a number from 1 to 20. The
TUI checks the value against the selected protocol and preset. The TUI
renders an unavailable row as `‹ — ›` with a short reason.

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

Select `phrase bias`. Press `n` to add a phrase and an integer weight. Press
`Enter` to edit a row. Press `d` to delete a row. 1667 tokenizes the phrase
four ways: as typed, with a leading space, with a capital letter, and with
both. 1667 accepts the phrase only when every one of the four forms is one
token. 1667 shows the token IDs for each form.

Select `banned strings`. Press `n` to add a text phrase. Press `Enter` to
edit a phrase. Press `d` to delete a phrase. 1667 tokenizes a banned string
the same way as a phrase bias entry, and gives it a strong negative weight.
A banned string makes the text unlikely. It does not make the text
impossible, because the same text can come from different token boundaries.

Phrase bias and banned strings work only where 1667 can find the exact
tokenizer for the routed model. 1667 shows a clear reason next to a row when
it cannot.

Press `Esc` to return to Settings. Press `s` to save the Settings draft.

The TUI checks each value against the selected protocol, preset, and model.
The TUI renders an unavailable scalar row as `‹ — ›`. The TUI shows a short
reason. The TUI keeps the draft when a save cannot use a configured value.

## Token probabilities

A token probability is the probability that the model gave one generated
token. An alternative token is one token that the model weighed at one
position. The token probability viewer shows the alternative tokens of one
take.

Token probabilities are off by default. An alternative token count makes
each response much larger. The provider must report every alternative
token at every position, not only the token it chose.

A Generation Profile holds the alternative count in
`profiles.<id>.tokenProbabilities`. The **alt count** row in Settings sets
it. See [Use Generation Profiles and Generation
Routes](#use-generation-profiles-and-generation-routes).

1667 sends the fields only to a preset that documents them:

| Preset | Sends token probabilities |
| --- | --- |
| OpenAI | Yes |
| OpenRouter | Yes |
| llama.cpp | Yes |
| KoboldCpp | Yes |
| LM Studio | Yes |
| Ollama | No |
| custom | No |

Ollama and a custom endpoint do not document the fields. 1667 never sends
the fields there. Anthropic Messages has no token probability field. 1667
never sends the fields there either.

A model can refuse the fields, even on a preset that documents them. 1667
then sends the request again without them. The generation keeps its prose
either way.

Select a story part that has prose. Press `l` to open the token probability
viewer. The viewer shows the take's prose with the selected token marked.
Below the prose, it shows the alternative tokens the model weighed at that
position, with their probabilities and log probabilities. Use `←` and `→`
to move between tokens. Use `↑` and `↓` to move between alternatives. Use
`Tab` to move to the next story part.

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
