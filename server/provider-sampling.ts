import {
  resolveConfiguredSamplingKnobs,
  samplingKnobWireName,
  type SamplingContext,
  type SamplingUnavailableReason
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
  for (const { knob, resolution } of resolveConfiguredSamplingKnobs(context, sampling)) {
    if (resolution.kind === "unavailable") {
      throw new ProviderError(
        `Configured sampling parameter ${samplingKnobWireName(knob)} is unavailable: ${
          PROVIDER_UNAVAILABLE_REASON[resolution.reason]
        }`
      );
    }
    body[resolution.wireField] = encodeSamplingValue(knob, sampling);
  }
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
