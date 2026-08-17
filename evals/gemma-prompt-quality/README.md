# Gemma Prompt Quality Replay

This harness checks continuation prompt quality with Gemma 4 31B.

The harness uses two operations:

- `retake` starts a new passage after the selected story part.
- `continue` continues the unfinished final assistant passage.

The harness runs both operations with seeds `101`, `202`, `303`, `404`, and
`505`. It sends the frozen v0.8.0 prompt plan and one named candidate
optimization to the same OpenAI-compatible KoboldCpp endpoint. The current
candidate is `late-cache-stable`. The replay accepts exactly this option. Both
prompt plans use the current Chat Completions adapter and
`/v1/chat/completions`.

Each request sets KoboldCpp's `cache_prompt` field to `false`. This disables
request prompt reuse for both arms. The replay parser records and verifies this
field. The runner uses the production URL, authentication, SSE, and output
limits, but sends each prepared body once. A provider 400 fails the replay;
the runner does not retry with a changed body.

The replay profile sets its own transport limits. It gives response headers ten
minutes for a cold, cache-disabled long prompt. This value does not change a
product connection default.

## Run a replay

Prepare two local JSON files for the replay.

Create a runtime configuration file. It identifies the KoboldCpp server,
the Gemma artifact, the quantization, the chat template hash, and the context
window. Use the actual server version and artifact SHA-256 value.

```json
{
  "schemaVersion": 1,
  "runtime": "koboldcpp",
  "model": {
    "id": "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    "identity": "Gemma 4 31B IT Uncensored Heretic",
    "artifact": {
      "fileName": "gemma-4-31B-it-uncensored-heretic-Q8_0.gguf",
      "sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "quantization": "Q8_0"
    }
  },
  "koboldCpp": {
    "version": "1.117.1",
    "chatTemplateSha256": "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315",
    "contextWindow": 32768
  }
}
```

Create a complete replay profile manifest. Set
`runtimeArtifactSha256` to the same value as the runtime configuration. Copy
all sampling fields. Include the raw `logitBias` map. Set `seed` to `null`
because the replay owns the fixed seed set. Set `cachePolicy` to `off`.
Set `effort` to `default`. The checked KoboldCpp runtime does not declare
reasoning-effort support.

```json
{
  "schemaVersion": 1,
  "runtimeArtifactSha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "profile": {
    "name": "Gemma replay profile",
    "generation": {
      "temperature": 0.7,
      "maxOutputTokens": 400,
      "effort": "default",
      "cachePolicy": "off",
      "tokenProbabilities": null
    },
    "timeouts": {
      "responseHeaderMs": 600000,
      "firstTokenMs": 120000,
      "idleMs": 120000,
      "totalMs": 1800000
    },
    "sampling": {
      "topP": 0.92,
      "topK": 40,
      "minP": 0.05,
      "frequencyPenalty": null,
      "presencePenalty": null,
      "repeatPenalty": 1.08,
      "seed": null,
      "dryMultiplier": null,
      "dryBase": null,
      "dryRange": null,
      "xtcThreshold": null,
      "xtcProbability": null,
      "dynatempRange": null,
      "mirostat": null,
      "mirostatTau": null,
      "mirostatEta": null,
      "stop": [],
      "logitBias": {},
      "bannedStrings": [],
      "phraseBias": [],
      "dryBreakers": []
    }
  }
}
```

The replay rejects non-empty `phraseBias` and `bannedStrings` because those
fields need server-side tokenization. The replay changes only the seed for
each run. It uses the profile transport limits for each request. Do not use an
ordinary Profile Export for this replay.

The committed approved replay protocol fixes the KoboldCpp preset, model ID,
Q8_0 quantization, chat template hash, minimum context window, and profile.
It does not fix the server version or artifact SHA-256 value.
Record those values in each real replay. The evidence binds these values, the
fixed seeds and operations, and the named `late-cache-stable` optimization.

Set `GEMMA_API_KEY` when the endpoint requires a bearer key. Do not save the
key in a file.

```text
node --import tsx evals/gemma-prompt-quality/cli.ts replay \
  --endpoint http://127.0.0.1:5001/v1 \
  --runtime-config /path/to/gemma-runtime.json \
  --profile /path/to/gemma-replay-profile.json \
  --optimization late-cache-stable \
  --exclusive-server \
  --output /tmp/gemma-replay.json
```

