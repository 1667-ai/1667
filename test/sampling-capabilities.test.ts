import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSamplingKnob,
  samplingKnobPresentation,
  type SamplingContext,
  type SamplingResolution
} from "../shared/sampling-capabilities.js";
import {
  EMPTY_SAMPLING_V2,
  SAMPLING_KNOB_V2_VALUES,
  type FeatureSupportV2,
  type SamplingKnobV2,
  type SamplingSettingsV2,
  type SettingsPresetV2,
  type SettingsProtocolV2
} from "../shared/settings-v2-types.js";

interface SamplingCapabilityFixture {
  readonly name: string;
  readonly context: SamplingContext;
  readonly sampling: SamplingSettingsV2;
  readonly expected: Readonly<Record<SamplingKnobV2, SamplingResolution>>;
}

const SAMPLING_CAPABILITY_FIXTURES: readonly SamplingCapabilityFixture[] = [
  {
    name: "dry-run protocol and preset",
    context: samplingContext("dry-run", "dry-run"),
    sampling: EMPTY_SAMPLING_V2,
    expected: allKnobs({ kind: "unavailable", reason: "dry-run" })
  },
  {
    name: "OpenAI protocol with dry-run preset",
    context: samplingContext("openai-chat-completions", "dry-run"),
    sampling: EMPTY_SAMPLING_V2,
    expected: allKnobs({ kind: "unavailable", reason: "dry-run" })
  },
  {
    name: "OpenAI baseline preset",
    context: samplingContext("openai-chat-completions", "openai"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly()
  },
  {
    name: "OpenRouter baseline preset",
    context: samplingContext("openai-chat-completions", "openrouter"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly()
  },
  {
    name: "Anthropic preset on OpenAI protocol",
    context: samplingContext("openai-chat-completions", "anthropic"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly()
  },
  {
    name: "custom OpenAI-compatible preset",
    context: samplingContext("openai-chat-completions", "custom"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly()
  },
  {
    name: "LM Studio extension preset",
    context: samplingContext("openai-chat-completions", "lm-studio"),
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "unavailable", reason: "preset-unsupported" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "available", wireField: "repeat_penalty" },
      seed: { kind: "available", wireField: "seed" },
      dryMultiplier: { kind: "unavailable", reason: "preset-unknown" },
      dryBase: { kind: "unavailable", reason: "preset-unknown" },
      dryRange: { kind: "unavailable", reason: "preset-unknown" },
      xtcThreshold: { kind: "unavailable", reason: "preset-unknown" },
      xtcProbability: { kind: "unavailable", reason: "preset-unknown" },
      dynatempRange: { kind: "unavailable", reason: "preset-unknown" },
      mirostat: { kind: "unavailable", reason: "preset-unknown" },
      mirostatTau: { kind: "unavailable", reason: "preset-unknown" },
      mirostatEta: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "available", wireField: "logit_bias" },
      dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
    }
  },
  {
    name: "Ollama subtraction preset",
    context: samplingContext("openai-chat-completions", "ollama"),
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      seed: { kind: "available", wireField: "seed" },
      dryMultiplier: { kind: "unavailable", reason: "preset-unknown" },
      dryBase: { kind: "unavailable", reason: "preset-unknown" },
      dryRange: { kind: "unavailable", reason: "preset-unknown" },
      xtcThreshold: { kind: "unavailable", reason: "preset-unknown" },
      xtcProbability: { kind: "unavailable", reason: "preset-unknown" },
      dynatempRange: { kind: "unavailable", reason: "preset-unknown" },
      mirostat: { kind: "unavailable", reason: "preset-unknown" },
      mirostatTau: { kind: "unavailable", reason: "preset-unknown" },
      mirostatEta: { kind: "unavailable", reason: "preset-unknown" },
      stop: { kind: "available", wireField: "stop" },
      logitBias: { kind: "unavailable", reason: "preset-unsupported" },
      dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
    }
  },
  {
    name: "llama.cpp extension preset, mirostat off",
    context: samplingContext("openai-chat-completions", "llama-cpp"),
    sampling: EMPTY_SAMPLING_V2,
    expected: llamaCppOrKoboldcppExtensions("mirostat-off")
  },
  {
    name: "llama.cpp extension preset, mirostat configured",
    context: samplingContext("openai-chat-completions", "llama-cpp"),
    sampling: { ...EMPTY_SAMPLING_V2, mirostat: 2 },
    expected: llamaCppOrKoboldcppExtensions({ kind: "available", wireField: "mirostat_tau" }, {
      kind: "available",
      wireField: "mirostat_eta"
    })
  },
  {
    name: "KoboldCpp subtraction and extension preset, mirostat off",
    context: samplingContext("openai-chat-completions", "koboldcpp"),
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      ...llamaCppOrKoboldcppExtensions("mirostat-off"),
      frequencyPenalty: { kind: "unavailable", reason: "preset-unsupported" },
      // KoboldCpp's OpenAI-compatible adapter reads `mirostat_mode` and writes
      // the result over `mirostat`, so this one preset spells the field
      // differently. A request that names `mirostat` arrives as mode 0.
      mirostat: { kind: "available", wireField: "mirostat_mode" }
    }
  },
  {
    name: "KoboldCpp subtraction and extension preset, mirostat configured",
    context: samplingContext("openai-chat-completions", "koboldcpp"),
    sampling: { ...EMPTY_SAMPLING_V2, mirostat: 1 },
    expected: {
      ...llamaCppOrKoboldcppExtensions({ kind: "available", wireField: "mirostat_tau" }, {
        kind: "available",
        wireField: "mirostat_eta"
      }),
      frequencyPenalty: { kind: "unavailable", reason: "preset-unsupported" },
      mirostat: { kind: "available", wireField: "mirostat_mode" }
    }
  },
  {
    name: "known Anthropic truncation model",
    context: samplingContext("anthropic-messages", "anthropic", "claude-opus-4-5"),
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "available", wireField: "top_k" },
      minP: { kind: "unavailable", reason: "protocol" },
      frequencyPenalty: { kind: "unavailable", reason: "protocol" },
      presencePenalty: { kind: "unavailable", reason: "protocol" },
      repeatPenalty: { kind: "unavailable", reason: "protocol" },
      seed: { kind: "unavailable", reason: "protocol" },
      dryMultiplier: { kind: "unavailable", reason: "protocol" },
      dryBase: { kind: "unavailable", reason: "protocol" },
      dryRange: { kind: "unavailable", reason: "protocol" },
      xtcThreshold: { kind: "unavailable", reason: "protocol" },
      xtcProbability: { kind: "unavailable", reason: "protocol" },
      dynatempRange: { kind: "unavailable", reason: "protocol" },
      mirostat: { kind: "unavailable", reason: "protocol" },
      mirostatTau: { kind: "unavailable", reason: "protocol" },
      mirostatEta: { kind: "unavailable", reason: "protocol" },
      stop: { kind: "available", wireField: "stop_sequences" },
      logitBias: { kind: "unavailable", reason: "protocol" },
      dryBreakers: { kind: "unavailable", reason: "protocol" }
    }
  },
  {
    name: "unknown Anthropic truncation model",
    context: samplingContext("anthropic-messages", "anthropic"),
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      topP: { kind: "unavailable", reason: "model-unknown" },
      topK: { kind: "unavailable", reason: "model-unknown" },
      minP: { kind: "unavailable", reason: "protocol" },
      frequencyPenalty: { kind: "unavailable", reason: "protocol" },
      presencePenalty: { kind: "unavailable", reason: "protocol" },
      repeatPenalty: { kind: "unavailable", reason: "protocol" },
      seed: { kind: "unavailable", reason: "protocol" },
      dryMultiplier: { kind: "unavailable", reason: "protocol" },
      dryBase: { kind: "unavailable", reason: "protocol" },
      dryRange: { kind: "unavailable", reason: "protocol" },
      xtcThreshold: { kind: "unavailable", reason: "protocol" },
      xtcProbability: { kind: "unavailable", reason: "protocol" },
      dynatempRange: { kind: "unavailable", reason: "protocol" },
      mirostat: { kind: "unavailable", reason: "protocol" },
      mirostatTau: { kind: "unavailable", reason: "protocol" },
      mirostatEta: { kind: "unavailable", reason: "protocol" },
      stop: { kind: "available", wireField: "stop_sequences" },
      logitBias: { kind: "unavailable", reason: "protocol" },
      dryBreakers: { kind: "unavailable", reason: "protocol" }
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
    sampling: { ...EMPTY_SAMPLING_V2, mirostat: 2 },
    expected: allKnobs({ kind: "unavailable", reason: "model-unsupported" })
  },
  {
    name: "legacy settings",
    context: {
      protocol: "legacy-v1",
      preset: "legacy-v1",
      remoteModelId: "fixture-model",
      temperatureSupport: "unknown"
    },
    sampling: { ...EMPTY_SAMPLING_V2, mirostat: 2 },
    expected: allKnobs({ kind: "unavailable", reason: "legacy-v1" })
  }
];

