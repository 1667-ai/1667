---
summary: Research-backed plan for 1667 TUI performance, model connections, prompt caching, upgrades, and release security
read_when:
  - planning or changing the 1667 TUI architecture
  - adding model providers, model settings, effort controls, or prompt caching
  - designing 1667 packaging, upgrades, or release security
  - comparing 1667 with OpenCode, Pi, or Codex
  - investigating whether the TUI and server should share a process
---

# 1667 TUI platform plan

Status: active; ADR 001 embedded transport/release phases implemented, other workstreams remain staged
Research snapshot: 2026-07-20

## Goal

Keep 1667 simple and local-first while leaving room for responsive long sessions, local and remote model endpoints, opt-in provider prompt caching, safe upgrades, and a defensible release chain. Adopt proven harness patterns without turning a fiction-writing client into a general coding-agent framework.

## Executive decisions

1. Keep the current `TextRenderable` architecture until profiling identifies it as the bottleneck. Warm rendering is already inside budget.
2. Coalesce stream deltas before rebuilding frames; reduce JavaScript work per event, not only terminal writes.
3. Split connection, model, generation profile, and story prompt configuration before adding provider-specific controls.
4. Implement prompt caching through capabilities and protocol adapters, defaulting new controls to off. Never send vendor extensions blindly to compatible endpoints.
5. Defer token/cost telemetry and do not claim measured cache savings in this phase.
6. Keep upgrades at the implemented background-notification and explicit read-only `1667 upgrade` boundary. Every current installation is manual.
7. Enforce the implemented script-free package matrix and local release preflight. Hosted publication, installer ownership, managed application, and rollback require separate ADRs.
8. Adopt an embedded backend worker for local TUI use after extracting a transport-neutral service; retain loopback HTTP/SSE for web use. Default TUI stays one OS process; lock-aware standalone HTTP serve uses a supervised backend child so a cancellation-ignoring read has a hard termination fence. The explicit legacy-v1 fallback remains one non-restarting process with unknown-outcome semantics until durable receipts exist. Non-loopback remote mode requires a separate authenticated-HTTPS security decision.

## Current 1667 baseline

### TUI

- OpenTUI Core `0.4.5`, matching OpenCode's current core version.
- One full-screen `TextRenderable`; `renderStoryScreen()` builds the frame and `frameStyledText()` replaces its content.
- Keyed wrap cache avoids rewrapping stable story parts.
- SSE deltas append to the active part, invalidate its wrapping, and repaint synchronously.
- An 80ms timer also repaints during time-derived states and new-part animation.
- Key and mouse reducers dispatch immediately. Control/local work bypasses backend settlement; one visible backend owner rejects conflicts without a pending queue and guards late UI adoption.

Code: [`tui/src/app.ts`](../tui/src/app.ts), [`tui/src/story-actions.ts`](../tui/src/story-actions.ts), [`tui/src/wrap.ts`](../tui/src/wrap.ts), [`tui/bench/perf.ts`](../tui/bench/perf.ts)

Measured 2026-07-19 with `cd tui && bun bench/perf.ts`:

| Scenario | Result | Budget |
|---|---:|---:|
| Warm repaint, 60 parts | 0.76ms | 16ms |
| Cold wrap/repaint, 500 parts / 75k words | 71.68ms | tracked |
| Warm repaint, 500 parts | 3.77ms | 16ms |
| Streaming-delta repaint, 500 parts | 3.84ms | 16ms |
| View-model rebuild, 500 parts | 0.03ms | 8ms |
| Wrap one 10k-word paragraph | 8.03ms | 50ms |
| Loom layout, 2,081 nodes | 0.07ms | 8ms |
| Library fuzzy filter, 200 stories | 0.50ms | 4ms |

Steady-state painting is healthy. Likely risks: cold layout, resize, bursty streaming, repeated frame construction, startup latency, and input actions waiting on network work.

### Model connections

