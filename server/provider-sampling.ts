import {
  SAMPLING_KNOB_V2_VALUES,
  resolveSamplingKnob,
  samplingKnobWireName,
  samplingKnobPresentation,
  samplingKnobValueIsSet,
  type SamplingContext
} from "../shared/sampling-capabilities.js";
import type {
  SamplingKnobV2,
  SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { providerRuntimeFor } from "./provider-runtime.js";

export function applySamplingFields(
  body: Record<string, unknown>,
  settings: GenerationSettings,
  protocol: "openai-chat-completions" | "anthropic-messages"
): void {
  const runtime = providerRuntimeFor(settings);
  const sampling = runtime.sampling;
  const context: SamplingContext = {
    protocol,
    preset: runtime.preset,
    remoteModelId: settings.model,
    temperatureSupport: runtime.capabilities.temperature
  };
  for (const knob of SAMPLING_KNOB_V2_VALUES) {
    if (!samplingKnobValueIsSet(sampling, knob)) continue;
    const resolution = resolveSamplingKnob(context, knob);
    if (resolution.kind === "unavailable") {
      const presentation = samplingKnobPresentation(context, knob);
      throw new ProviderError(
        `Configured sampling parameter ${samplingKnobWireName(knob)} is unavailable: ${presentation.reason}`
      );
    }
    body[resolution.wireField] = encodeSamplingValue(knob, sampling);
  }
}

function encodeSamplingValue(
  knob: SamplingKnobV2,
  sampling: SamplingSettingsV2
): number | readonly string[] | Readonly<Record<string, number>> {
  const value = sampling[knob];
  switch (knob) {
    case "topP":
    case "topK":
    case "minP":
    case "frequencyPenalty":
    case "presencePenalty":
    case "repeatPenalty":
      return value as number;
    case "stop":
      return [...(value as readonly string[])];
    case "logitBias":
      return Object.fromEntries(
        Object.entries(value as Readonly<Record<string, number>>)
          .sort((left, right) => Number(left[0]) - Number(right[0]))
      );
  }
}
