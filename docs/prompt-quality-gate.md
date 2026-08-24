---
summary: Gemma continuation incident record and prompt quality replay gate
read_when:
  - changing the Continue or Retake prompt plan
  - reviewing a model-quality regression
  - preparing a release candidate with generation changes
---

# Prompt quality gate

## Technical terms

| Term | Meaning |
| --- | --- |
| Continue | Generate the next story text from the current story line |
| Retake | Generate a sibling take with a stored instruction |
| assistant prefill | Keep the final assistant message open for generation |
| replay | Send the baseline and candidate requests as a paired comparison |

## Incident record

The incident concerns a long story on Gemma 4 31B through KoboldCpp Chat
Completions. The report records identical LLM settings, including temperature
and sampler settings.

The observed result on Retake was:

| Version | Result |
| --- | --- |
| 0.8.0 | Correct established style |
| 0.9.0 | Wrong generic style, but story-aware |
| 0.9.2 | The same wrong generic style, but story-aware |
| 0.8.0 again | Correct established style |

This is an A-B-A result. The settings did not change between the runs. The
prompt and request shape did change between the 0.8.0 and 0.9.x runs.

Retake starts a new user turn. It does not use the assistant-prefill
continuation path. The Retake result therefore rules out assistant-prefill as
the primary cause of this style regression. The result points to the changed
prompt or request shape as the cause.

