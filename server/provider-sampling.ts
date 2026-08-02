import {
  resolveConfiguredSamplingKnobs,
  samplingKnobLabel,
  type SamplingContext,
  type SamplingUnavailableReason
} from "../shared/sampling-capabilities.js";
import type {
  SamplingKnobV2,
  SamplingScalarKnobV2,
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
  const plan = resolveConfiguredSamplingKnobs(context, sampling).map(({ knob, resolution }) => {
    if (resolution.kind === "unavailable") {
      throw new ProviderError(
        `Configured sampling parameter ${samplingKnobLabel(knob)} is unavailable: ${
          PROVIDER_UNAVAILABLE_REASON[resolution.reason]
        }`
      );
    }
    return {
      wireField: resolution.wireField,
      value: encodeSamplingValue(knob, sampling)
    };
  });
  for (const { wireField, value } of plan) body[wireField] = value;
}

const PROVIDER_UNAVAILABLE_REASON: Readonly<Record<SamplingUnavailableReason, string>> = {
  "legacy-v1": "Format 1 settings are read-only.",
  "dry-run": "Dry run does not send provider requests.",
  protocol: "This protocol does not document this parameter.",
  "preset-unsupported": "This preset does not document this parameter.",
  "preset-unknown": "This endpoint does not document extension parameters.",
  "model-unsupported": "This model does not declare sampling support.",
  "model-unknown": "This model has no documented support for this parameter."
};

function encodeSamplingValue(
  knob: SamplingKnobV2,
  sampling: SamplingSettingsV2
): number | readonly string[] | Readonly<Record<string, number>> {
  switch (knob) {
    case "topP":
      return configuredScalarValue(sampling.topP, knob);
    case "topK":
      return configuredScalarValue(sampling.topK, knob);
    case "minP":
      return configuredScalarValue(sampling.minP, knob);
    case "frequencyPenalty":
      return configuredScalarValue(sampling.frequencyPenalty, knob);
    case "presencePenalty":
      return configuredScalarValue(sampling.presencePenalty, knob);
    case "repeatPenalty":
      return configuredScalarValue(sampling.repeatPenalty, knob);
    case "seed":
      return configuredScalarValue(sampling.seed, knob);
    case "stop":
      return [...sampling.stop];
    case "logitBias":
      return Object.fromEntries(
        Object.entries(sampling.logitBias)
          .sort((left, right) => Number(left[0]) - Number(right[0]))
      );
    default:
      return assertNever(knob);
  }
}

function configuredScalarValue(
  value: number | null,
  knob: SamplingScalarKnobV2
): number {
  if (value === null) {
    throw new Error(`Configured sampling scalar ${samplingKnobLabel(knob)} is unexpectedly null`);
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported sampling parameter ${String(value)}`);
}
