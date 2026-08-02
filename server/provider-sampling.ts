import {
  promptBiasTokenizerEncoding,
  resolveConfiguredSamplingKnobs,
  samplingKnobLabel,
  type SamplingContext,
  type SamplingUnavailableReason
} from "../shared/sampling-capabilities.js";
import { maxResolvedLogitBiasEntries } from "../shared/sampling-validation-policy.js";
import type {
  SamplingKnobV2,
  SamplingScalarKnobV2,
  SamplingSettingsV2,
  SettingsPresetV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import {
  isLogitBiasMergeKnob,
  resolveSamplingLogitBias,
  samplingBiasResolutionFailureMessage
} from "./sampling-phrase-bias.js";

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
  const configured = resolveConfiguredSamplingKnobs(context, sampling);
  for (const { knob, resolution } of configured) {
    if (resolution.kind === "unavailable") {
      throw new ProviderError(
        `Configured sampling parameter ${samplingKnobLabel(knob)} is unavailable: ${
          PROVIDER_UNAVAILABLE_REASON[resolution.reason]
        }`
      );
    }
  }
  if (configured.some(({ knob }) => isLogitBiasMergeKnob(knob))) {
    body.logit_bias = mergedLogitBiasValue(sampling, context);
  }
  for (const { knob, resolution } of configured) {
    if (resolution.kind !== "available") continue;
    if (isLogitBiasMergeKnob(knob)) continue;
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
  "model-unknown": "This model has no documented support for this parameter.",
  "no-exact-tokenizer": "1667 has no exact tokenizer for this model."
};

/** Runs the shared tokenize-and-merge resolution (server/sampling-phrase-bias.ts)
 * and its preset-aware bound unconditionally — even when phraseBias and
 * bannedStrings are both empty, resolution just sorts the raw numeric map,
 * which still needs the same bound check: a raw logitBias map alone can
 * carry more entries than a preset (KoboldCpp) documents. There is one cap,
 * on one object, checked one way. */
function mergedLogitBiasValue(
  sampling: SamplingSettingsV2,
  context: SamplingContext
): Readonly<Record<string, number>> {
  const preset = requirePreset(context.preset);
  const encoding = promptBiasTokenizerEncoding(context.remoteModelId);
  const resolved = resolveSamplingLogitBias(sampling, encoding);
  if (resolved.kind !== "resolved") {
    throw new ProviderError(`Could not resolve phrase bias or banned strings: ${samplingBiasResolutionFailureMessage(resolved)}.`);
  }
  const bound = maxResolvedLogitBiasEntries(preset);
  if (resolved.resolvedEntryCount > bound) {
    throw new ProviderError(
      `Resolved logit bias has ${resolved.resolvedEntryCount} entries, `
      + `exceeding the ${bound}-entry limit for preset ${preset}.`
    );
  }
  return sortedLogitBias(resolved.logitBias);
}

function requirePreset(preset: SettingsPresetV2 | "legacy-v1"): SettingsPresetV2 {
  if (preset === "legacy-v1") {
    throw new Error("Legacy v1 settings cannot reach sampling encoding");
  }
  return preset;
}

function sortedLogitBias(logitBias: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(logitBias).sort((left, right) => Number(left[0]) - Number(right[0]))
  );
}

function encodeSamplingValue(
  knob: Exclude<SamplingKnobV2, "logitBias" | "phraseBias" | "bannedStrings">,
  sampling: SamplingSettingsV2
): number | readonly string[] {
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
    case "stop":
      return [...sampling.stop];
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
