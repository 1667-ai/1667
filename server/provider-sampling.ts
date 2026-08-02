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
import { resolveSamplingLogitBias, resolvedLogitBiasExceedsBound } from "./sampling-phrase-bias.js";

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
  const mergeKnobs = new Set(
    configured.map(({ knob }) => knob).filter(isLogitBiasMergeKnob)
  );
  if (mergeKnobs.size > 0) {
    body.logit_bias = mergedLogitBiasValue(sampling, context, mergeKnobs);
  }
  for (const { knob, resolution } of configured) {
    if (isLogitBiasMergeKnob(knob) || resolution.kind !== "available") continue;
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

function isLogitBiasMergeKnob(
  knob: SamplingKnobV2
): knob is "logitBias" | "phraseBias" | "bannedStrings" {
  return knob === "logitBias" || knob === "phraseBias" || knob === "bannedStrings";
}

/** phraseBias and bannedStrings only ever reach "available" resolution when
 * the routed model is on the closed tokenizer allow-list (see
 * `needsExactTokenizer` in shared/sampling-capabilities.js), so tokenization
 * is only attempted, and an encoding is only required, when one of those two
 * was actually configured. */
function mergedLogitBiasValue(
  sampling: SamplingSettingsV2,
  context: SamplingContext,
  mergeKnobs: ReadonlySet<SamplingKnobV2>
): Readonly<Record<string, number>> {
  if (!mergeKnobs.has("phraseBias") && !mergeKnobs.has("bannedStrings")) {
    return sortedLogitBias(sampling.logitBias);
  }
  const preset = requirePreset(context.preset);
  const encoding = promptBiasTokenizerEncoding(context.remoteModelId);
  if (encoding === null) {
    // Unreachable in practice: resolution above already rejected this case
    // as "no-exact-tokenizer" before body construction started.
    throw new ProviderError(
      `${samplingKnobLabel("phraseBias")} and ${samplingKnobLabel("bannedStrings")} require an exact tokenizer, and none is available for this model.`
    );
  }
  const resolved = resolveSamplingLogitBias(sampling, encoding);
  if (resolved === null) {
    throw new ProviderError("The tokenizer needed to resolve phrase bias or banned strings failed to load.");
  }
  if (resolvedLogitBiasExceedsBound(resolved.resolvedEntryCount, preset)) {
    throw new ProviderError(
      `Resolved logit bias has ${resolved.resolvedEntryCount} entries after tokenizing phrase bias and banned strings, `
      + `exceeding the ${maxResolvedLogitBiasEntries(preset)}-entry limit for preset ${preset}.`
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
    case "stop":
      return [...sampling.stop];
    case "logitBias":
    case "phraseBias":
    case "bannedStrings":
      throw new Error(`${knob} is handled by mergedLogitBiasValue, not encodeSamplingValue`);
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
