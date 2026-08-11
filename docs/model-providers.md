---
summary: Facts, request context, model providers, credentials, and connections
read_when:
  - configuring a model provider
  - changing Facts or the context meter
  - changing the request viewer
  - changing the Generation Record Viewer
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
of 64 Unicode characters. A literal key cannot contain a comma.

Use `/pattern/flags` for a regex key. Regex keys can contain commas. Use only
the `i` and `s` flags. A regex key matches NFC text. It is case-sensitive
unless it has the `i` flag. Literal keys ignore letter case.

A regex key supports these items:

- Literal Unicode characters
- `.`, character classes, and character ranges
- `|` and noncapturing groups such as `(?:cat|dog)`
- `?`, `*`, `+`, and bounded repetitions such as `{2,4}`
- Word, digit, space, and Unicode-property escapes

A regex key does not support anchors, capturing groups, lookaround, or
backreferences. A repetition bound cannot be more than eight. 1667 rejects an
unsupported regex key when you save the Fact.

Each request gives regex matching a fixed evaluation budget. Literal-key
matching continues if regex matching uses this budget. The Facts panel and the
request viewer show the regex checks that 1667 did not evaluate.

Use the secondary row to add a second key list. Select `and` to require one
primary key and one secondary key. Select `not` to require one primary key and
no secondary key. Secondary keys do not activate a Fact by themselves.

Use the scan row to select one to 20 recent story parts. Leave it empty to use
three parts. Use the chain row to select whether this Fact text can activate
another Fact. The default is `on`. Chain activation stops after three rounds.

1667 matches literal keys without case differences. It matches a complete word
or a complete phrase. For languages that do not use spaces between words, it
also matches a literal key inside adjacent text. 1667 scans the configured
number of recent nonempty story parts in the assembled request context. It
also scans the current instruction and the selected rewrite text.

An `always` Fact can keep keys. The keys do not control that Fact until you
select `keyed`.