test("sampling capability fixtures cover supported protocol, preset, model, and mirostat-dependency outcomes", () => {
  for (const fixture of SAMPLING_CAPABILITY_FIXTURES) {
    for (const knob of SAMPLING_KNOB_V2_VALUES) {
      assert.deepEqual(
        resolveSamplingKnob(fixture.context, fixture.sampling, knob),
        fixture.expected[knob],
        `${fixture.name}/${knob}`
      );
    }
  }
});

test("an unsupported route reports its own reason for mirostat tau/eta even with mirostat configured", () => {
  // A route that never reaches the mirostat-dependency check (dry-run here)
  // must still report its own reason, not "mirostat-off" and not "available",
  // regardless of the configured mirostat value.
  const context = samplingContext("dry-run", "dry-run");
  const configured: SamplingSettingsV2 = { ...EMPTY_SAMPLING_V2, mirostat: 2 };
  assert.deepEqual(
    resolveSamplingKnob(context, configured, "mirostatTau"),
    { kind: "unavailable", reason: "dry-run" }
  );
  assert.deepEqual(
    resolveSamplingKnob(context, configured, "mirostatEta"),
    { kind: "unavailable", reason: "dry-run" }
  );
});

test("sampling presentation exposes a stable label and a reason for disabled cells", () => {
  const presentation = samplingKnobPresentation(
    samplingContext("openai-chat-completions", "ollama"),
    EMPTY_SAMPLING_V2,
    "logitBias"
  );
  assert.deepEqual(presentation, {
    label: "logit bias",
    available: false,
    reason: "This preset does not document this parameter.",
    reasonCompact: "not in preset"
  });
});

