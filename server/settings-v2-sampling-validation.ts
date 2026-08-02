import {
  SAMPLING_KNOB_V2_ADDITIVE_VALUES,
  SAMPLING_KNOB_V2_VALUES,
  type GenerationProfileV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import {
  promptBiasTokenizerEncoding,
  resolveConfiguredSamplingKnobs,
  samplingContextForRoute,
  samplingKnobValueIsSet,
  samplingKnobLabel
} from "../shared/sampling-capabilities.js";
import type { SamplingUnavailableReason } from "../shared/sampling-capabilities.js";
import type { SelectedSettingsRouteV2 } from "../shared/settings-route.js";
import {
  maxResolvedLogitBiasEntries,
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingLogitBias,
  validateSamplingPhraseBias,
  validateSamplingScalarOrNull,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "../shared/sampling-validation-policy.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import {
  samplingBiasEntryRejectionMessage,
  samplingBiasResolutionFailureMessage,
  type SamplingBiasEntryResolution
} from "../shared/sampling-capabilities.js";
import {
  isLogitBiasMergeKnob,
  resolveSamplingLogitBiasForEncoding
} from "./sampling-phrase-bias.js";

// SAMPLING_KNOB_V2_ADDITIVE_VALUES are optional on the wire: a settings
// document written before issue #282 has a `sampling` object without them,
// and it must still decode. Every field present before that change stays
// required, unchanged from the original schema.
const SAMPLING = closedShape(
  SAMPLING_KNOB_V2_VALUES.filter((knob) => !(SAMPLING_KNOB_V2_ADDITIVE_VALUES as readonly SamplingKnobV2[]).includes(knob)),
  [...SAMPLING_KNOB_V2_ADDITIVE_VALUES]
);

export function parseSampling(value: unknown, label: string): SamplingSettingsV2 | undefined {
  if (value === undefined) return undefined;
  const sampling = closedRecord(value, label, SAMPLING);
  const parsed: SamplingSettingsV2 = samplingPolicy(() => ({
    topP: samplingScalarOrNull("topP", sampling.topP, `${label}.topP`),
    topK: samplingScalarOrNull("topK", sampling.topK, `${label}.topK`),
    minP: samplingScalarOrNull("minP", sampling.minP, `${label}.minP`),
    frequencyPenalty: samplingScalarOrNull(
      "frequencyPenalty",
      sampling.frequencyPenalty,
      `${label}.frequencyPenalty`
    ),
    presencePenalty: samplingScalarOrNull(
      "presencePenalty",
      sampling.presencePenalty,
      `${label}.presencePenalty`
    ),
    repeatPenalty: samplingScalarOrNull(
      "repeatPenalty",
      sampling.repeatPenalty,
      `${label}.repeatPenalty`
    ),
    seed: samplingScalarOrNull("seed", sampling.seed, `${label}.seed`),
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`),
    bannedStrings: validateSamplingBannedStrings(
      sampling.bannedStrings ?? [],
      `${label}.bannedStrings`
    ),
    phraseBias: validateSamplingPhraseBias(sampling.phraseBias ?? [], `${label}.phraseBias`)
  }));
  return SAMPLING_KNOB_V2_VALUES.some((knob) => samplingKnobValueIsSet(parsed, knob))
    ? parsed
    : undefined;
}

function samplingScalarOrNull(
  knob: SamplingScalarKnob,
  value: unknown,
  label: string
): number | null {
  return validateSamplingScalarOrNull(knob, value, label);
}

function samplingPolicy<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SamplingValidationError) {
      throw new SettingsFormatError(error.message, { cause: error });
    }
    throw error;
  }
}

export function validateSamplingRoute(
  profileId: string,
  profile: GenerationProfileV2,
  model: ModelDefinitionV2,
  connection: ModelConnectionV2
): void {
  if (profile.sampling === undefined) return;
  const route: SelectedSettingsRouteV2 = { profileId, profile, model, connection };
  const context = samplingContextForRoute(route);
  const configured = resolveConfiguredSamplingKnobs(context, profile.sampling);
  for (const { knob, resolution } of configured) {
    if (resolution.kind === "unavailable") {
      throw new SettingsFormatError(samplingValidationMessage(profileId, knob, resolution.reason));
    }
  }
  // Resolve now, at save time, unconditionally whenever logitBias,
  // phraseBias, or bannedStrings is configured — even when only the raw
  // numeric logitBias map is set, so a phrase list (or a raw map alone)
  // that would exceed the preset-aware resolved bound
  // (shared/sampling-validation-policy.ts) is rejected here with a clear
  // message instead of failing later mid-generation. A gate that only
  // covered phraseBias/bannedStrings previously let a KoboldCpp profile
  // with 17 plain numeric entries save cleanly.
  if (context.protocol === "legacy-v1" || context.preset === "legacy-v1") return;
  if (!configured.some(({ knob }) => isLogitBiasMergeKnob(knob))) return;
  // llama-cpp resolves phraseBias/bannedStrings through a live tokenize
  // probe (server/context-probe.ts, probeLlamaCppTokenize) instead of a
  // local allow-list, and this function must stay synchronous — see
  // resolveSamplingLogitBiasForEncoding's own comment for why. Every entry
  // on a llama-cpp profile was already individually verified when the
  // writer committed it in the editor (server/story-service.ts,
  // resolveSamplingBias), and request-time application
  // (server/provider-sampling.ts) re-verifies against the live server and
  // enforces the resolved-count bound before every request — so this one
  // preset trades an early, offline check here for one that can actually
  // reach the server it is checking, instead of failing save time on a
  // server that happens to be unreachable right now.
  if (context.preset === "llama-cpp") return;
  const encoding = promptBiasTokenizerEncoding(context.remoteModelId);
  const resolved = resolveSamplingLogitBiasForEncoding(profile.sampling, encoding);
  if (resolved.kind !== "resolved") {
    throw new SettingsFormatError(`profile ${profileId} could not resolve phrase bias or banned strings: ${samplingBiasResolutionFailureMessage(resolved)}`);
  }
  const rejected = firstRejectedEntry(resolved.phraseBias, resolved.bannedStrings);
  if (rejected !== undefined) {
    throw new SettingsFormatError(
      `profile ${profileId} cannot use ${JSON.stringify(rejected.phrase)} as configured: `
      + samplingBiasEntryRejectionMessage(rejected)
    );
  }
  const bound = maxResolvedLogitBiasEntries(context.preset);
  if (resolved.resolvedEntryCount > bound) {
    throw new SettingsFormatError(
      `profile ${profileId} resolves to ${resolved.resolvedEntryCount} logit-bias entries, `
      + `exceeding the ${bound}-entry limit for preset ${context.preset}`
    );
  }
}

function firstRejectedEntry(
  phraseBias: readonly SamplingBiasEntryResolution[],
  bannedStrings: readonly SamplingBiasEntryResolution[]
): Extract<SamplingBiasEntryResolution, { kind: "rejected" }> | undefined {
  for (const entry of [...phraseBias, ...bannedStrings]) {
    if (entry.kind === "rejected") return entry;
  }
  return undefined;
}

function samplingValidationMessage(
  profileId: string,
  knob: SamplingKnobV2,
  reason: SamplingUnavailableReason
): string {
  const details: Readonly<Record<SamplingUnavailableReason, string>> = {
    "legacy-v1": "for read-only format 1 settings",
    "dry-run": "for a dry-run connection",
    protocol: "for a protocol that does not document it",
    "preset-unsupported": "for a preset that does not document it",
    "preset-unknown": "for an endpoint with undocumented extension fields",
    "model-unsupported": "for a model that does not declare sampling support",
    "model-unknown": "for a model without a documented sampling contract",
    "no-exact-tokenizer": "for a model with no exact tokenizer to resolve text to token IDs",
    "reasoning-model": "for a reasoning model, which rejects logit bias"
  };
  return `profile ${profileId} sets ${samplingKnobLabel(knob)} ${details[reason]}`;
}