`GenerationSettings` is one flat object: provider (`dry-run | openai-compatible | anthropic`), URL, model, API-key env name, temperature, maximum tokens, system prompt, and context window.

Existing strengths: local presets; keyless localhost; secrets referenced by environment variable; five-second connection test; exact model matching; LM Studio, KoboldCpp, Ollama, and Anthropic probes; manual context fallback; loopback server with host/origin checks.

Code: [`shared/types.ts`](../shared/types.ts), [`server/settings.ts`](../server/settings.ts), [`server/providers.ts`](../server/providers.ts), [`server/server-check.ts`](../server/server-check.ts), and [`server/context-probe.ts`](../server/context-probe.ts)

### Packaging and upgrades

- Root and TUI source packages remain private, but one strict embedded build
  identity now owns product version, source commit, timestamp, target, and API
  compatibility.
- The notify-only checker, 24-hour private hint, and stable read-only
  `1667 upgrade` JSON contract are implemented.
- A local preflight validates the exact script-free six-package matrix and emits
  canonical artifact/SBOM/digest evidence. It does not build or publish.
- No install receipt, managed updater, direct replacement, or hosted publication
  path exists. Every current launch is `manual`.

## Workstream 1: TUI responsiveness

### Transferable lessons

OpenCode combines OpenTUI with a fine-grained Solid tree, native sticky scrolling, narrow message-part mutations, batched hydration, a bounded 100-message working set, and parallel/non-blocking startup work.

Sources: [renderer](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/tui/src/app.tsx), [synchronized state](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/tui/src/context/sync.tsx), [session view](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/tui/src/routes/session/index.tsx), [startup indicator](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/tui/src/component/startup-loading.tsx)

Pi uses another framework, but contributes useful terminal patterns: 16ms render coalescing, line-level differential rendering, CSI 2026 synchronized output, redraw counters/debug logs, visible-width diagnostics, resize/content-shrink handling, and content/width keyed render caches.

