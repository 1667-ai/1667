---
summary: Plan for configurable writing guidance and fixed operation contracts
read_when:
  - changing a model prompt or prompt setting
  - changing the Settings schema or prompt editor
  - changing Continue, Rewrite, title, summary, or Aside requests
---

# Configurable prompt plan

## Outcome

1667 will show the default Author Brief by its correct name. It will also let
the writer configure guidance for Continue, Rewrite, title, summary, and Aside
operations.

1667 will keep its operation contracts. A writer can add guidance but cannot
replace a boundary rule, output marker, source quarantine, or validation rule.
This separation keeps model output compatible with the parser and story
mutation code.

## Product behavior

Settings will contain these prompt rows:

| Row | View | Effect |
| --- | --- | --- |
| Default Author Brief | Simple | Supplies the existing machine-wide Author Brief |
| Default Continue direction | Simple | Replaces `Continue the story.` for a new empty Continue request |
| Rewrite guidance | Advanced | Adds standing guidance to Rewrite requests |
| Title guidance | Advanced | Adds standing guidance to autoname requests |
| Summary guidance | Advanced | Adds standing guidance to summary-take and chapter-summary requests |
| Aside guidance | Advanced | Adds standing guidance to Aside requests |

Each row will use the full-screen Settings prompt editor. `Ctrl+S` will keep
the row draft. The writer must then press `s` in Settings to save all Settings
changes. The success message will continue to confirm the authoritative save.

An empty optional guidance row will add no request block. An empty Default
Continue direction will reset to `Continue the story.`. An empty Default
Author Brief will continue to omit the global brief.

A story Author Brief will continue to override the Default Author Brief. It
will not override operation guidance.

The Default Continue direction will apply only when the writer starts a new
request without a direction. It will become the saved direction of a new story
part. It will not change directions that existing story parts store. A legacy
story part with an empty saved direction will continue to use the historical
`Continue the story.` fallback when 1667 rebuilds its context.

The Utility route will remain a Generation Profile route. It will not become
one shared prompt. Title, summary, and Aside need different contracts and
different optional guidance.

## Prompt ownership

The writer will own these values:

- Default Author Brief
- Default Continue direction
- Rewrite guidance
- Title guidance
- Summary guidance
- Aside guidance

1667 will continue to own these values:

- Continue and append contracts
- Rewrite selection and boundary contracts
- Title output format and source quarantine
- Summary coverage rules and completion marker
- Aside canon and source rules
- Provider-specific message folding

The prompt builders will put optional operation guidance in a stable `system`
turn before the applicable fixed operation contract. The existing
`operation-contract` block kind will record both blocks. This choice avoids a
new story-storage block kind. Generation Records for Continue, Rewrite,
summary-take, and chapter-summary will show the exact text and role of each
block. Autoname and Aside do not own Generation Records. This change will not
add a record kind or a story-storage attachment for them. Prompt-builder tests
will verify their exact emitted requests.

Default settings must produce byte-identical Continue, Rewrite, title,
summary, and Aside requests. This requirement protects the current local-model
baseline and prompt-cache keys.

## Settings schema

Add Settings schema 5. Do not add fields to Settings schema 2, 3, or 4. Those
schemas are frozen.

Schema 5 will keep the schema-4 connection, model, routing, and state envelope
shapes. It will use a schema-5 reasoning union. The `legacy` variant will carry
one schema-2 effort and no Thinking Mode. The `independent` variant will carry
the schema-4 effort and Thinking Mode pair. The persisted discriminator will
select the matching runtime lowering path. Thus, conversion will not infer
legacy or independent semantics from equal scalar values.

The `writing` object will contain these required strings:

```text
defaultAuthorBrief
defaultContinueDirection
rewriteGuidance
titleGuidance
summaryGuidance
asideGuidance
```

The initial values will use the current Default Author Brief, the current
`Continue the story.` direction, and empty operation guidance strings.

Define `MAX_WRITING_PROMPT_SCALARS` as 65,536 Unicode scalar values. Apply it to
Default Author Brief and each optional guidance value. Define
`MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS` as 61,534. This value reserves 4,000
scalars and two newlines for the maximum Author's Note when a provider folds it
into the following request or stored instruction. Each guidance value and
direction will otherwise be one exact prompt block. The builder will not add
wrapper text to that block. Enforce the field-specific bounds in the schema-5
codec, generated JSON Schema, server save path, and TUI editor. Reject unpaired
Unicode surrogates. Add corpus and TUI-save cases at each limit and one scalar
over it. Add a Generation Record test that uses a maximum Default Continue
direction, a maximum Author's Note, and a folding provider.

