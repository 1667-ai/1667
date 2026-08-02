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
      logitBias: { kind: "unavailable", reason: "dry-run" },
      phraseBias: { kind: "unavailable", reason: "dry-run" },
      bannedStrings: { kind: "unavailable", reason: "dry-run" }
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
      logitBias: { kind: "unavailable", reason: "dry-run" },
      phraseBias: { kind: "unavailable", reason: "dry-run" },
      bannedStrings: { kind: "unavailable", reason: "dry-run" }
    }
  },
  {
    // "fixture-model" is deliberately not on the tokenizer allow-list, so
    // phraseBias/bannedStrings are unavailable here even though logitBias
    // (which needs no tokenizer) is available. See "known encoded model"
    // below for the case where an allow-listed model makes them available.
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "no-exact-tokenizer" },
      bannedStrings: { kind: "unavailable", reason: "no-exact-tokenizer" }
    }
  },
  {
    name: "known encoded model on the OpenAI baseline preset",
    context: samplingContext("openai-chat-completions", "openai", "gpt-4o"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "available", wireField: "logit_bias" },
      bannedStrings: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    // OpenRouter's base URL is fixed and real (openrouter.ai), but it
    // routes a given model ID to arbitrary providers and model families
    // behind the scenes — the vocabulary that will actually serve a
    // request is unknowable client-side, so phraseBias/bannedStrings are
    // subtracted outright, the same as the self-hosted presets with no
    // trusted tokenizer (see the PRESET_SUBTRACTIONS comment in
    // shared/sampling-capabilities.ts).
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "no-exact-tokenizer" },
      bannedStrings: { kind: "unavailable", reason: "no-exact-tokenizer" }
    }
  },
  {
    // LM Studio is a self-hosted local server (`lms load --identifier` lets
    // the operator report an arbitrary model name — see the PRESET_SUBTRACTIONS
    // comment in shared/sampling-capabilities.ts), so phraseBias/bannedStrings
    // are subtracted outright: "preset-unsupported", not "no-exact-tokenizer".
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
    }
  },
  {
    // Ollama's OpenAI-compatible endpoint documents logit_bias as
    // unsupported, so the phrase/banned shortcuts that ride the same wire
    // field are subtracted too — before the tokenizer check ever runs.
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
      logitBias: { kind: "unavailable", reason: "preset-unsupported" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
    }
  },
  {
    // llama.cpp is the one self-hosted preset not subtracted (issue #282
    // stage 1, point 5): its native POST /tokenize endpoint tokenizes
    // against whatever model that server instance actually has loaded,
    // independent of the reported name, so 1667 asks the server instead of
    // trusting a static allow-list keyed on that name. That live probe is
    // async and cannot run inside this synchronous capability check, so
    // phraseBias/bannedStrings read "available" here regardless of model —
    // resolution, and its own "tokenizer failed" outcome, happens at
    // request build time and in the editor's resolveSamplingBias preview
    // (server/sampling-phrase-bias.ts).
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "available", wireField: "logit_bias" },
      bannedStrings: { kind: "available", wireField: "logit_bias" }
    }
  },
  {
    // llama.cpp's server documents "-a, --alias STRING" ("set model name
    // aliases ... to be used by API"), so a self-hosted server can report
    // any model name it likes — but that no longer matters for phraseBias/
    // bannedStrings availability here, because the live tokenize probe
    // (not the reported name) is what actually resolves text to token IDs.
    // An allow-listed name like "gpt-4o" changes nothing.
    name: "llama.cpp preset with an allow-listed model name",
    context: samplingContext("openai-chat-completions", "llama-cpp", "gpt-4o"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "available", wireField: "min_p" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "available", wireField: "repeat_penalty" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "available", wireField: "logit_bias" },
      bannedStrings: { kind: "available", wireField: "logit_bias" }
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
    }
  },
  {
    // "custom" is by definition an arbitrary OpenAI-compatible endpoint at
    // an arbitrary base URL — the preset a writer uses to point 1667 at a
    // self-hosted server that is none of the three named presets, so it
    // carries the aliasing risk in its strongest form (see the
    // PRESET_SUBTRACTIONS comment in shared/sampling-capabilities.ts).
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
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
    }
  },
  {
    // Regression test for a gap found after the initial B fix: "custom" is
    // an arbitrary OpenAI-compatible endpoint at an arbitrary base URL, so
    // a self-hosted server reached through it can report any model name it
    // likes, the same as an aliased llama.cpp server. "gpt-4o" is on the
    // tokenizer allow-list (promptBiasTokenizerEncoding), but the preset
    // subtraction must win regardless — trusting the reported name here
    // would let a "custom"-routed local model receive real OpenAI token
    // IDs for a different vocabulary.
    name: "custom preset with an allow-listed model name",
    context: samplingContext("openai-chat-completions", "custom", "gpt-4o"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
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
      logitBias: { kind: "unavailable", reason: "protocol" },
      phraseBias: { kind: "unavailable", reason: "protocol" },
      bannedStrings: { kind: "unavailable", reason: "protocol" }
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
      logitBias: { kind: "unavailable", reason: "protocol" },
      phraseBias: { kind: "unavailable", reason: "protocol" },
      bannedStrings: { kind: "unavailable", reason: "protocol" }
    }
  },
  {
    // Reasoning-family OpenAI models reject logit_bias outright (Microsoft's
    // Azure OpenAI docs, which mirror OpenAI's model capabilities, list it
    // explicitly under "Not Supported" for reasoning models — see the
    // OPENAI_REASONING_FAMILY_MODELS comment in
    // shared/sampling-capabilities.ts). This gates logitBias itself, not
    // only phraseBias/bannedStrings, because a raw token ID rides the same
    // wire field. Every other knob is unaffected.
    name: "reasoning-family OpenAI model",
    context: samplingContext("openai-chat-completions", "openai", "o3-mini"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "unavailable", reason: "reasoning-model" },
      phraseBias: { kind: "unavailable", reason: "reasoning-model" },
      bannedStrings: { kind: "unavailable", reason: "reasoning-model" }
    }
  },
  {
    // A non-"openai" preset that happens to report the same model ID string
    // is not gated by this list — the reasoning-family check, like the
    // tokenizer allow-list, is only an authority for the preset whose
    // reported ID is trustworthy (see the resolveSamplingKnob comment).
    name: "a model ID matching the reasoning-family list on an untrusted preset",
    context: samplingContext("openai-chat-completions", "custom", "o3-mini"),
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" },
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" }
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
      logitBias: { kind: "unavailable", reason: "model-unsupported" },
      phraseBias: { kind: "unavailable", reason: "model-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "model-unsupported" }
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
      logitBias: { kind: "unavailable", reason: "legacy-v1" },
      phraseBias: { kind: "unavailable", reason: "legacy-v1" },
      bannedStrings: { kind: "unavailable", reason: "legacy-v1" }
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