Sources: [Pi TUI](https://github.com/badlogic/pi-mono/blob/0feb6e90ce1650325198fe749278b5c55b360ed0/packages/tui/src/tui.ts), [design notes](https://github.com/badlogic/pi-mono/blob/0feb6e90ce1650325198fe749278b5c55b360ed0/packages/tui/README.md)

### Plan

1. Add `scheduleRepaint()`: mutate state immediately, collapse events into one frame, permit immediate input feedback, and prohibit concurrent frame builds.
2. Remove redundant stream-driven repainting from the 80ms ticker; retain it only for animation state that changes without an event.
3. Measure view-model construction, wrapping, frame assembly, styled-text conversion, OpenTUI render requests, and cold/warm cache counts.
4. Benchmark 100 one-token deltas, resize while streaming, cold story switches, very long parts, Unicode/long unbroken text, and content shrinking by more than one screen.
5. Parallelize independent startup reads and show loading only after roughly 500ms.
6. Prioritize input: quit/cancel immediate; in-process movement and text-field editing not behind backend I/O. The first no-queue slice is implemented with one conservative owner; external-editor save admission, typed scopes, and replaceable reads remain pending until transport-neutral status and typed revisions/receipts exist. The target remains ADR 006's settings/per-story admission plus a four-call, six-slot latest-wins read lane; the TUI mirror supplies only immediate UX and never backend authority.
7. Keep one renderable until profiling shows frame assembly or full replacement dominating after coalescing.

Done when: at most one visual repaint per 16ms burst window; warm 500-part repaint below 16ms; navigation/Ctrl+C responsive during slow calls; resize/Unicode/shrink covered; no fast-start loading flash.

Rendering/task-UX decision and gates: [`adr/002-tui-frame-scheduling.md`](adr/002-tui-frame-scheduling.md)

Canonical mutation/storage decision and cutover: [`adr/006-story-aggregate-and-mutation-coordination.md`](adr/006-story-aggregate-and-mutation-coordination.md)

## Workstream 2: prompt caching and token efficiency

### Mechanisms

| Mechanism | Benefit | Shrinks context? |
|---|---|---|
| Provider prompt/KV cache | Lower cost and TTFT | No |
| Chapter summary/compaction | Fewer input tokens | Yes |
| Response memoization | Avoid complete repeated call | Yes; poor fit for creative prose |
| Stateful/incremental transport | Smaller payload, reused connection | Provider-dependent |

OpenAI automatically caches exact prefixes on eligible models. A stable `prompt_cache_key` improves routing; newer families also support explicit breakpoints. Cache reads/writes are reported separately, but cached tokens still count toward context and rate limits. [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching)

Anthropic supports request-level automatic caching and block-level breakpoints. Default TTL: five minutes; one-hour writes cost more. [Anthropic guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Harness examples: Pi exposes neutral cache retention and lowers it per provider; OpenCode similarly applies session-derived keys and protocol-specific controls. These structures transfer without their cost dashboards or coding-agent-specific caches. [Pi OpenAI adapter](https://github.com/badlogic/pi-mono/blob/0feb6e90ce1650325198fe749278b5c55b360ed0/packages/ai/src/providers/openai-responses.ts), [Pi Anthropic adapter](https://github.com/badlogic/pi-mono/blob/0feb6e90ce1650325198fe749278b5c55b360ed0/packages/ai/src/providers/anthropic.ts), [OpenCode provider transform](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/provider/transform.ts)

### 1667 fit and plan

Continuation already has a favorable stable-prefix shape. Fix append mode changing the system string, Anthropic system concatenation, and volatile/random content appearing before stable content. Treat continuation, rewrite, title, and summary as distinct reuse profiles.

1. Add request context: operation kind, opaque story/session cache key, `off | auto | long` policy, and provider/model capabilities; default to `off`.
2. Order prompt blocks: base author brief; canonical facts; operation instruction; transcript; volatile request/boundary tags.
3. Use a hashed story ID for OpenAI cache routing. Prefix equality—not the key—determines sharing.
4. Anthropic first slice: one explicit breakpoint on the last stable cacheable block; no automatic breakpoint on the volatile suffix.
5. OpenAI first slice: automatic caching on older models; on newer capable models use explicit mode plus one stable breakpoint. Send all controls only via known-capable adapters.
6. Send no cache fields through generic OpenAI-compatible connections by default.
7. Reject or join duplicate in-flight `genId` calls before provider work; when `genId` covers the exact generation mutation, use it as that request's durable `mutationId`, never as its transport operation ID.
8. Keep summaries as context reduction. Never memoize creative prose. Defer usage telemetry and cost tracking.

Done when: request fixtures prove stable prefixes and exact capability lowering; unknown endpoints receive no cache fields; fact changes preserve only the blocks before the changed fact boundary; saved prose semantics remain unchanged.

Detailed policy, adapter mapping, and non-telemetry scope: [`adr/004-prompt-caching.md`](adr/004-prompt-caching.md)

## Workstream 3: packaging and upgrades

### OpenCode behavior

OpenCode waits one second after startup, detects npm/pnpm/Bun/Homebrew/Scoop/Chocolatey/curl ownership, checks that channel, silently applies patch releases by default, prompts/notifies for larger releases, delegates replacement to the installer, requests restart, and remembers skipped versions.

Sources: [upgrade policy](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/cli/upgrade.ts), [installation detection](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/installation/index.ts), [TUI dialog](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/tui/src/app.tsx)

### Implemented 1667 behavior

ADR 005 closes the notify-only/manual phase:

```text
1667 upgrade --check [--json]
1667 upgrade [--version <version>] [--json]
```

```text
updates.mode = off | notify
updates.channel = stable | beta
AI_1667_NO_UPDATE_CHECK=1
```

- Precedence: explicit channel flag, user config, default. The environment can
  disable background checks but never disables an explicit CLI request.
- Background checks default to `off` until the exact npm package matrix is
  reserved and published. Persisted `updates.mode = notify` is an explicit
  opt-in; it does not affect the explicit read-only command.
- Check after the first useful frame; cache success for 24 hours under the full install/source/version/channel/platform identity; add backoff/jitter.
- Phase one never mutates or prompts; JSON stays stable on stdout while progress/errors use stderr.
- Ctrl+C exits promptly with bounded cleanup.
- All installs show manual guidance and never mutate.
- Cached/background checks display a low-priority fixed-origin notice. The
  explicit command bypasses that hint, freshly validates exact launcher and
  platform metadata, and returns `command: null`. An external reinstall is
  outside 1667's authenticity claim.

### Identity, compatibility, and direct binaries

The current product observes immutable build identity only; it deliberately
does not infer or persist installer authority. A future ownership ADR must land
setup UX, evidence acquisition, platform permission checks, runtime
revalidation, manager staging, and an apply consumer as one vertical slice.

Expose product/API protocol versions, compatible client range, build commit, and separately validated distribution channel. Detect incompatibility before actions fail. ADR 001 makes embedded TUI and worker one release unit; every independently running HTTP server can version-skew, including loopback `--url`, so the TUI HTTP client preflights compatibility and binds the client protocol version to every API request for server-side rejection before service entry. Loopback is not an OS-user identity: every HTTP mode also requires fresh per-launch story/admin capabilities, atomically published to one deterministic private per-origin auth record only after listener ownership, and never placed in URLs, arguments, logs, or persistent client state. Each HTTP reader derives a narrower in-memory operation-session capability; operation control is bound to that session/scope, while terminal records expire after fixed retention so a crashed client cannot permanently exhaust the listener.

Direct binaries remain a separate design gate: signed metadata, exact byte
verification, credentialless target tests, atomic replacement, restart, and
rollback must be proven before any automatic mode exists.

Done: offline startup; stable `--check --json`; delayed silent notification;
strict registry validation; no mutation or executable argv; exact local package
preflight. Future: installer ownership, managed/direct application, and
rollback.

Closed contract and explicit deferrals:
[`adr/005-trusted-releases-and-upgrades.md`](adr/005-trusted-releases-and-upgrades.md)

## Workstream 4: release and supply-chain security

### OpenCode lessons

Strengths: exact direct versions, lockfile integrity, three-day dependency minimum age, trusted install-script allowlist, full-SHA Actions pins, compiled platform binaries, Windows signature verification, and package hashes.

Sources: [Bun policy](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/bunfig.toml), [dependency policy](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/package.json), [publish workflow](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/.github/workflows/publish.yml)

Gaps not to copy: npm wrapper postinstall selects/copies a binary and executes `--version` without independently verifying a signature or manifest hash; the pinned workflow disables npm provenance; silent patches accelerate malicious authorized releases. [Postinstall](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/script/postinstall.mjs)

### Implemented local controls

1. One clean tagged source evidence shape lowers to one build identity per target.
2. The exact package matrix is one launcher plus five platform packages.
3. Every package is script-free and rejects extra dependency graphs, files,
   links, special nodes, traversal paths, and unsafe modes.
4. The launcher selects only the exact optional platform package and validates
   package/build-manifest agreement before direct execution.
5. Bounded non-extracting tar inspection binds package JSON, build manifest,
   SBOM, native identity claims, and tarball digests into one canonical manifest.
6. The preflight performs no network, publication, extraction, or candidate
   execution.

The preflight consumes trusted claims that must be collected separately:
successful local tag-signature verification and native executable identity
observation. It checks their consistency but is not an attestation service.

Hosted credential choice, package-name bootstrap, staged publication, protected
coordination, candidate execution, promotion, quarantine, and incident recovery
are not specified here. They require a future ADR and end-to-end rehearsal
before the first publication.

Done for this workstream: deterministic script-free package policy and local
preflight. Not enabled: hosted publication.

## Workstream 5: model and provider configuration

### Target schema

| Layer | Owns |
|---|---|
| Connection | Protocol, base URL, auth/header references, timeouts |
| Model | ID/name, limits, modalities, capabilities, quirks |
| Generation profile | Temperature, effort, cache, stop/output policy |
| Story | Author brief/system prompt and canonical facts |

Do not make `openai-compatible` both identity and wire protocol. LM Studio or a gateway may expose multiple protocols with different authentication and quirks. Reserve identifiers `openai-chat-completions`, `openai-responses`, and `anthropic-messages`; implement only those actively needed.

### Connections and secrets

Support named profiles, initially one active: local presets, major remote providers/gateways, and arbitrary custom connections. Store protocol, URL, auth/header references, request/idle timeout, discovered/manual models, and compatibility overrides. Plain loopback HTTP is credentialless and sends prompts only after exact-socket current-user ownership proof; different-account services, including Linux's usual Ollama system service, require authenticated HTTPS. Explicit insecure private-LAN access remains credentialless, numeric-address-pinned, and warning-gated.

Never store literal secrets in normal settings JSON. Start with env references; consider OS keychain when GUI-launched processes make environment inheritance unreliable. Avoid arbitrary credential commands because they make config loading execute code. Fresh Release A+ targets start at format 2 and can configure immediately; existing eligible format 1 exposes the complete settings document read-only until its receipt-bearing format-2 migration. Afterward a credential-reference edit stages a full candidate for restart validation. One atomically replaced v2 settings aggregate owns active/pending/previous state, activation state, revisions, and its last transaction pointer; ADR 006's common sharded ledger owns retry receipts without consuming aggregate capacity. While pending exists the shared settings writer freezes all other edits. Bootstrap keeps active and candidate reference sets separate and sends resolved values only through typed secret slots, so candidate failure can durably discard pending and start unchanged active settings with old-only credentials. The same crash-safe activation host commits at first useful TUI frame or authenticated headless-server readiness and rolls back idempotently in every mode.

### Discovery and capabilities

Use `GET /v1/models` where supported with manual ID fallback. Sources: [LM Studio models](https://lmstudio.ai/docs/developer/openai-compat/models), [server APIs](https://lmstudio.ai/docs/developer/core/server), [KoboldCpp](https://github.com/LostRuins/koboldcpp), [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

Track only needed capabilities: context/output limits, temperature range, assistant prefill, reasoning/effort mapping, prompt-cache/retention, and streaming.

Resolve metadata from highest to lowest precedence:

1. Explicit user override.
2. Live allocated/runtime value.
3. Exact provider discovery response.
4. Built-in exact model knowledge.
5. Unknown.

### UX and routing

Expose provider-neutral effort as `default | off | low | medium | high`. Adapters translate to `reasoning_effort`, `reasoning.effort`, `enable_thinking`, or no field. Disable or clearly reject unsupported values.

Main form: connection preset/profile, discovered/manual model, quality/effort, output length, test connection. Advanced: protocol, URL, auth/header references, timeouts, context, capabilities, caching, scoped overrides.

Start with one default model. Later allow prose and utility (title/summary) overrides so users can reserve a creative model for prose and a smaller local model for housekeeping.

### Migration and completion

Map flat settings into one connection, model, and generation profile. Read the old shape for at least one release; write the new shape only after successful migration. Preserve probes and connection tests. The migration may write only inside an ADR 001 versioned directory while its data lock is held. Legacy split mode retains v1 settings until a separate data-directory migration makes it eligible; schema migration never establishes embedded eligibility itself.

Done for this workstream when: existing local/OpenAI/OpenRouter/Anthropic setups already inside eligible lock-aware directories migrate without re-entry; custom OpenAI Chat needs only URL/model/optional auth reference; unsupported fields are omitted; discovery failure permits manual entry; secrets never reach responses or logs; basic UI stays short while advanced state remains editable. The Release A/B settings-storage and automatic-migration portion is complete as of 2026-07-23. Moving a lock-unaware legacy directory—and its v1 settings—into this eligibility boundary remains explicitly deferred to the separate data-directory migration ADR and is not a completion condition here.

Detailed schema, migration, secret, and UX decision: [`adr/003-model-connections-and-generation-profiles.md`](adr/003-model-connections-and-generation-profiles.md)

## Decision: embedded backend worker

The investigation is complete. OpenCode's default TUI uses one OS process with a Bun worker: SDK requests cross JSON RPC into the worker's in-memory HTTP handler, while backend events return as worker messages. It starts a real TCP listener only for explicit network modes.

For 1667, adopt the same main-thread/worker topology but use a typed service protocol rather than emulating HTTP over RPC. Extract `StoryService` first; keep HTTP/SSE loopback-only and capability-authenticated for web and explicit `--url` use. Non-loopback access is deferred until authenticated HTTPS is designed. Embedded TUI and worker ship as one release unit.

Decision, evidence, protocol requirements, alternatives, and staged migration: [`adr/001-embedded-tui-backend-worker.md`](adr/001-embedded-tui-backend-worker.md)

## Delivery order

Implementation note (2026-07-21): owner decision accelerated the typed worker, embedded default, launch-local `./data`, and standalone preview ahead of this hardened release sequence. The numbered work below now describes production hardening and migration gates, not the current source-build backend selection.

Implementation note (2026-07-24): step 3's guarded source predecessor landed:
listener-before-data auth publication, fixed instance discovery, story/admin
per-request guards, strict numeric-loopback attach, exact-connection
cryptographic server proof for TUI HTTP, development API CORS, and the explicit
single-process legacy-v1 fallback. This does not mark step 3's packaged
cross-platform target matrix complete; native retained-handle ACL/DACL
adapters, platform data targets, and packaged installation smokes remain in
ADR 001 hardening after successor Q.

Implementation note (2026-07-24): step 7's successor Q is complete on the
split-default worker path: story-scoped coordinator
admission, tagged V5/V6 versions, durable local/provider receipts, deterministic
creation/import, unknown-outcome acknowledgement, tombstones/reaping, and
bounded catalog cursors. The guarded HTTP/import lane remains the predecessor
V5 compatibility writer. Native no-replace/retained-handle filesystem
semantics, HTTP operation-session parity, hard process fences, and packaged
target smokes remain steps 8–9 release gates, not Q implementation shortcuts.

Implementation note (2026-07-24): step 8's local worker-operation lifecycle
slice is complete. Incarnation-bound monotonic IDs, bounded status/cancel/
terminal-ack records, delta credit, five-minute terminal retention, pre-service
sequence/capacity rejection, deadline cancellation grace, and whole-process
restart-required fencing now cover the embedded transport. Pre-delivery intent
publication is bounded, retained through shutdown, and protected from
post-crash replay by durable cancellation markers that cannot queue behind a
different stuck publication; shutdown bounds the complete marker batch by the
same hard-fence grace. Terminal reconciliation retains shutdown ownership until
durable cleanup settles, while pre-ready import/exit failures remain ordinary
lock-releasing startup failures and post-ready failures hard-fence. Shutdown
does not recancel a terminal owner, and overlapping cancellation sources cannot
extend the first fixed grace deadline. Step 8 remains open for
HTTP operation-session parity and the supervised `serve` process fence;
step 9 still owns native retained-handle/platform targets, packaged upgrade
smokes, and production graduation.

Implementation note (2026-07-23): ADR 005 closes the canonical build identity,
notify-only upgrade, script-free package policy, and local preflight slice.
Hosted publication and update application moved behind explicit future ADRs;
they are not hidden completion conditions for step 2.

Implementation note (2026-07-23): ADR 003 Release A and Release B engineering
are complete. Eligible owner-marker format-1 directories now migrate through
the internal prepared/state/completed receipt before format-2 activation;
legacy-preview directories remain untouched. Publication still must preserve
the required A-then-B stable-release order.

1. Characterize the HTTP contract; define durable platform per-user data targets, the fixed minimal origin/instance endpoint, and private per-launch HTTP capabilities independent of package bytes; extract a transport-neutral `StoryService` factory. Keep attach/fallback unpublished until step 3.
2. Add build-derived product/API versions and the local package/release
   preflight. Complete; hosted publication is a separate future decision.
3. As one first attachable predecessor release, land the separate product/API compatibility endpoint, per-request guard, shared header helper, TUI HTTP conversion, development CORS rule, private capabilities, authenticated attach-first `--url`, explicit `serve --legacy-v1`, and their compatibility/target smoke fixtures. The default remains split mode; no packaged listener ships before these guards. The TUI repository does not bundle or serve a browser frontend.
4. Ship ADR 006 predecessor P in split-default mode: it continues writing V5, fully reads V6 live/deleted/residue state, but treats every V6 mutation/cleanup as read-only refusal and creates no V6 artifact. P must have shipped stable before any later release writes V6.
5. Ship ADR 003 Release A in split-default mode: freeze the connection/model/profile/writing schema and canonical dry-run initial document, add v1/v2 readers plus the v2 aggregate/recovery writer, initialize new targets at format 2, keep existing format-1 settings read-only, and land the canonical `MutationCoordinator`'s settings scope plus typed expected-version/mutation contract before any v2 edit is exposed. Engineering complete 2026-07-23.
6. After A is the previous stable version, ship ADR 003 Release B's receipt-bearing format-1-to-2 settings migration while split mode remains default. Gate every active directory on `stateGeneration`, settings revision/receipt, activation recovery, A rollback, and B downgrade-refusal fixtures. Legacy unmarked split mode remains on v1. Per-story writing configuration stays deferred until a story-schema ADR gives it revisions, receipts, migration/default-snapshot semantics, and prompt-cache invalidation. Engineering and local gates complete 2026-07-23; stable publication order remains required.
7. Only after step 6 is green, land ADR 006 successor Q's tagged V5-to-V6 story transition, durable receipts, deterministic create IDs, atomic new-bundle publication, and the canonical coordinator's story scopes while split mode remains default. Gate every mutating stream—including settings and generation's captured settings revision—on crash/retry, P parser/refusal, A/Q rollback, and pre-A directory-refusal fixtures. Engineering and local gates complete 2026-07-24; stable publication order remains required.
8. Harden the already-landed typed worker transport and run read/mutation/stream parity tests against the receipt-bearing aggregate model. No production release may claim the Q guarantees before every settings/story mutation has its authoritative aggregate receipt.
9. Graduate the embedded default from local preview to production distribution only after ending runtime support for lock-unaware executables. Gate on P-to-A-to-B-to-Q-to-worker plus direct upgrades from every retained lock-unaware upgrade source, proving no predecessor state is assumed and legacy data is only ever read. ADR 007 replaced the packaged admission ceremony this step was written against: a project tier is created in place, and legacy machine data roots are adopted explicitly rather than refused.
10. Add coalesced repaint scheduling and burst/cold-path tests.
11. Add model capabilities and prompt-plan boundaries.
12. Implement opt-in prompt caching behind exact capabilities.
13. Add notify-only update checks/commands. Complete; they remain useful and
    read-only before publication because absent channels fail closed.
14. Revisit installer ownership, hosted publication, and direct/automatic
    application only through separate ADRs with production verification and
    rollback.

## Non-goals

- Rewriting the TUI in Solid solely because OpenCode uses it.
- Supporting every provider or sampling parameter exposed by coding agents.
- Locally caching creative completions.
- Storing secrets in ordinary settings.
- Arbitrary JavaScript/provider plugins before the connection schema stabilizes.
- Auto-update before release identity, verification, compatibility, and rollback.