The `--exclusive-server` flag records that the operator stopped every other
KoboldCpp client. The raw replay and compact evidence keep this attestation.
The compatibility checker rejects evidence without it.

The replay file contains request metadata and model output. Keep this file at
a local path. Do not commit it. The file keeps exact model output for scoring.

If you change a replay request input, run a new replay. A scoring or evidence
change requires a new blind review and new evidence. It does not require a new
model replay.

Run one optimization in each replay. Keep the baseline arm on the frozen
v0.8.0 compatibility prompt. Keep the model, profile, sampler, cache policy,
fixture, and seed unchanged. Do not combine optimizations. The optimization
ID is stored in the private replay and mapping files and in compact evidence.
The blind pack does not expose the ID.

The fixture renders at least 20,000 UTF-8 bytes of post-summary story context
for each operation. The replay checks bytes because it cannot inspect the
endpoint tokenizer.

## Blind score

Create the blind scoring file and a private mapping file:

```text
node --import tsx evals/gemma-prompt-quality/cli.ts blind \
  --replay /tmp/gemma-replay.json \
  --output /tmp/gemma-blind.json \
  --mapping /tmp/gemma-blind-mapping.json
```

The command uses a private random seed for the mapping. The blind file has
one neutral ID, one opaque reference ID, and one output for each sample. The
opaque reference ID selects one of the two context references. Samples with
the same context use the same opaque reference ID. The pack has no operation
label. It has no shuffle seed, sample seed, output fingerprint, pair ID, or
arm label. Keep the mapping file local. Do not give the mapping file to the
scorer.

Score all 20 samples. Use an integer from 0 through 3 for every rubric key.
Write one short note for every sample. Use the same score meaning for every
sample. Do not identify the arm while you score.

Use these score anchors. The score command records the fingerprint of this
protocol in the compact evidence. A protocol change needs a new blind score
review. It does not need a new model replay when the saved replay, blind pack,
and private mapping remain valid.

| Score | Meaning |
| --- | --- |
| 3 | Strong continuity with no material defect in this rubric dimension. |
| 2 | Acceptable continuity with a noticeable but non-major defect in this rubric dimension. |
| 1 | A major defect or break in this rubric dimension, while the output remains partly usable. |
| 0 | Unusable, unrelated, or a severe failure in this rubric dimension. |

The five rubric keys are:

- `boundaryContinuity`
- `styleVoiceCadenceContinuity`
- `povTenseConsistency`
- `factContextRetention`
- `genericSceneResetAvoidance`

All five keys use a higher-is-better score. A high
`genericSceneResetAvoidance` score means that the output avoids a generic scene
reset.

For `styleVoiceCadenceContinuity`, stock or over-figurative prose alone is a
noticeable, non-major weakness. Use 2 when voice and cadence otherwise
continue. Use 1 only for a major voice or cadence break.

Use this score file shape:

```json
{
  "scores": [
    {
      "blindId": "blind-01",
      "scores": {
        "boundaryContinuity": 3,
        "styleVoiceCadenceContinuity": 3,
        "povTenseConsistency": 3,
        "factContextRetention": 3,
        "genericSceneResetAvoidance": 3
      },
      "notes": "Keeps the scene, voice, and established facts."
    }
  ]
}
```

Create compact evidence after all 20 scores are complete:

```text
node --import tsx evals/gemma-prompt-quality/cli.ts score \
  --replay /tmp/gemma-replay.json \
  --blind /tmp/gemma-blind.json \
  --mapping /tmp/gemma-blind-mapping.json \
  --scores /tmp/gemma-scores.json \
  --output evals/gemma-prompt-quality/evidence.json
```

The score command checks that the mapping belongs to the exact replay and
blind file before it restores the pairs. The command then writes compact
evidence. Keep the replay, blind pack, mapping, and raw scores private.

The evidence file contains no endpoint URL and no model output. It contains
the fixed runtime and profile, the optimization name, both aggregate request
fingerprints, all paired scores, dispatch order, score deltas, and regressions.

The compatibility checker accepts evidence only when every candidate score is
at least the paired v0.8.0 score for every rubric key. Each baseline score
must be 2 or more.

The operator is a trust boundary. The operator must stop other KoboldCpp
clients and pass `--exclusive-server`. The human scorer is a trust boundary.
The human scorer must score all 20 outputs without seeing the arm labels. CI
checks the evidence structure and rebuilt request bodies. CI does not prove
that the operator used an exclusive server or that the human scorer judged the
outputs correctly.