Also limit the canonical JSON encoding of the complete `writing` object to 384
KiB. This measure includes quotes, field names, escapes, and control-character
expansion. The TUI will show and enforce the remaining encoded-byte budget.
The server and codec will enforce it again. Schema 5 will use a 1 MiB document
limit and a 4 MiB state limit. The Settings response decoder will use the
schema-5 document limit. These limits let a 256 KiB source document gain the
required schema-5 fields without becoming invalid.

Define one `MAX_SETTINGS_SAVE_REQUEST_BYTES` value of 8 MiB. Derive it from a
1 MiB document plus 64 permitted secret values of 16 KiB each at their
worst-case JSON escape expansion, plus command overhead. Apply the same value
to `saveSettings` in the HTTP body parser and the embedded-worker request-size
validator. Do not change limits for other operations. Tests will cover
non-Basic Multilingual Plane scalars, control-heavy strings, all six fields
near the aggregate budget, near-limit schema-2, schema-3, and schema-4
conversions, and maximum document-plus-secret commands through both
transports.

Replace full-document provider probes with a closed `ProviderProbeRouteV1`
payload. It will contain only the selected schema-5 connection, model, profile
controls needed by provider runtime resolution, and at most four unsaved
secrets. It will not contain routing maps, other records, or `writing`. The
server will validate the closed payload and resolve the supplied selected route
directly. Use it for check-server, context-window probe, model discovery, and
sampling-bias resolution, before and after schema-5 publication. Keep one 1 MiB
probe-request limit, derived from the bounded route, worst-case JSON expansion
of four secrets, and the existing bounded sampling-bias input. Add transport
and server tests for all four operations at and above the limit.

Add schema-5 types, validation, canonical codecs, JSON Schema generation,
corpus cases, hash vectors, and initial vectors. Keep each schema in its own
module. Reuse the generic settings-state envelope and state validator.

The new release will read schema 2, 3, 4, and 5. It will expose one schema-5
working document to the editor. Conversion will use these exact mappings:

- A schema-2 model on a `dry-run` connection gets `imageInput:
  "unsupported"`. Each other schema-2 model gets `imageInput: "unknown"`.
- A schema-3 or schema-4 model keeps its image capability and token ceiling.
- Every schema-2 and schema-3 profile gets the `legacy` reasoning variant and
  keeps its effort, including `off`.
- Every schema-4 profile gets the `independent` variant and keeps its effort
  and Thinking Mode values.
- Every source schema keeps its Default Author Brief. It gets the built-in
  Default Continue direction and empty optional guidance.

The conversion will preserve revision roles, transaction identity, and
activation outcomes. It will recompute every document hash that the activation
state binds. Tests will compare actual provider request bodies, refusals,
resolved provider fields, and activation roles before and after conversion for
every legacy effort and every adapter. They will also cover every legacy image-
capability value.

Increase the HTTP API protocol from 25 to 26. Keep its minimum and maximum
client versions at 26, so mixed 0.10.1 and 0.10.2 HTTP processes refuse during
negotiation. Increase the worker protocol and mutation-input protocol from 11
to 12. A protocol-11 `saveSettings` request will refuse before document decode
or storage. Existing predecessor handling for other worker operations will not
change. Add mixed-version tests for Settings reads, fresh saves, and retained
worker requests.

The settings store will complete source-schema receipt and activation recovery
before conversion. It must not combine an unresolved source activation with
converted hashes. A cross-schema save will use a dedicated
`settings-schema5-upgrade-v1` ledger receipt. The identity will bind the exact
source state bytes, the canonical schema-5 candidate, and the user mutation
identity.

The durable cut points and restart outcomes will be:

1. Before any secret value write, publish a bounded, project-scoped
   `settings-pending-secrets-v1` ownership record. It will bind the source
   state, mutation identity, candidate hash, and only the newly minted secret
   IDs. It will not contain a secret value or secret-value digest. Validation
   will accept only IDs minted by this project and mutation.
2. Write every non-null new or rotated secret to the owned minted ID. Do not
   delete an old secret. If a crash leaves the source state authoritative,
   recovery deletes only IDs in the matching ownership record and then removes
   that record. This targeted cleanup also runs with a shared machine tier.
3. Prepare the receipt only after every secret ID that the candidate references
   resolves. The receipt binds those IDs through the candidate but never stores
   a secret value or a secret-value digest.
4. After receipt preparation, recovery verifies the source bytes and every
   referenced secret before it can rebuild the same candidate. It does not
   change `current` when a required secret is absent.
5. After schema-5 `.next` staging, recovery verifies the prepared receipt and
   every converted hash before it publishes `.next`.
6. After atomic publication, schema-5 `current` is authoritative. Recovery
   completes the matching prepared receipt from that exact state.
