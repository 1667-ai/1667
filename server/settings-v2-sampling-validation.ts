import {
  SAMPLING_KNOB_V2_ADDITIVE_VALUES,
  SAMPLING_KNOB_V2_REQUIRED_VALUES,
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type GenerationProfileV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import {
  isLogitBiasFamilyKnob,
  promptBiasTokenizerEncoding,
  resolveConfiguredSamplingKnobs,
  samplingContextForRoute,
  samplingKnobValueIsSet,
  samplingKnobLabel,
  samplingUnavailableReasonClause
} from "../shared/sampling-capabilities.js";
import type { SamplingUnavailableReason } from "../shared/sampling-capabilities.js";
import type { SelectedSettingsRouteV2 } from "../shared/settings-route.js";
import {
  maxResolvedLogitBiasEntries,
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingDryBreakers,
  validateSamplingLogitBias,
  validateSamplingPhraseBias,
  validateSamplingScalarOrNull,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "../shared/sampling-validation-policy.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import {
  firstBlockingSamplingBiasEntry,
  samplingBiasEntryRejectionMessage,
  type SamplingBiasResolutionResult
} from "../shared/sampling-capabilities.js";
import { combineSamplingBiasSources, resolveSamplingLogitBiasForEncoding } from "./sampling-phrase-bias.js";

// SAMPLING_KNOB_V2_ADDITIVE_VALUES are optional on the wire: a settings
// document written before issue #282 has a `sampling` object without them,
// and it must still decode. SAMPLING_KNOB_V2_REQUIRED_VALUES is their
// complement, derived once in shared/settings-v2-types.ts so this required
// list and the schema definition (scripts/settings-v2-schema-definition.ts)
// cannot drift apart (issue #282 review round 5, finding 4).
const SAMPLING = closedShape(
  SAMPLING_KNOB_V2_REQUIRED_VALUES,
  [...SAMPLING_KNOB_V2_ADDITIVE_VALUES]
);

export function parseSampling(value: unknown, label: string): SamplingSettingsV2 | undefined {
  if (value === undefined) return undefined;
  const sampling = closedRecord(value, label, SAMPLING);
  const parsed: SamplingSettingsV2 = samplingPolicy(() => ({
    ...Object.fromEntries(
      SAMPLING_SCALAR_KNOB_V2_VALUES.map((knob) => [
        knob,
        samplingScalarOrNull(knob, sampling[knob], `${label}.${knob}`)
      ])
    ),
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`),
    bannedStrings: validateSamplingBannedStrings(
      sampling.bannedStrings ?? [],
      `${label}.bannedStrings`
    ),
    phraseBias: validateSamplingPhraseBias(sampling.phraseBias ?? [], `${label}.phraseBias`),
    dryBreakers: validateSamplingDryBreakers(sampling.dryBreakers, `${label}.dryBreakers`)
  } as SamplingSettingsV2));
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

/**
 * Validates a profile's sampling route, including — whenever logitBias,
 * phraseBias, or bannedStrings is configured — that it resolves within the
 * preset-aware resolved-entry bound with no rejected or shadowed entry, so a
 * document that cannot serialize into a request never saves cleanly in the
 * first place (issue #282 review round 2, finding 6). "Shadowed" only ever
 * names a real weight conflict, never mere overlap (issue #282 review round
 * 3, finding 1) — two entries that agree on a shared token's weight both
 * stay "resolved" and neither blocks the save — so blocking on it here
 * matches the writer's expectation: a save never silently ships a weaker
 * request than the one they configured (finding 2). Checked unconditionally,
 * even when only the raw numeric logitBias map is set: a raw map alone can
 * still carry more entries than a preset (KoboldCpp) documents.
 *
 * `precomputedResolution`, when supplied, is used as-is instead of resolving
 * again here. This function is otherwise synchronous — every other caller
 * (document decode: server/settings-v2-codec.ts, server/settings-v2-state-
 * validation.ts, tui/src/api-response-decoders.ts) runs far more often than
 * a save and must never make a network call — so it falls back to a local,
 * synchronous resolution when nothing is supplied. That local fallback
 * cannot check "llama-cpp": its tokenizer is a live probe
 * (server/context-probe.ts, probeLlamaCppTokenize), not a local allow-list,
 * so those callers still skip the bias check for it, same as before. The
 * save path (server/settings-v2-store.ts) is async already, so it is the one
 * caller that resolves llama-cpp for real and supplies the result here —
 * one enforcement point for the whole logit-bias family, on every preset,
 * instead of a synchronous check for one preset and a bypass for another.
 *
 * A resolution that comes back "tokenizer-unavailable" never blocks the
 * save: an unreachable llama.cpp server is indistinguishable here from
 * "briefly offline", and request-time application
 * (server/provider-sampling.ts) re-verifies against the live server and
 * enforces the resolved-count bound before every request regardless.
 */
export function validateSamplingRoute(
  profileId: string,
  profile: GenerationProfileV2,
  model: ModelDefinitionV2,
  connection: ModelConnectionV2,
  precomputedResolution?: SamplingBiasResolutionResult
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
  if (context.protocol === "legacy-v1" || context.preset === "legacy-v1") return;
  if (!configured.some(({ knob }) => isLogitBiasFamilyKnob(knob))) return;
  const preset = context.preset;
  const resolved = precomputedResolution ?? (
    preset === "llama-cpp"
      ? undefined
      : resolveSamplingLogitBiasForEncoding(
          // No story is ever in play at settings-save time (issue #341
          // decision 1: story content must never reach a settings file) — every
          // entry below bottoms out scope "profile", so this stays the exact
          // resolution #282 already shipped.
          combineSamplingBiasSources(profile.sampling),
          promptBiasTokenizerEncoding(context.remoteModelId)
        )
  );
  if (resolved === undefined || resolved.kind !== "resolved") return;
  const blocking = firstBlockingSamplingBiasEntry(resolved.phraseBias, resolved.bannedStrings);
  if (blocking !== undefined) {
    throw new SettingsFormatError(
      `profile ${profileId} cannot use ${JSON.stringify(blocking.phrase)} as configured: `
      + samplingBiasEntryRejectionMessage(blocking)
    );
  }
  const bound = maxResolvedLogitBiasEntries(preset);
  if (resolved.resolvedEntryCount > bound) {
    throw new SettingsFormatError(
      `profile ${profileId} resolves to ${resolved.resolvedEntryCount} logit-bias entries, `
      + `exceeding the ${bound}-entry limit for preset ${preset}`
    );
  }
}

function samplingValidationMessage(
  profileId: string,
  knob: SamplingKnobV2,
  reason: SamplingUnavailableReason
): string {
  return `profile ${profileId} sets ${samplingKnobLabel(knob)} ${samplingUnavailableReasonClause(reason)}`;
}