Continue had a separate defect. Commits `a37a096` and `0f5725e` moved the
operation contract from the prelude into the final turn and then folded it
into the final user turn. An assistant-prefill Continue ends on the unfinished
assistant message. It has no final user turn. That path therefore sent no
operation contract. Issue [#176](https://github.com/1667-ai/1667/issues/176)
records this missing-contract defect.

The missing Continue contract and the Retake style regression are related to
the same prompt work, but they are not the same failure. A fix for the
Continue contract does not prove that the Retake prompt has the right style
conditioning.

Commit `d2dba3a` added a mode-independent Continue contract. Commit `3ad49f0`
continued that repair. Commit `dc6d632` restored the v0.8.0 continuation prompt
shape. These code and wire tests do not replace the Gemma replay.

## Compatibility baseline

The complete v0.8.0 continuation prompt is the compatibility baseline for
local models. This baseline applies to Continue and Retake review.

Keep the v0.8.0 prompt shape until a replacement passes the Gemma replay gate.
Do not use cache reuse as evidence that a model will keep the established
style.

The default continuation prompt layout is the compatibility baseline. A
Generation Profile can enable one approved experimental layout. A missing
setting is off. The current candidate is `late-cache-stable`.

Default Settings keep the approved Continue and Retake request bytes. Custom
Default Continue direction and operation guidance are writer input. They do
not have one fixed quality score. Do not use a Gemma replay for custom
guidance.

The baseline keeps these properties:

- The operation contract is present on every continuation path.
- An assistant-prefill Continue ends on the unfinished assistant message.
- A Continue without assistant prefill uses its exact boundary echo.
- A Retake uses a new user turn and its stored instruction.

The paired replay covers the prompt plan. Both arms use the current Chat
Completions adapter. The replay does not cover prompt-cache or request-adapter
changes. The deterministic HTTP integration test in
`test/model-connection-e2e.test.ts` protects the Continue transport wire. Add
the applicable integration test for a different adapter or cache change.

## Gemma replay gate

Run the replay before a new Continue or Retake prompt plan reaches a release
candidate. Use the frozen story fixture in
`evals/gemma-prompt-quality/fixture.ts` for every comparison.
Follow the [replay instructions](../evals/gemma-prompt-quality/README.md).

Use the fixed seeds `101`, `202`, `303`, `404`, and `505`. Use the `Retake`
and `Continue` operations from the fixture.

The replay sends the frozen v0.8.0 prompt plan and one named candidate prompt
plan to the same KoboldCpp endpoint and profile. Both prompt plans use the
current Chat Completions adapter. Run each Retake and Continue seed with both
prompt plans. The complete run produces 20 outputs. Use
`--optimization late-cache-stable` to select the current candidate. Do not put
two prompt optimizations in one replay.

Keep these inputs identical between the two requests:

- KoboldCpp server version and configuration
- Gemma model and quantization
- chat template
- context window
- temperature and every sampler setting
- output limit and stop settings
- story fixture and request text
- random seed

The replay profile fixes its transport limits. The header deadline is ten
minutes. This limit applies only to the replay. It does not change product
connection defaults. This time gives KoboldCpp time to evaluate a cold,
cache-disabled long prompt before it starts the response stream.

Stop all other KoboldCpp clients before you run the replay. Pass
`--exclusive-server` to record this operator attestation. The runner sends the
20 requests in sequence after this attestation. The attestation is a manual
trust boundary. It is not a server lease. CI cannot prove that the operator
used an exclusive server.

Change only the prompt plan under review. Record the exact configuration with
the outputs. Do not change the model or sampler to improve a candidate result.

Create a blind pack with a private random mapping seed. Keep the mapping
file local. Give the scorer only the blind pack. The pack must omit the
shuffle seed, operation label, sample seed, output fingerprint, pair ID, and
arm label. Each sample can include an opaque reference ID. The opaque ID lets
the scorer select the correct context without revealing the operation.

Use the mapping file with the replay and blind pack when you create evidence.
The score command must verify both file identities before it restores pairs.
Keep the mapping data private after scoring.

Score each output from 0 through 3 with this rubric. Use these field names in
the evidence file:

| Field | Question |
| --- | --- |
| `boundaryContinuity` | Does the output follow the operation boundary without a repeat or restart? |
| `styleVoiceCadenceContinuity` | Does the output keep the established voice and cadence? |
| `povTenseConsistency` | Does the output keep the established point of view and tense? |
| `factContextRetention` | Does the output use the known facts, setting, and recent events? |
| `genericSceneResetAvoidance` | Does the output avoid a generic opening that resets the scene? |

Use the [score anchors](../evals/gemma-prompt-quality/README.md#blind-score)
for every output. Record the scores and a short note for each sample. Do not
change the rubric after you see the version labels.

Keep raw requests, raw outputs, and the randomized blind pack local. Do not
commit them. Commit only the compact evidence in
`evals/gemma-prompt-quality/evidence.json`. Do not claim a prompt change
passed when the evidence contains only rendered prompt snapshots or unit-test
output.

The evidence records one baseline and one candidate for each operation and
seed. A candidate must not score lower than its baseline for any rubric field.
Any lower score is a regression. The gate fails when any operation, seed, or
rubric field has a regression.

The approved replay protocol fixes the KoboldCpp route, the exact model ID,
Q8_0 quantization, the chat template hash, context minimum, output limit, and
sampler values. The protocol does not fix the server version or artifact
SHA-256 value. Record these values in each real replay.

Each baseline rubric score must be 2 or more. This rule prevents a zero-score
tie from passing the gate.

The repository includes approved evidence for the `late-cache-stable`
candidate. A change to a replay request requires new replay evidence. A
scorer-only change requires a new blind review and new evidence. It does not
require a new model replay.

The evidence binds the runtime configuration, the complete replay profile, and
the named optimization to the result. CI rebuilds the deterministic baseline
and candidate requests from these values. CI recomputes both aggregate request
fingerprints.

The evidence parser and scoring contract check the exact v0.8.0 baseline
request fingerprint, the current candidate request fingerprint, the runtime
and profile bindings, the named optimization, the blind sample count, the
score protocol fingerprint, the score fields, and the zero-regression result.
The human scorer is a trust boundary. CI cannot check whether a reviewer
judged an output correctly.

Normal CI parses the compact evidence and rebuilds the deterministic request
bodies. Normal CI does not start KoboldCpp or run Gemma 4 31B. CI does not
prove replay provenance. A release owner must complete and review the replay
before the prompt-plan change ships.