7. After receipt completion, recovery removes only a matching stale `.next`
   file. It then removes superseded or explicitly cleared secrets that no
   published or pending document references. It removes the matching ownership
   record last.

A schema-5 `.next` file without its matching receipt will make the store refuse
the mutation without changing `current`. Restart tests will interrupt each cut
point for schema 2, 3, and 4. Each source set will include an active-only state
and a state with a pending revision. Credential crash cases will cover a new
secret, a rotated secret with a new ID, and a removed secret. They will include
the pre-receipt window with a shared machine tier and an unrelated project's
live secret.

Use the same pending-secret ownership protocol for every later schema-5 save,
not only the cross-schema upgrade. The ordinary settings receipt will become
preparable only after owned secret writes resolve, and cleanup will remain
after state publication and receipt completion. Add schema-5 source tests for
every credential cut point and for the shared machine tier.

The first successful Settings save will publish schema 5. A failed save will
leave the source settings bytes unchanged. A retry will keep its existing
mutation identity rules. After schema 5 is published, an older release will
refuse to change the settings. The beta release notes and Settings
documentation will state this rollback limit.

## Runtime model

Add one shared `WritingPromptSettings` value. Keep it separate from provider
sampling and credentials. The settings runtime snapshot will resolve provider
settings and writing prompts from the same active document revision.

Do not add `WritingPromptSettings` to the canonical generation-intent payload.
The existing `GenerationSettings` value and operation context remain the
receipt input. Continue already binds its effective instruction. Title and
Aside already bind their rendered messages. Rewrite, summary-take, and
chapter-summary will add an operation-guidance context member only when its
value is not empty. Thus, all default settings keep the pre-schema-5 canonical
payload and fingerprint. Custom guidance changes the existing operation
context before provider work.

A pending pre-schema-5 receipt with default prompts will resume with the same
fingerprint. Changed guidance will produce an idempotency conflict before a
provider starts. A provider-started receipt with default prompts will keep its
current uncertain-recovery path. Changed guidance will keep that receipt
provider-uncertain and will not dispatch another request. It must not report
that the retained request was never sent. Tests will cover both receipt states
with default and changed guidance.

Continue will resolve the effective direction after it loads the active prose
route snapshot. For a request that creates a new story part, Fact activation,
context admission, the rendered request, the Generation Record, and the saved
story part will all use that same direction. A genuine append will keep its
append contract and will not gain a Continue direction. It will not change the
existing story part's saved direction. Assistant-prefill and boundary-based
append tests will protect these rules.

The generation admission and stopped-generation handoff will pin the effective
direction beside the Generation Record handoff before streaming starts. Both
`createNode` commit implementations will use that pinned value for a generated
take. They will use the request body only for a human take or when they read a
legacy handoff that has no pinned value. The TUI stream projection will receive
the same effective value and will not restore the built-in fallback. A stop or
timeout save of an empty Continue request with a custom default will therefore
store the custom direction.

Rewrite will use the active prose route and Rewrite guidance. Autoname,
summary-take, chapter-summary, and Aside will use the Utility route and the
applicable guidance. The selected route controls the model and sampling. The
writing guidance remains global to the Settings document.

Every effective direction and optional guidance block will participate in
context-window admission. Prompt admission will measure the complete fixed
prompt even when Facts and the Author's Note are absent. Summary fitting and
Aside fitting will use the prompt after guidance is present. Autoname will
subtract the title-guidance cost before it selects the story excerpt. If fixed
blocks alone do not fit, the operation will refuse before provider work. The
request viewer will use the same admission result. Tests will use small context
windows and long guidance for Continue, Rewrite, autoname, summary, and Aside,
with and without Facts.

The TUI request projection will consume the active writing prompts from the
Settings view. It will not read a pending Settings document. Thus, `Ctrl+R`
will continue to show the same request that the server sends.

Add a required, closed `activeWriting` projection to the Settings response.
For legacy data format 1, it will contain `effective.systemPrompt` as the
Default Author Brief plus the schema-5 defaults for the other fields. For
schema 2, schema 3, and schema 4, it will contain the stored Default Author
Brief plus those defaults. For schema 5, it will come from the active revision.
The editable `document` can still show a pending revision. Request projection,
context meters, and stream state will use only `activeWriting`. Prompt editors
will use only the editable document. Decode and request-projection tests will
cover data format 1 and mixed active/pending schema-5 state.

## UI structure

Replace the one-purpose system-prompt editor code with a table-driven prompt
field definition. Each definition will own these values:

- Settings row ID
- `writing` field
- title
- placeholder
- empty-value behavior
- help text
- view visibility (`simple` or `advanced`)

Use this definition for navigation, row presentation, editor opening, draft
application, conflict reconciliation, and save settlement. Do not add one
conditional chain for each new row.

