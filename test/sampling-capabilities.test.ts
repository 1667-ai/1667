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
    // "fixture-model" is deliberately not on the tokenizer allow-list, so
    // phraseBias/bannedStrings are unavailable here even though logitBias
    // (which needs no tokenizer) is available. See "known encoded model"
    // below for the case where an allow-listed model makes them available.
    name: "OpenAI baseline preset",
    context: samplingContext("openai-chat-completions", "openai"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "unavailable", reason: "no-exact-tokenizer" })
  },
  {
    name: "known encoded model on the OpenAI baseline preset",
    context: samplingContext("openai-chat-completions", "openai", "gpt-4o"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "available", wireField: "logit_bias" })
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
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "unavailable", reason: "preset-unsupported" })
  },
  {
    name: "Anthropic preset on OpenAI protocol",
    context: samplingContext("openai-chat-completions", "anthropic"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "unavailable", reason: "no-exact-tokenizer" })
  },
  {
    // "custom" is by definition an arbitrary OpenAI-compatible endpoint at
    // an arbitrary base URL — the preset a writer uses to point 1667 at a
    // self-hosted server that is none of the three named presets, so it
    // carries the aliasing risk in its strongest form (see the
    // PRESET_SUBTRACTIONS comment in shared/sampling-capabilities.ts).
    name: "custom OpenAI-compatible preset",
    context: samplingContext("openai-chat-completions", "custom"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "unavailable", reason: "preset-unsupported" })
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
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "unavailable", reason: "preset-unsupported" })
  },
  {
    // LM Studio is a self-hosted local server (`lms load --identifier` lets
    // the operator report an arbitrary model name — see the PRESET_SUBTRACTIONS
    // comment in shared/sampling-capabilities.ts), so phraseBias/bannedStrings
    // are subtracted outright: "preset-unsupported", not "no-exact-tokenizer".
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
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" },
      dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
    }
  },
  {
    // Ollama's OpenAI-compatible endpoint documents logit_bias as
    // unsupported, so the phrase/banned shortcuts that ride the same wire
    // field are subtracted too — before the tokenizer check ever runs.
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
      phraseBias: { kind: "unavailable", reason: "preset-unsupported" },
      bannedStrings: { kind: "unavailable", reason: "preset-unsupported" },
      dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
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
    name: "llama.cpp extension preset, mirostat off",
    context: samplingContext("openai-chat-completions", "llama-cpp"),
    sampling: EMPTY_SAMPLING_V2,
    expected: llamaCppOrKoboldcppExtensions("mirostat-off", "mirostat-off", {
      kind: "available",
      wireField: "logit_bias"
    })
  },
  {
    name: "llama.cpp extension preset, mirostat configured",
    context: samplingContext("openai-chat-completions", "llama-cpp"),
    sampling: { ...EMPTY_SAMPLING_V2, mirostat: 2 },
    expected: llamaCppOrKoboldcppExtensions(
      { kind: "available", wireField: "mirostat_tau" },
      { kind: "available", wireField: "mirostat_eta" },
      { kind: "available", wireField: "logit_bias" }
    )
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
    sampling: EMPTY_SAMPLING_V2,
    expected: llamaCppOrKoboldcppExtensions("mirostat-off", "mirostat-off", {
      kind: "available",
      wireField: "logit_bias"
    })
  },
  {
    // Issue #311: KoboldCpp's own /api/extra/tokencount probe clears
    // phraseBias the same way llama.cpp's /tokenize does, so phraseBias
    // reads "available" here regardless of model, matching the llama-cpp
    // fixture above it. bannedStrings is available too, but resolves to its
    // own field (`banned_tokens`, PRESET_WIRE_OVERRIDES) rather than sharing
    // phraseBias's `logit_bias` — the one preset where the two diverge.
    name: "KoboldCpp subtraction and extension preset, mirostat off",
    context: samplingContext("openai-chat-completions", "koboldcpp"),
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      ...llamaCppOrKoboldcppExtensions(
        "mirostat-off",
        "mirostat-off",
        { kind: "available", wireField: "logit_bias" },
        { kind: "available", wireField: "banned_tokens" }
      ),
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
      ...llamaCppOrKoboldcppExtensions(
        { kind: "available", wireField: "mirostat_tau" },
        { kind: "available", wireField: "mirostat_eta" },
        { kind: "available", wireField: "logit_bias" },
        { kind: "available", wireField: "banned_tokens" }
      ),
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
      phraseBias: { kind: "unavailable", reason: "protocol" },
      bannedStrings: { kind: "unavailable", reason: "protocol" },
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
      phraseBias: { kind: "unavailable", reason: "protocol" },
      bannedStrings: { kind: "unavailable", reason: "protocol" },
      dryBreakers: { kind: "unavailable", reason: "protocol" }
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
    sampling: EMPTY_SAMPLING_V2,
    expected: {
      topP: { kind: "available", wireField: "top_p" },
      topK: { kind: "unavailable", reason: "preset-unknown" },
      minP: { kind: "unavailable", reason: "preset-unknown" },
      frequencyPenalty: { kind: "available", wireField: "frequency_penalty" },
      presencePenalty: { kind: "available", wireField: "presence_penalty" },
      repeatPenalty: { kind: "unavailable", reason: "preset-unknown" },
      // The reasoning-family gate covers logit_bias's own family (logitBias,
      // phraseBias, bannedStrings) — seed is a distinct wire field, not gated
      // by this check.
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
      logitBias: { kind: "unavailable", reason: "reasoning-model" },
      phraseBias: { kind: "unavailable", reason: "reasoning-model" },
      bannedStrings: { kind: "unavailable", reason: "reasoning-model" },
      dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
    }
  },
  {
    // A non-"openai" preset that happens to report the same model ID string
    // is not gated by this list — the reasoning-family check, like the
    // tokenizer allow-list, is only an authority for the preset whose
    // reported ID is trustworthy (see the resolveSamplingKnob comment).
    name: "a model ID matching the reasoning-family list on an untrusted preset",
    context: samplingContext("openai-chat-completions", "custom", "o3-mini"),
    sampling: EMPTY_SAMPLING_V2,
    expected: baselineOnly({ kind: "unavailable", reason: "preset-unsupported" })
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
 * extensions: openai, openrouter, anthropic-as-preset, and custom.
 * `phraseBiasFamily` varies by caller: a preset that clears the tokenizer
 * allow-list check (openai, anthropic-as-preset) resolves it per model,
 * while a subtracted preset (openrouter, custom) always reports
 * "preset-unsupported" regardless of model. */
function baselineOnly(
  phraseBiasFamily: SamplingResolution
): Readonly<Record<SamplingKnobV2, SamplingResolution>> {
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
    phraseBias: phraseBiasFamily,
    bannedStrings: phraseBiasFamily,
    dryBreakers: { kind: "unavailable", reason: "preset-unknown" }
  };
}

