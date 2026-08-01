import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSamplingKnob,
  samplingKnobPresentation,
  type SamplingContext,
  type SamplingResolution
} from "../shared/sampling-capabilities.js";
import {
  SAMPLING_KNOB_V2_VALUES,
  type FeatureSupportV2,
  type SamplingKnobV2,
  type SettingsPresetV2,
  type SettingsProtocolV2
} from "../shared/settings-v2-types.js";

interface SamplingCapabilityFixture {
  readonly name: string;
  readonly context: SamplingContext;
  readonly expected: Readonly<Record<SamplingKnobV2, SamplingResolution>>;
}

const SAMPLING_CAPABILITY_FIXTURES: readonly SamplingCapabilityFixture[] = [
  {
    name: "dry-run protocol and preset",
    context: samplingContext("dry-run", "dry-run"),
    expected: {
      topP: { kind: "unavailable", reason: "dry-run" },
      topK: { kind: "unavailable", reason: "dry-run" },
      minP: { kind: "unavailable", reason: "dry-run" },
      frequencyPenalty: { kind: "unavailable", reason: "dry-run" },
      presencePenalty: { kind: "unavailable", reason: "dry-run" },
      repeatPenalty: { kind: "unavailable", reason: "dry-run" },
      stop: { kind: "unavailable", reason: "dry-run" },
      logitBias: { kind: "unavailable", reason: "dry-run" }
    }
  },
  {
    name: "OpenAI protocol with dry-run preset",
    context: samplingContext("openai-chat-completions", "dry-run"),
    expected: {
      topP: { kind: "unavailable", reason: "dry-run" },
      topK: { kind: "unavailable", reason: "dry-run" },
      minP: { kind: "unavailable", reason: "dry-run" },
      frequencyPenalty: { kind: "unavailable", reason: "dry-run" },
      presencePenalty: { kind: "unavailable", reason: "dry-run" },
      repeatPenalty: { kind: "unavailable", reason: "dry-run" },
      stop: { kind: "unavailable", reason: "dry-run" },
      logitBias: { kind: "unavailable", reason: "dry-run" }
    }
  },
  {
    name: "OpenAI baseline preset",
    context: samplingContext("openai-chat-completions", "openai"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "OpenRouter baseline preset",
    context: samplingContext("openai-chat-completions", "openrouter"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "Anthropic preset on OpenAI protocol",
    context: samplingContext("openai-chat-completions", "anthropic"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "LM Studio extension preset",
    context: samplingContext("openai-chat-completions", "lm-studio"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "unavailable", reason: "preset-unsupported" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "available", wireField: "repeat_penalty" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "Ollama subtraction preset",
    context: samplingContext("openai-chat-completions", "ollama"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "unavailable", reason: "preset-unsupported" }
    }
  },
  {
    name: "llama.cpp extension preset",
    context: samplingContext("openai-chat-completions", "llama-cpp"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "available", wireField: "min_p" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "available", wireField: "repeat_penalty" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "KoboldCpp subtraction and extension preset",
    context: samplingContext("openai-chat-completions", "koboldcpp"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "available", wireField: "min_p" },
      frequencyPenalty: { kind: "unavailable", reason: "preset-unsupported" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "available", wireField: "repeat_penalty" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "custom OpenAI-compatible preset",
    context: samplingContext("openai-chat-completions", "custom"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    name: "known Anthropic truncation model",
    context: samplingContext("anthropic-messages", "anthropic", "claude-opus-4-5"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "unavailable", reason: "protocol" },
      frequencyPenalty: { kind: "unavailable", reason: "protocol" },
      presencePenalty: { kind: "unavailable", reason: "protocol" },
      repeatPenalty: { kind: "unavailable", reason: "protocol" },
      stop: { kind: "available", wireField: "stop_sequences" },
      logitBias: { kind: "unavailable", reason: "protocol" }
    }
  },
  {
    name: "unknown Anthropic truncation model",
    context: samplingContext("anthropic-messages", "anthropic"),
    expected: {
      topP: { kind: "unavailable", reason: "model-unknown" },
      topK: { kind: "unavailable", reason: "model-unknown" },
      minP: { kind: "unavailable", reason: "protocol" },
      frequencyPenalty: { kind: "unavailable", reason: "protocol" },
      presencePenalty: { kind: "unavailable", reason: "protocol" },
      repeatPenalty: { kind: "unavailable", reason: "protocol" },
      stop: { kind: "available", wireField: "stop_sequences" },
      logitBias: { kind: "unavailable", reason: "protocol" }
    }
  },
  {
    name: "model without temperature support",
    context: samplingContext(
      "openai-chat-completions",
      "openai",
      "fixture-model",
      "unsupported"
    ),
    expected: {
      topP: { kind: "unavailable", reason: "model-unsupported" },
      topK: { kind: "unavailable", reason: "model-unsupported" },
      minP: { kind: "unavailable", reason: "model-unsupported" },
      frequencyPenalty: { kind: "unavailable", reason: "model-unsupported" },
      presencePenalty: { kind: "unavailable", reason: "model-unsupported" },
      repeatPenalty: { kind: "unavailable", reason: "model-unsupported" },
      stop: { kind: "unavailable", reason: "model-unsupported" },
      logitBias: { kind: "unavailable", reason: "model-unsupported" }
    }
  },
  {
    name: "legacy settings",
    context: {
      protocol: "legacy-v1",
      preset: "legacy-v1",
      remoteModelId: "fixture-model",
      temperatureSupport: "unknown"
    },
    expected: {
      topP: { kind: "unavailable", reason: "legacy-v1" },
      topK: { kind: "unavailable", reason: "legacy-v1" },
      minP: { kind: "unavailable", reason: "legacy-v1" },
      frequencyPenalty: { kind: "unavailable", reason: "legacy-v1" },
      presencePenalty: { kind: "unavailable", reason: "legacy-v1" },
      repeatPenalty: { kind: "unavailable", reason: "legacy-v1" },
      stop: { kind: "unavailable", reason: "legacy-v1" },
      logitBias: { kind: "unavailable", reason: "legacy-v1" }
    }
  }
];

test("sampling capability fixtures cover supported protocol, preset, and model outcomes", () => {
  for (const fixture of SAMPLING_CAPABILITY_FIXTURES) {
    for (const knob of SAMPLING_KNOB_V2_VALUES) {
      assert.deepEqual(
        resolveSamplingKnob(fixture.context, knob),
        fixture.expected[knob],
        `${fixture.name}/${knob}`
      );
    }
  }
});

test("sampling presentation exposes a stable label and a reason for disabled cells", () => {
  const presentation = samplingKnobPresentation(
    samplingContext("openai-chat-completions", "ollama"),
    "logitBias"
  );
  assert.deepEqual(presentation, {
    label: "logit bias",
    available: false,
    reason: "This preset does not document this parameter.",
    reasonCompact: "not in preset"
  });
});

function samplingContext(
  protocol: SettingsProtocolV2,
  preset: SettingsPresetV2,
  remoteModelId = "fixture-model",
  temperatureSupport: FeatureSupportV2 = "supported"
): SamplingContext {
  return { protocol, preset, remoteModelId, temperatureSupport };
}