test("sampling presentation reports mirostat-off for tau/eta when mirostat is unset", () => {
  const presentation = samplingKnobPresentation(
    samplingContext("openai-chat-completions", "llama-cpp"),
    EMPTY_SAMPLING_V2,
    "mirostatTau"
  );
  assert.deepEqual(presentation, {
    label: "mirostat tau",
    available: false,
    reason: "Mirostat is off.",
    reasonCompact: "mirostat off"
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

function allKnobs(resolution: SamplingResolution): Readonly<Record<SamplingKnobV2, SamplingResolution>> {
  return Object.fromEntries(
    SAMPLING_KNOB_V2_VALUES.map((knob) => [knob, resolution])
  ) as Readonly<Record<SamplingKnobV2, SamplingResolution>>;
}

/** The five baseline OpenAI chat-completions knobs (topP, frequencyPenalty,
 * presencePenalty, stop, logitBias) resolve available; the thirteen extension
 * knobs (topK, minP, repeatPenalty, and the ten new DRY/XTC/mirostat knobs)
 * resolve "preset-unknown". Shared by every preset that documents no
 * extensions: openai, openrouter, anthropic-as-preset, and custom. */
function baselineOnly(): Readonly<Record<SamplingKnobV2, SamplingResolution>> {
  return {
    topP: { kind: "available", wireField: "top_p" },
    topK: { kind: "unavailable", reason: "preset-unknown" },
    minP: { kind: "unavailable", reason: "preset-unknown" },
    frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
    presencePenalty: { kind: "available", wireField: "presence_penalty" },
    repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
    seed: { kind: "available", wireField: "seed" },
    dryMultiplier: { kind: "unavailable", reason: "preset-unknown" },
    dryBase: { kind: "unavailable", reason: "preset-unknown" },
    dryRange: { kind: "unavailable", reason: "preset-unknown" },
    xtcThreshold: { kind: "unavailable", reason: "preset-unknown" },
    xtcProbability: { kind: "unavailable", reason: "preset-unknown" },
    dynatempRange: { kind: "unavailable", reason: "preset-unknown" },
    mirostat: { kind: "unavailable", reason: "preset-unknown" },
    mirostatTau: { kind: "unavailable", reason: "preset-unknown" },
    mirostatEta: { kind: "unavailable", reason: "preset-unknown" },
    stop: { kind: "available", wireField: "stop" },
    logitBias: { kind: "available", wireField: "logit_bias" },
    dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
  };
}

/** llama.cpp and KoboldCpp both gain the full extension list, so every knob
 * but frequencyPenalty (koboldcpp-only subtraction, patched in by the caller)
 * resolves available. `mirostatTauResolution`/`mirostatEtaResolution` default
 * to the shared "mirostat-off" reason so a single string toggles both
 * fixtures between mirostat off and mirostat configured. */
function llamaCppOrKoboldcppExtensions(
  mirostatTauResolution: SamplingResolution | "mirostat-off",
  mirostatEtaResolution: SamplingResolution | "mirostat-off" = mirostatTauResolution
): Readonly<Record<SamplingKnobV2, SamplingResolution>> {
  const tau = mirostatTauResolution === "mirostat-off"
    ? { kind: "unavailable" as const, reason: "mirostat-off" as const }
    : mirostatTauResolution;
  const eta = mirostatEtaResolution === "mirostat-off"
    ? { kind: "unavailable" as const, reason: "mirostat-off" as const }
    : mirostatEtaResolution;
  return {
    topP: { kind: "available", wireField: "top_p" },
    topK: { kind: "available", wireField: "top_k" },
    minP: { kind: "available", wireField: "min_p" },
    frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
    presencePenalty: { kind: "available", wireField: "presence_penalty" },
    repeatPenalty: { kind: "available", wireField: "repeat_penalty" },
    seed: { kind: "available", wireField: "seed" },
    dryMultiplier: { kind: "available", wireField: "dry_multiplier" },
    dryBase: { kind: "available", wireField: "dry_base" },
    dryRange: { kind: "available", wireField: "dry_penalty_last_n" },
    xtcThreshold: { kind: "available", wireField: "xtc_threshold" },
    xtcProbability: { kind: "available", wireField: "xtc_probability" },
    dynatempRange: { kind: "available", wireField: "dynatemp_range" },
    mirostat: { kind: "available", wireField: "mirostat" },
    mirostatTau: tau,
    mirostatEta: eta,
    stop: { kind: "available", wireField: "stop" },
    logitBias: { kind: "available", wireField: "logit_bias" },
    dryBreakers: { kind: "available", wireField: "dry_sequence_breakers" }
  };
}
