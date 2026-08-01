import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSamplingKnob,
  samplingKnobPresentation,
  type SamplingContext
} from "../shared/sampling-capabilities.js";
import {
  SAMPLING_KNOB_V2_VALUES,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  type SamplingKnobV2,
  type SettingsPresetV2,
  type SettingsProtocolV2
} from "../shared/settings-v2-types.js";

const OPENAI_BASELINE = new Map<SamplingKnobV2, string>([
  ["topP", "top_p"],
  ["frequencyPenalty", "frequency_penalty"],
  ["presencePenalty", "presence_penalty"],
  ["stop", "stop"],
  ["logitBias", "logit_bias"]
]);
const OPENAI_EXTENSIONS = new Map<SettingsPresetV2, readonly SamplingKnobV2[]>([
  ["llama-cpp", ["topK", "minP", "repeatPenalty"]],
  ["lm-studio", ["topK", "repeatPenalty"]],
  ["koboldcpp", ["topK", "minP", "repeatPenalty"]]
]);

test("sampling capability resolution covers every protocol, preset, and knob cell", () => {
  for (const protocol of SETTINGS_PROTOCOL_V2_VALUES) {
    for (const preset of SETTINGS_PRESET_V2_VALUES) {
      for (const knob of SAMPLING_KNOB_V2_VALUES) {
        const context = samplingContext(protocol, preset);
        const resolution = resolveSamplingKnob(context, knob);
        const expected = expectedCell(protocol, preset, knob);
        assert.deepEqual(resolution, expected, `${protocol}/${preset}/${knob}`);
      }
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

test("Anthropic truncation sampling requires a documented exact model", () => {
  const known = samplingContext(
    "anthropic-messages",
    "anthropic",
    "claude-opus-4-5"
  );
  assert.deepEqual(resolveSamplingKnob(known, "topP"), {
    kind: "available",
    wireField: "top_p"
  });
  assert.deepEqual(resolveSamplingKnob(known, "topK"), {
    kind: "available",
    wireField: "top_k"
  });
  assert.deepEqual(
    resolveSamplingKnob(samplingContext("anthropic-messages", "anthropic"), "topP"),
    { kind: "unavailable", reason: "model-unknown" }
  );
});

function samplingContext(
  protocol: SettingsProtocolV2,
  preset: SettingsPresetV2,
  remoteModelId = "fixture-model"
): SamplingContext {
  return {
    protocol,
    preset,
    remoteModelId,
    temperatureSupport: "supported"
  };
}

function expectedCell(
  protocol: SettingsProtocolV2,
  preset: SettingsPresetV2,
  knob: SamplingKnobV2
) {
  if (protocol === "dry-run" || preset === "dry-run") {
    return { kind: "unavailable", reason: "dry-run" } as const;
  }
  if (protocol === "openai-chat-completions") {
    const wire = OPENAI_BASELINE.get(knob)
      ?? (knob === "topK" ? "top_k" : undefined)
      ?? (knob === "minP" ? "min_p" : undefined)
      ?? (knob === "repeatPenalty" ? "repeat_penalty" : undefined);
    if (wire === undefined) return { kind: "unavailable", reason: "protocol" } as const;
    if (
      preset === "lm-studio" && knob === "minP"
      || preset === "ollama" && knob === "logitBias"
      || preset === "koboldcpp" && knob === "frequencyPenalty"
    ) return { kind: "unavailable", reason: "preset-unsupported" } as const;
    if (!OPENAI_BASELINE.has(knob) && !OPENAI_EXTENSIONS.get(preset)?.includes(knob)) {
      return { kind: "unavailable", reason: "preset-unknown" } as const;
    }
    return { kind: "available", wireField: wire } as const;
  }
  if (knob === "topP") return { kind: "unavailable", reason: "model-unknown" } as const;
  if (knob === "topK") return { kind: "unavailable", reason: "model-unknown" } as const;
  if (knob === "stop") return { kind: "available", wireField: "stop_sequences" } as const;
  return { kind: "unavailable", reason: "protocol" } as const;
}
