# Gemma Prompt Quality Replay

This harness checks continuation prompt quality with Gemma 4 31B.

The harness uses two operations:

- `retake` starts a new passage after the selected story part.
- `continue` continues the unfinished final assistant passage.

The harness runs both operations with seeds `101`, `202`, `303`, `404`, and
`505`. It sends the frozen v0.8.0 prompt plan and the current prompt plan to
the same OpenAI-compatible llama.cpp endpoint. Both prompt plans use the
current Chat Completions adapter and `/v1/chat/completions`.

Each request sets llama.cpp's `cache_prompt` field to `false`. This disables
request prompt reuse for both arms. The replay parser records and verifies this
field. The runner uses the production URL, authentication, SSE, and output
limits, but sends each prepared body once. A provider 400 fails the replay;
the runner does not retry with a changed body.

## Run a replay

Prepare two local JSON files for the replay.

Create a runtime configuration file. It identifies the llama.cpp build, the
Gemma artifact, the quantization, the chat template, and the context window.
Use the actual artifact SHA-256 value.

```json
{
  "schemaVersion": 1,
  "runtime": "llama.cpp",
  "model": {
    "id": "gemma-4-31b",
    "identity": "Gemma 4 31B",
    "artifact": {
      "fileName": "gemma-4-31b-Q4_K_M.gguf",
      "sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "quantization": "Q4_K_M"
    }
  },
  "llamaCpp": {
    "build": "b1234",
    "chatTemplate": "gemma",
    "contextWindow": 32768
  }
}
```

Create a complete replay profile manifest. Set
`runtimeArtifactSha256` to the same value as the runtime configuration. Copy
all sampling fields. Include the raw `logitBias` map. Set `seed` to `null`
because the replay owns the fixed seed set. Set `cachePolicy` to `off`.
Set `effort` to `default`. The checked llama.cpp runtime does not declare
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
each run. Do not use an ordinary Profile Export for this replay.

The committed approved replay protocol fixes these runtime and profile values.
It does not fix the artifact SHA-256 value or llama.cpp build value. Record
those values in each real replay. The repository has no initial live evidence
because its protected prompt sources equal the frozen v0.8.0 baseline. The
first protected prompt or evaluation-input change must add real replay evidence.

Set `GEMMA_API_KEY` when the endpoint requires a bearer key. Do not save the
key in a file.

```text
node --import tsx evals/gemma-prompt-quality/cli.ts replay \
  --endpoint http://127.0.0.1:8080/v1 \
  --runtime-config /path/to/gemma-runtime.json \
  --profile /path/to/gemma-replay-profile.json \
  --output /tmp/gemma-replay.json
```

The replay file contains request metadata and model output. Keep this file at
a local path. Do not commit it. The file keeps exact model output for scoring.

The replay records the fixture and approved replay protocol fingerprint. Make
a new replay when either file changes.

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

The command uses cryptographic random data for the mapping. The blind file has
one neutral ID, one opaque reference ID, and one output for each sample. The
opaque reference ID selects one of the two context references. Samples with
the same context use the same opaque reference ID. The pack has no operation
label. It has no shuffle seed, sample seed, output fingerprint, pair ID, or
arm label. Keep the mapping file local. Do not give the mapping file to the
scorer.

Score all 20 samples. Use an integer from 0 through 3 for every rubric key.
Write one short note for every sample. Use the same score meaning for every
sample. Do not identify the arm while you score.

The five rubric keys are:

- `boundaryContinuity`
- `styleVoiceCadenceContinuity`
- `povTenseConsistency`
- `factContextRetention`
- `genericSceneResetAvoidance`

All five keys use a higher-is-better score. A high
`genericSceneResetAvoidance` score means that the output avoids a generic scene
reset.

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
evidence. You can publish the mapping data after scoring.

The evidence file contains no endpoint URL and no model output. It contains
both source fingerprints, both aggregate request fingerprints, all paired
scores, dispatch order, score deltas, and regressions.

The compatibility checker accepts evidence only when every candidate score is
at least the paired v0.8.0 score for every rubric key.
