# Fact consistency evaluation

This evaluation measures the Fact consistency prompt with planted
contradictions. It records found, missed, unexpected, dropped, and incomplete
results. It does not store model output.

Run the evaluation with Gemma through a local OpenAI-compatible KoboldCpp
endpoint:

```text
node --import tsx evals/fact-consistency/cli.ts \
  --transport openai \
  --endpoint http://127.0.0.1:5001/v1 \
  --model MODEL_ID \
  --output /tmp/fact-consistency-gemma.json
```

Run the evaluation with a hosted model through Claude CLI:

```text
node --import tsx evals/fact-consistency/cli.ts \
  --transport claude-cli \
  --model MODEL_ID \
  --output /tmp/fact-consistency-hosted.json
```

Keep the reports outside the repository. Compare the totals before you change
the prompt contract. Run one local model and one hosted model before a release
that first contains the check.
