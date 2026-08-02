import {
  resolveConfiguredSamplingKnobs,
  samplingKnobLabel,
  samplingUnavailableReason,
  type SamplingContext
} from "../shared/sampling-capabilities.js";
import {
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingKnobV2,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2
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
          samplingUnavailableReason(resolution.reason)
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

const SAMPLING_SCALAR_KNOB_SET: ReadonlySet<SamplingKnobV2> = new Set(
  SAMPLING_SCALAR_KNOB_V2_VALUES
);

function isSamplingScalarKnob(knob: SamplingKnobV2): knob is SamplingScalarKnobV2 {
  return SAMPLING_SCALAR_KNOB_SET.has(knob);
}

function encodeSamplingValue(
  knob: SamplingKnobV2,
  sampling: SamplingSettingsV2
): number | readonly string[] | Readonly<Record<string, number>> {
  if (isSamplingScalarKnob(knob)) return configuredScalarValue(sampling[knob], knob);
  switch (knob) {
    case "stop":
      return [...sampling.stop];
    case "dryBreakers":
      return [...sampling.dryBreakers];
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
