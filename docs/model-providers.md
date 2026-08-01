---
summary: Facts, request context, model providers, credentials, and connections
read_when:
  - configuring a model provider
  - changing Facts or the context meter
  - changing connection credentials, deadlines, or transport rules
---

# Facts, context, and model providers

## Use Facts and the context meter

Press `Enter` to edit the selected Fact. Double-click a Fact to edit it.

The Fact editor shows the Fact tag in a choice row. Press `Tab` or `Shift+Tab`
to select a Fact tag. Press `Ctrl+T` to type a custom Fact tag. When you save
the Fact, 1667 adds the custom Fact tag to the choice row.

In Library or Facts, press `/` to start a filter. The list changes when you
type. Press `Enter` to close the filter.

Select the system prompt row to open the full-screen editor.

The context meter shows the estimated next request. Its pulsing segment
estimates response growth from recent provider text. The configured maximum
output remains the upper limit. The segment changes between two visible
colors.

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

The cache policy is not available in Settings. New profiles use the `off`
cache policy.

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