Add one schema-5 document update boundary that always carries the complete
`writing` object from its input unless the requested mutation explicitly
changes one writing field. Route the basic provider editor, advanced profile
editor, routing changes, model discovery, subscription-plan changes, prompt
editors, import fitting, and save reconciliation through this boundary. Do not
reconstruct `writing` from only Default Author Brief. Tests will set all six
fields, perform each unrelated mutation class, save, restart, and compare all
six values.

Keep provider and profile controls unchanged. Keep only Default Author Brief
and Default Continue direction in Simple view.

## Verification

Add integration or end-to-end coverage for these behaviors:

1. Convert each supported source Settings schema to schema 5.
2. Preserve active and pending settings roles across conversion.
3. Keep source bytes after a failed conversion or save.
4. Round-trip every prompt field through the TUI and the server.
5. Keep active runtime prompts while a pending document exists.
6. Send the configured Default Continue direction for an empty request.
7. Keep historical story directions unchanged.
8. Send each optional guidance value only to its operation.
9. Keep app-owned contracts after custom guidance.
10. Bind changed guidance to mutation identity.
11. Show the active prompts in the request viewer and in each operation that
    already owns Generation Records.
12. Keep every default rendered request byte-identical.
13. Recover pre-schema-5 pending and provider-started generation receipts with
    default and changed guidance.
14. Keep genuine assistant-prefill and boundary appends direction-free.
15. Stop and save an empty Continue with a custom default through each local
    `createNode` commit path.
16. Reject every prompt field above the shared scalar limit in the codec and
    the TUI.
17. Enforce the aggregate UTF-8 writing budget and the schema-5 storage and
    transport limits.
18. Refuse a request whose fixed direction or guidance cannot fit its context
    window, with request-viewer parity.

Run these gates before review:

```sh
npm run build
npm test
npm run prompt:check
cd tui
bun run typecheck
bun test
bun bench/perf.ts
bun run build:standalone
```

The default prompt bytes will not change. Therefore, this work does not need a
new Gemma replay. A test will compare the default request fingerprints with
the approved baseline. Custom guidance is explicit writer input and cannot
have one fixed quality score.

## Documentation

Update these documents:

- `README.md`
- `docs/autoname.md`
- `docs/model-providers.md`
- `docs/generation-boundaries.md`
- `docs/technical-terms.md`
- `docs/prompt-quality-gate.md`
- `docs/generation-profile-transfer.md`
- `docs/summary-branches.md`

State that Profile Export does not include writing prompts. A Profile Export
continues to hold one Generation Profile. The writing prompts are machine-wide
Settings values, not profile values.

Keep Profile Export versions 1 and 2 closed and byte-frozen. Add Profile Export
version 3 for the independent schema-5 reasoning pair. Version 3 will require
both `effort` and `thinkingMode`. Export a `legacy` profile as version 1 or
version 2 with its existing exact bytes. Export every `independent` profile as
version 3, including `default`/`default`, because the same scalars do not have
legacy lowering semantics.

When a version-1 or version-2 file supplies effort, import it as one `legacy`
reasoning value. When the file omits effort, omit reasoning from the transfer
candidate and leave the destination reasoning value unchanged. Import a
version-3 pair as one `independent` reasoning value. Profile fitting will apply
or reject the reasoning union atomically and will report a value that the
destination route cannot use. Tests will cover all three versions, every
legacy effort and independent pair, legacy files with omitted effort, and
preservation of destination writing prompts.

All changed documentation must use the project documentation rules.

## Review limits

The following decisions are settled for this change:

- Custom text adds guidance. It does not replace fixed contracts.
- There is no shared Utility prompt.
- Existing story directions do not change.
- Default request bytes do not change.
- Settings schema 2, 3, and 4 do not change.
- The UI uses one table-driven prompt editor path.
- Provider-specific message lowering does not change.
- Profile Export does not include machine-wide writing prompts.
- Autoname and Aside do not gain Generation Records.

Review must find missing behavior, unsafe schema conversion, prompt drift,
incorrect ownership, or unnecessary structural complexity. Review must not
request full contract replacement, per-provider prompt variants, automatic
rewrites of old story directions, or unrelated Settings redesign.

## Delivery

Use a feature branch and one feature pull request. Run all local gates and both
requested reviews before push. Merge only after required CI is green.

After the feature merge, prepare `0.10.2-rc.1` on a release branch. Add the
release section to `CHANGELOG.md`, update package versions, regenerate release
notes, run the release gates, and merge the release pull request after CI is
green. Create `v0.10.2-rc.1`, dispatch the hosted release workflow, and wait
for all jobs. Verify the GitHub prerelease, all six npm packages on the `beta`
tag, and the `released/v0.10.2-rc.1` completion ref.