Below the keys row, the Fact editor shows a priority row and a budget row.
Use `Up Arrow` or `Down Arrow` to reach them. See
[Fact priority and Fact budget](#fact-priority-and-fact-budget).

The Facts panel shows `always`, `✓ keyed`, `✓ regex`, `✓ chain`, or `· keyed`
for each Fact. The `✓ keyed` status means that the next request includes the
Fact. The side rail uses `✓` for an active keyed Fact. It uses `·` for an
inactive keyed Fact.

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
| llama.cpp | `POST /apply-template` when selected, then `POST /tokenize` | near-exact count |
| KoboldCpp | `POST /api/extra/tokencount` | near-exact count |
| LM Studio, Ollama, OpenRouter, custom | None | token estimate |

A near-exact count comes from the model server. A chat request counts the
server's chat template. A text request counts the selected prompt format.
1667 does not call this count exact because it comes from a separate server
request. A token estimate counts four characters for each token.

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
1667 does not count while a generation, rewrite, or summary is active. It
counts again after the operation ends.

## Request viewer

Press `Ctrl+R` to open the request viewer. You can also select **Next request**
in the command palette. The request viewer shows the next request plan in
provider order. It shows the routed model and the context window. It shows each
message and its token count. It also shows the grade of the count.

The request viewer identifies chapter summaries that replace raw story parts.
It also identifies the latest summary take that resets the raw context. The
request viewer does not show provider wire data. It cannot show a credential
because the request plan does not contain credentials.

## Generation Record

A Generation Record is a durable record of one model request that created or
changed a take. The Generation Record Viewer is a separate, read-only view.
It does not change the request viewer, `Ctrl+R`, or the next request plan.

Select a take. Press `h` to open the Generation Record Viewer. You can also
select **generation records** in the command palette. You can select an
inactive take in the mass map first. The Generation Record Viewer does not
change the story line.

The Generation Record Viewer shows:

- The provider and the protocol of the request.
- The routed model.
- The effective scalar provider settings and sampling settings the request
  used.
- Each provider adjustment 1667 made to the request.
- The text segment the request created or changed.
- The ordered, categorized request pipeline.

A continuation request and an in-place rewrite request can both run on one
take. Each request adds one Generation Record. The Generation Record Viewer
lists a take's Generation Records in order.

An old take, an imported take, and a human take can have no Generation
Record. The Generation Record Viewer states this when a take has no record.

1667 loads a Generation Record only when you open it. A Generation Record
stays local story data. It never contains a credential, a custom header
value, a base URL, or provider response text. 1667 does not send a
Generation Record to a provider.

Copying and pasting a story line does not copy a Generation Record. See
[Story line copy and paste](story-line-copy-paste.md#field-policy).

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
- Text Completions
- Anthropic Messages

Settings contains these provider choices:

- OpenAI
- OpenAI-compatible
- OpenAI-compatible text
- Anthropic
- LM Studio
- Ollama
- llama.cpp
- llama.cpp text
- KoboldCpp
- KoboldCpp text

Use **OpenAI** for the official OpenAI endpoint. Use **OpenAI-compatible** for
OpenRouter and other compatible chat endpoints. Use **OpenAI-compatible text**
for an endpoint that implements `POST /v1/completions`.

Use **llama.cpp text** for the native `POST /completion` endpoint. Use
**KoboldCpp text** for the native `POST /api/extra/generate/stream` endpoint.
All release targets show the local provider choices.

The **prompt format** row applies only to Text Completions. The `raw` prompt
format is the default. It joins message content with one blank line. The
`chatml` prompt format adds minimal ChatML markers. The `server-template`
prompt format asks llama.cpp to apply the template from the loaded model.
Only llama.cpp text offers `server-template`.

1667 does not infer a prompt format from the model name. Select the format that
the model requires. A saved chat connection stays on its chat protocol.

Dry-run mode tests the interface without a provider request.

Settings reads the model list from the selected provider. Use `Left Arrow` or
`Right Arrow` to select a model. Press `Enter` to type a custom model name.
Settings reads the list again after you change the provider or the base URL.
Settings selects the model when the list contains one model and the model row
is blank. An unsaved stored API key can read the model list. Settings uses the
key for this request only. Save the settings to store the key.

## Use Generation Profiles and Generation Routes

A **Generation Profile** is one set of model behavior settings. It contains a
model, a temperature, a maximum output, a reasoning effort, a cache policy,
and an alternative count.

Select the **profile** row to see a Generation Profile. Use `Left Arrow` or
`Right Arrow` to select a different Generation Profile. Press `n` to create a
Generation Profile. Press `Shift+N` to duplicate the selected Generation
Profile. Press `e` to rename the selected Generation Profile. Press `d` two
times to delete the selected Generation Profile. Press `s` to save the changes.
See [Generation Profile transfer](generation-profile-transfer.md) to import,
export, or start a Generation Profile.
Press `i` on the profile row to select a Starter Profile or to read a file.
The import changes the Settings draft. Press `s` to save the draft.

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
edit a phrase. Press `d` to delete a phrase.

On most presets, 1667 tokenizes a banned string the same way as a phrase
bias entry, and gives it a strong negative weight. A banned string makes the
text unlikely. It does not make the text impossible, because the same text
can come from different token boundaries.

KoboldCpp sends a banned string a different way. 1667 sends the literal text
to KoboldCpp's own banned-string field. KoboldCpp needs no token for this.
So 1667 accepts a banned string of more than one token on KoboldCpp. Every
other preset rejects a banned string of more than one token.

KoboldCpp's own document describes two ways it can stop a banned string. It
can change the model's vocabulary. Or it can back up the generated text and
try again. 1667 has not confirmed this behavior against a running KoboldCpp
server. A banned string on KoboldCpp makes the text unlikely, the same
promise as every other preset. It does not make the text impossible.

A banned string on KoboldCpp cannot name the same word as a phrase bias
entry in the same scope. This combination would boost and ban the same word
at the same time. 1667 refuses to save this combination. 1667 also refuses
to send it. 1667 shows the name of the conflicting phrase bias entry.

Phrase bias works only where 1667 can find the exact tokenizer for the
routed model, or ask the model server to tokenize a phrase for it. Banned
strings need the same tokenizer, except on KoboldCpp. A banned string on
KoboldCpp needs no tokenizer. 1667 shows a clear reason next to a row when a
phrase bias or a banned string is not available.

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

1667 reads each alternative token before it stores one. If an alternative
token contains the credential that 1667 sent, 1667 stores no alternative
token for that take. The generation keeps its prose.

Some servers send the alternative tokens of a full generation in one
message. KoboldCpp is one. 1667 sizes its limit for this message from the
output limit for the generation, up to a fixed ceiling.

A message within that limit can still be too large to keep. 1667 then
stores no alternative token for that take. The generation keeps its prose.

A message past the ceiling fails the whole generation. This is the same
result as for any other oversized response from the model.

Select a story part that has prose. Press `l` to open the token probability
viewer. The viewer shows the take's prose with the selected token marked.
Below the prose, it shows the alternative tokens the model weighed at that
position, with their probabilities and log probabilities. Use `←` and `→`
to move between tokens. Use `↑` and `↓` to move between alternatives. Use
`Tab` to move to the next story part.

## Thoughts

Some models write reasoning text before they write prose. 1667 calls this
text a thought. A thought is not story prose. 1667 keeps a thought apart
from the prose of a take. 1667 never writes a thought into your story.

A thought belongs to one take. If you change to a different take, 1667
shows the thought of that take.

Most providers count the tokens of a thought against the same output
limit as the prose. A long thought thus leaves less space for prose. If a
model that thinks stops too early, increase **max tokens** in Settings.

While the model thinks, the margin shows `⟳ thinking` and a count. If the
provider reports a thought token count, 1667 shows that count. If the
provider reports no count, 1667 counts the pieces of the thought that it
receives, which gives an approximate number. Press `Esc` to stop the
generation.

The **Reasoning** row in Settings selects how 1667 shows a thought:

| Reasoning mode | What 1667 shows |
| --- | --- |
| off | Nothing. 1667 shows no thought. |
| marker | The thought marker in the margin. This is the default. |
| open | Each thought, unfolded, above the prose of its story part. |

Select a story part that has a thought. Press `T` to unfold the thought.
1667 shows the thought above the prose of the story part. A rail and an
indent keep the thought apart from the prose. Press `T` again to fold the
thought. The `T` key does nothing on a story part that has no thought.

The **Keep thought** row controls storage. Keep thought is on by default.
1667 then saves each thought with its take. The thought stays after you
close the story. Set Keep thought to off to save no thought. 1667 then
shows each thought while the model writes it, but keeps none of it.

Some routes cannot return reasoning text. A text completion route is one,
because that protocol has no field for it. The Reasoning row then shows
`‹ — ›` and gives the reason.

1667 cannot know in advance whether the other routes return reasoning
text. Thus the Reasoning row keeps your selection on all of them. If a
model writes no reasoning text, its take gets no thought marker, and the
Reasoning row does not change.

## Credentials and deadlines

A connection can refer to a stored credential or an environment variable.
1667 stores a pasted credential in the private machine-tier `secrets.json`
file. On POSIX systems, this file has mode `0600`. The project settings document
contains only the opaque secret identifier.

Local servers such as Ollama can use a connection without a credential. 1667
enables prompt cache controls only for exact official provider hosts.

The project settings document at `.1667/settings.v2.state.json` stores four
deadlines for each model connection: **headers**, **first token**, **idle**,
and **total**. New network connections use 120 seconds for **headers**. New
network connections use 120 seconds for **first token** and for **idle**. New
network connections use 30 minutes for **total**.

### Change a deadline in Settings

The Settings panel shows the four deadlines in the **connection** section.
Select a deadline row. Press `Left Arrow` or `Right Arrow` to step the value.
Press `Enter` to type a value. The panel shows **headers**, **first token**,
and **idle** in seconds. The panel shows **total** in minutes.

You can also set `connections.<id>.timeouts.responseHeaderMs`, `firstTokenMs`,
`idleMs`, and `totalMs` directly in the project settings document.

### The header and first-token deadlines, and prefill

Prefill is the model server's work before it sends the first output token.
Prefill computes the model's internal state for the whole prompt. Prefill
sends no stream output. A large prompt takes longer to prefill than a short
prompt. A model server can finish prefill before it sends response headers,
or after it sends them. 1667 cannot tell which.

1667 extends both the **headers** deadline and the **first token** deadline
for a large prompt. 1667 measures the size of the outgoing request. 1667
compares this size against the Settings value for the affected deadline.
1667 waits for the larger of the two amounts.

The **headers** and **first token** values in Settings are each a floor.
1667 never waits less than the configured value. 1667 can wait longer when
the prompt is large. The automatic extension never waits past the **total**
deadline for the same connection. Only the automatic extension has this
limit. A configured value above the **total** deadline still applies exactly
as set.

Increase the **first token** value in Settings when a model server needs more
than 120 seconds to answer a small prompt. Slow local hardware is a common
cause.

## Connection security

Plain HTTP provider endpoints cannot use credentials. On Linux, a loopback
endpoint also needs proof that the current user owns the exact socket.

A provider connection can permit plain HTTP on a private network. Set
**insecure HTTP (LAN)** to `on` for that connection. 1667 resolves the host
once. It requires a private-network address. It then pins the verified address.

Public hosts require HTTPS. All connections with credentials also require
HTTPS.