/** llama.cpp and KoboldCpp both gain the full extension list, so every knob
 * but frequencyPenalty (koboldcpp-only subtraction, patched in by the caller)
 * resolves available. `mirostatTauResolution`/`mirostatEtaResolution` default
 * to the shared "mirostat-off" reason so a single string toggles both
 * fixtures between mirostat off and mirostat configured. `phraseBiasFamily`
 * varies by caller: llama.cpp resolves phraseBias/bannedStrings through its
 * own live tokenize probe (always "available" here, regardless of model),
 * while KoboldCpp subtracts them outright ("preset-unsupported"). */
function llamaCppOrKoboldcppExtensions(
  mirostatTauResolution: SamplingResolution | "mirostat-off",
  mirostatEtaResolution: SamplingResolution | "mirostat-off",
  phraseBiasFamily: SamplingResolution,
  // Only KoboldCpp's bannedStrings ever resolves to a field distinct from
  // phraseBias's (`banned_tokens`, issue #311) — llama-cpp still shares
  // phraseBiasFamily's own value for both, so every existing llama-cpp
  // fixture call below needs no change.
  bannedStringsResolution: SamplingResolution = phraseBiasFamily
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
    phraseBias: phraseBiasFamily,
    bannedStrings: bannedStringsResolution,
    dryBreakers: { kind: "available", wireField: "dry_sequence_breakers" }
  };
}
