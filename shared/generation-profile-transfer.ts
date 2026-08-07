import {
  EMPTY_SAMPLING_V2,
  SAMPLING_KNOB_V2_VALUES,
  type GenerationEffortV2,
  type GenerationProfileV2,
  type PromptCachePolicyV2,
  type SamplingKnobV2,
  type SamplingSettingsV2,
  type SettingsDocumentV2
} from "./settings-v2-types.js";
import { resolveSettingsProfile, type SelectedSettingsRouteV2 } from "./settings-route.js";
import {
  clampMaxOutputTokensToModel,
  type ModelScalarMetadataSourcesV2
} from "./model-scalar-resolution.js";
import {
  applySamplingSettings,
  isLogitBiasFamilyKnob,
  resolveSamplingKnob,
  samplingBiasPresetRules,
  samplingBiasEntryRejectionMessage,
  samplingBiasNativeBlockedMessage,
  samplingContextForRoute,
  samplingKnobLabel,
  samplingKnobValueIsSet,
  samplingUnavailableReasonCompact,
  SAMPLING_BIAS_VARIANT_VALUES,
  type SamplingBiasResolutionResult
} from "./sampling-capabilities.js";
import {
  maxResolvedLogitBiasEntries,
  nativeBannedStringsLimit,
  rawLogitBiasLimit,
  SAMPLING_SCALAR_DESCRIPTORS
} from "./sampling-validation-policy.js";
import { generationEffortAvailabilityForRoute } from "./generation-effort-capabilities.js";
import {
  promptCacheContextForRoute,
  promptCachePolicyPresentation
} from "./prompt-cache-capabilities.js";
import {
  resolveTokenProbabilities,
  tokenProbabilityUnavailableReasonCompact
} from "./token-probability-capabilities.js";

/** A protocol-neutral set of generation behavior that can move between routes. */
export interface ProfileTransferCandidate {
  readonly name: string;
  readonly temperature?: number | null;
  readonly maxOutputTokens?: number;
  readonly effort?: GenerationEffortV2;
  readonly cachePolicy?: PromptCachePolicyV2;
  /** Alternative tokens per generated token; null means off. */
  readonly tokenProbabilities?: number | null;
  readonly sampling?: Partial<SamplingSettingsV2>;
  /** Active source parameters that had no transferable candidate value. */
  readonly omittedCount?: number;
  readonly fidelity?: readonly string[];
}

export interface FittedProfileTransfer {
  readonly document: SettingsDocumentV2;
  readonly profileId: string;
  readonly importedCount: number;
  readonly candidateCount: number;
  readonly fidelity: readonly string[];
}

/** Optional model metadata supplied by an import path that owns it. */
export interface ProfileTransferFitOptions {
  readonly modelMetadata?: ModelScalarMetadataSourcesV2;
  /** A canonical resolution of the offered text-bias settings, when the caller owns it. */
  readonly samplingBiasResolution?: SamplingBiasResolutionResult;
}

/** Apply a candidate to an already-created profile. The route owns capability filtering. */
export function fitProfileToRoute(
  document: SettingsDocumentV2,
  profileId: string,
  candidate: ProfileTransferCandidate,
  options: ProfileTransferFitOptions = {}
): FittedProfileTransfer {
  const route = resolveSettingsProfile(document, profileId);
  const fidelity = [...(candidate.fidelity ?? [])];
  const samplingFit = fitSamplingToRoute(
    route,
    candidate.sampling,
    fidelity,
    options.samplingBiasResolution
  );
  let importedCount = samplingFit.importedCount;
  let candidateCount = (candidate.omittedCount ?? 0) + samplingFit.candidateCount;
  const countCandidate = (): void => { candidateCount += 1; };

  const profile = route.profile;
  const acceptsTemperature = route.model.capabilities.temperature !== "unsupported";
  const importsTemperature = candidate.temperature !== undefined
    && (candidate.temperature === null || acceptsTemperature);
  const importsMaxOutputTokens = candidate.maxOutputTokens !== undefined;
  const fittedMaxOutputTokens = candidate.maxOutputTokens === undefined
    ? null
    : fitMaximumOutputTokens(candidate.maxOutputTokens, route, fidelity, options.modelMetadata);
  const effortAvailability = candidate.effort === undefined
    ? null
    : generationEffortAvailabilityForRoute(route, candidate.effort);
  const importsEffort = effortAvailability?.kind === "available";
  const cachePolicyPresentation = candidate.cachePolicy === undefined
    ? null
    : promptCachePolicyPresentation(
      promptCacheContextForRoute(route),
      candidate.cachePolicy
    );
  const importsCachePolicy = candidate.cachePolicy !== undefined
    && (candidate.cachePolicy === "off" || cachePolicyPresentation!.available);
  const tokenProbabilityResolution = resolveTokenProbabilities(samplingContextForRoute(route));
  const importsTokenProbabilities = candidate.tokenProbabilities !== undefined
    && (candidate.tokenProbabilities === null || tokenProbabilityResolution.kind === "available");
  if (candidate.temperature !== undefined) countCandidate();
  if (candidate.maxOutputTokens !== undefined) countCandidate();
  if (candidate.effort !== undefined) countCandidate();
  if (candidate.cachePolicy !== undefined) countCandidate();
  if (candidate.tokenProbabilities !== undefined) countCandidate();
  if (candidate.temperature !== undefined && !importsTemperature) {
    fidelity.push("temperature not imported; model does not support temperature");
  }
  if (candidate.effort !== undefined && !importsEffort) {
    const unavailableEffort = effortAvailability!;
    if (unavailableEffort.kind === "unavailable") {
      fidelity.push(`reasoning effort not imported; ${unavailableEffort.reason}`);
    }
  }
  if (candidate.cachePolicy !== undefined && !importsCachePolicy) {
    const unavailableCachePolicy = cachePolicyPresentation!;
    if (!unavailableCachePolicy.available) {
      fidelity.push(`cache policy not imported; ${unavailableCachePolicy.unavailableReasonCompact}`);
    }
  }
  if (candidate.tokenProbabilities !== undefined
    && candidate.tokenProbabilities !== null
    && tokenProbabilityResolution.kind === "unavailable") {
    fidelity.push(`token probabilities not imported; ${tokenProbabilityUnavailableReasonCompact(tokenProbabilityResolution.reason)}`);
  }
  importedCount += Number(importsTemperature) + Number(importsMaxOutputTokens)
    + Number(importsEffort) + Number(importsCachePolicy) + Number(importsTokenProbabilities);
  const clearsTokenProbabilities = candidate.tokenProbabilities === null
    || (candidate.tokenProbabilities !== undefined && !importsTokenProbabilities);
  const profileWithTokenProbabilities = clearsTokenProbabilities
    ? withoutTokenProbabilities(profile)
    : profile;
  const { sampling: _sourceSampling, ...nextProfile } = profileWithTokenProbabilities;
  const documentWithProfile = {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: {
        ...nextProfile,
        name: candidate.name,
        ...(importsTemperature ? {
          temperature: clamp(candidate.temperature!, -100, 100, "temperature", fidelity)
        } : {}),
        ...(importsMaxOutputTokens ? {
          maxOutputTokens: fittedMaxOutputTokens!
        } : {}),
        ...(importsEffort ? { effort: candidate.effort! } : {}),
        ...(importsCachePolicy ? { cachePolicy: candidate.cachePolicy! } : {}),
        ...(candidate.tokenProbabilities !== undefined
          && candidate.tokenProbabilities !== null
          && importsTokenProbabilities
          ? { tokenProbabilities: candidate.tokenProbabilities }
          : {})
      }
    }
  };
  return {
    document: applySamplingSettings(documentWithProfile, samplingFit.sampling, profileId),
    profileId,
    importedCount,
    candidateCount,
    fidelity
  };
}

interface SamplingFit {
  readonly sampling: SamplingSettingsV2;
  readonly importedCount: number;
  readonly candidateCount: number;
}

type SamplingFitOperation =
  | Readonly<{ kind: "accept"; sampling: SamplingSettingsV2 }>
  | Readonly<{ kind: "omit" }>;

function fitSamplingToRoute(
  route: SelectedSettingsRouteV2,
  offered: Partial<SamplingSettingsV2> | undefined,
  fidelity: string[],
  precomputedResolution: SamplingBiasResolutionResult | undefined
): SamplingFit {
  const values: SamplingSettingsV2 = { ...EMPTY_SAMPLING_V2, ...(offered ?? {}) };
  // Mirostat's child knobs resolve against its mode in the candidate.
  const dependencySampling = offered?.mirostat === undefined
    ? EMPTY_SAMPLING_V2
    : withSamplingValue(EMPTY_SAMPLING_V2, "mirostat", offered.mirostat);
  let sampling = EMPTY_SAMPLING_V2;
  let importedCount = 0;
  let candidateCount = 0;
  let resolutionStillMatches = true;
  for (const knob of SAMPLING_KNOB_V2_VALUES) {
    const value = offered?.[knob];
    if (value === undefined || !samplingKnobValueIsSet(values, knob)) continue;
    candidateCount += 1;
    const operation = fitSamplingKnob(route, dependencySampling, sampling, knob, value, fidelity);
    if (operation.kind === "omit") {
      if (isLogitBiasFamilyKnob(knob)) resolutionStillMatches = false;
      continue;
    }
    if (isLogitBiasFamilyKnob(knob) && operation.sampling[knob] !== value) {
      resolutionStillMatches = false;
    }
    sampling = operation.sampling;
    importedCount += 1;
  }
  const matchingResolution = resolutionStillMatches ? precomputedResolution : undefined;
  const withoutBlocking = omitBlockedTextBias(
    sampling,
    importedCount,
    candidateCount,
    fidelity,
    matchingResolution
  );
  return omitOverLimitTextBias(
    route,
    withoutBlocking.sampling,
    withoutBlocking.importedCount,
    withoutBlocking.candidateCount,
    fidelity,
    withoutBlocking.omitted ? undefined : matchingResolution,
    withoutBlocking.retainedResolvedEntryCount
  );
}

interface BlockingTextBiasFit extends SamplingFit {
  readonly omitted: boolean;
  readonly retainedResolvedEntryCount?: number;
}

/** A supplied canonical result can name text values the target route rejects. */
function omitBlockedTextBias(
  sampling: SamplingSettingsV2,
  importedCount: number,
  candidateCount: number,
  fidelity: string[],
  precomputedResolution: SamplingBiasResolutionResult | undefined
): BlockingTextBiasFit {
  if (precomputedResolution?.kind !== "resolved") {
    return { sampling, importedCount, candidateCount, omitted: false };
  }
  const phraseBias = sampling.phraseBias.filter((_entry, index) => {
    const resolution = precomputedResolution.phraseBias[index];
    return resolution?.kind !== "rejected" && resolution?.kind !== "shadowed";
  });
  const bannedStrings = sampling.bannedStrings.filter((_entry, index) => {
    const resolution = precomputedResolution.bannedStrings[index];
    const nativeResolution = precomputedResolution.nativeBannedStrings[index];
    return resolution?.kind !== "rejected"
      && resolution?.kind !== "shadowed"
      && nativeResolution?.kind !== "blocked";
  });
  const omittedPhrase = phraseBias.length !== sampling.phraseBias.length;
  const omittedBanned = bannedStrings.length !== sampling.bannedStrings.length;
  if (!omittedPhrase && !omittedBanned) {
    return { sampling, importedCount, candidateCount, omitted: false };
  }
  const phraseBiasLabel = phraseBias.length === 0 ? "phrase bias" : "phrase bias entry";
  const bannedStringsLabel = bannedStrings.length === 0 ? "banned strings" : "banned string";

  for (const [index, resolution] of precomputedResolution.phraseBias.entries()) {
    if (index >= sampling.phraseBias.length) break;
    if (resolution.kind === "rejected" || resolution.kind === "shadowed") {
      fidelity.push(`${phraseBiasLabel} not imported; ${samplingBiasEntryRejectionMessage(resolution)}`);
    }
  }
  for (const [index, resolution] of precomputedResolution.bannedStrings.entries()) {
    if (index >= sampling.bannedStrings.length) break;
    if (resolution.kind === "rejected" || resolution.kind === "shadowed") {
      fidelity.push(`${bannedStringsLabel} not imported; ${samplingBiasEntryRejectionMessage(resolution)}`);
    }
  }
  for (const [index, resolution] of precomputedResolution.nativeBannedStrings.entries()) {
    if (index >= sampling.bannedStrings.length) break;
    if (resolution.kind === "blocked") {
      fidelity.push(`${bannedStringsLabel} not imported; ${samplingBiasNativeBlockedMessage(resolution)}`);
    }
  }
  const fittedSampling = { ...sampling, phraseBias, bannedStrings };
  return {
    sampling: fittedSampling,
    importedCount: importedCount
      - Number(omittedPhrase && !samplingKnobValueIsSet(fittedSampling, "phraseBias"))
      - Number(omittedBanned && !samplingKnobValueIsSet(fittedSampling, "bannedStrings")),
    candidateCount,
    omitted: true,
    retainedResolvedEntryCount: retainedResolvedEntryCount(sampling, precomputedResolution)
  };
}

/** The supplied resolution starts with this profile's entries. Reuse their
 * exact token IDs after filtering, rather than re-tokenizing or using a bound. */
function retainedResolvedEntryCount(
  sampling: SamplingSettingsV2,
  resolution: Extract<SamplingBiasResolutionResult, { readonly kind: "resolved" }>
): number {
  const tokenIds = new Set(Object.keys(sampling.logitBias).map(Number));
  for (const [index, entry] of resolution.phraseBias.entries()) {
    if (index >= sampling.phraseBias.length) break;
    if (entry.kind === "resolved" || entry.kind === "overridden") {
      for (const tokenId of entry.tokenIds) tokenIds.add(tokenId);
    }
  }
  // KoboldCpp's native banned strings are intentionally absent from this
  // resolution array and from logit_bias, so they cannot consume this limit.
  for (const [index, entry] of resolution.bannedStrings.entries()) {
    if (index >= sampling.bannedStrings.length) break;
    if (entry.kind === "resolved" || entry.kind === "overridden") {
      for (const tokenId of entry.tokenIds) tokenIds.add(tokenId);
    }
  }
  return tokenIds.size;
}

/**
 * Text bias resolves into the same provider `logit_bias` object as raw IDs.
 * Use a caller-owned canonical result when available. Otherwise the shared
 * variant list gives a conservative ceiling without adding a tokenizer here.
 */
function omitOverLimitTextBias(
  route: SelectedSettingsRouteV2,
  sampling: SamplingSettingsV2,
  importedCount: number,
  candidateCount: number,
  fidelity: string[],
  precomputedResolution: SamplingBiasResolutionResult | undefined,
  retainedResolvedEntryCount: number | undefined
): SamplingFit {
  const configured = (["phraseBias", "bannedStrings"] as const).filter((knob) =>
    samplingKnobValueIsSet(sampling, knob)
  );
  if (configured.length === 0) return { sampling, importedCount, candidateCount };

  const preset = route.connection.preset;
  const rules = samplingBiasPresetRules(preset);
  // KoboldCpp sends literal banned strings in `banned_tokens`, not the
  // bounded `logit_bias` object. Keep an accepted native list if phrase bias
  // is the only value that exceeds the separate resolved-token limit.
  const bounded = configured.filter((knob) =>
    knob === "phraseBias" || rules.bannedStringsTransport !== "native"
  );
  if (bounded.length === 0) return { sampling, importedCount, candidateCount };
  const limit = maxResolvedLogitBiasEntries(preset);
  const resolvedEntries = retainedResolvedEntryCount
    ?? (precomputedResolution?.kind === "resolved"
      ? precomputedResolution.resolvedEntryCount
      : undefined);
  const possibleEntries = resolvedEntries ?? maximumTextBiasEntries(sampling, preset);
  if (possibleEntries <= limit) return { sampling, importedCount, candidateCount };

  const names = bounded.map((knob) => samplingKnobLabel(knob)).join(" and ");
  fidelity.push(
    resolvedEntries === undefined
      ? `${names} not imported; up to ${possibleEntries} logit-bias entries can resolve, exceeding the ${limit}-entry limit for preset ${preset}`
      : `${names} not imported; ${resolvedEntries} resolved logit-bias entries exceed the ${limit}-entry limit for preset ${preset}`
  );
  return {
    sampling: {
      ...sampling,
      phraseBias: EMPTY_SAMPLING_V2.phraseBias,
      ...(bounded.includes("bannedStrings") ? { bannedStrings: EMPTY_SAMPLING_V2.bannedStrings } : {})
    },
    importedCount: importedCount - bounded.length,
    candidateCount
  };
}

function maximumTextBiasEntries(
  sampling: SamplingSettingsV2,
  preset: SelectedSettingsRouteV2["connection"]["preset"]
): number {
  const textVariants = SAMPLING_BIAS_VARIANT_VALUES.length;
  const bannedStrings = samplingBiasPresetRules(preset).bannedStringsTransport === "native"
    ? 0
    : sampling.bannedStrings.length * textVariants;
  return Object.keys(sampling.logitBias).length + sampling.phraseBias.length * textVariants + bannedStrings;
}

function fitSamplingKnob(
  route: SelectedSettingsRouteV2,
  dependencySampling: SamplingSettingsV2,
  sampling: SamplingSettingsV2,
  knob: SamplingKnobV2,
  value: SamplingSettingsV2[SamplingKnobV2],
  fidelity: string[]
): SamplingFitOperation {
  const clamped = clampSamplingValue(knob, value, fidelity);
  if (clamped === null) return { kind: "omit" };
  const nextSampling = withSamplingValue(sampling, knob, clamped);
  if (knob === "logitBias") {
    const logitBias = rawLogitBiasLimit(nextSampling.logitBias, route.connection.preset);
    if (logitBias.exceeds) {
      fidelity.push(`logit bias not imported; ${logitBias.entries} entries exceed the ${logitBias.limit}-entry limit for preset ${route.connection.preset}`);
      return { kind: "omit" };
    }
  }
  if (knob === "bannedStrings") {
    const bannedStrings = nativeBannedStringsLimit(nextSampling.bannedStrings, route.connection.preset);
    if (bannedStrings.exceeds) {
      fidelity.push(`banned strings not imported; ${bannedStrings.entries} entries exceed the ${bannedStrings.limit}-entry native banned-string limit for preset ${route.connection.preset}`);
      return { kind: "omit" };
    }
  }
  const resolution = resolveSamplingKnob(
    samplingContextForRoute(route),
    dependencySampling,
    knob
  );
  if (resolution.kind === "unavailable" && resolution.reason !== "mirostat-off") {
    fidelity.push(`${samplingKnobLabel(knob)} not imported; ${samplingUnavailableReasonCompact(resolution.reason)}`);
    return { kind: "omit" };
  }
  return { kind: "accept", sampling: nextSampling };
}

function withSamplingValue(
  sampling: SamplingSettingsV2,
  knob: SamplingKnobV2,
  value: SamplingSettingsV2[SamplingKnobV2]
): SamplingSettingsV2 {
  return { ...sampling, [knob]: value };
}

function withoutTokenProbabilities(profile: GenerationProfileV2) {
  const { tokenProbabilities: _tokenProbabilities, ...withoutTokenProbabilities } = profile;
  return withoutTokenProbabilities;
}

function fitMaximumOutputTokens(
  value: number,
  route: SelectedSettingsRouteV2,
  fidelity: string[],
  metadata: ModelScalarMetadataSourcesV2 | undefined
): number {
  const schemaBounded = clampInteger(value, 1, 1_000_000_000, "maximum output", fidelity);
  const modelBounded = clampMaxOutputTokensToModel(schemaBounded, route.model, metadata);
  if (modelBounded !== schemaBounded) {
    fidelity.push(`maximum output clamped to ${modelBounded}`);
  }
  return modelBounded;
}

function clampSamplingValue(
  knob: SamplingKnobV2,
  value: SamplingSettingsV2[SamplingKnobV2],
  fidelity: string[]
): SamplingSettingsV2[SamplingKnobV2] | null {
  const descriptor = isSamplingScalarKnob(knob) ? SAMPLING_SCALAR_DESCRIPTORS[knob] : undefined;
  if (descriptor === undefined) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fidelity.push(`${samplingKnobLabel(knob)} not imported; it is not a finite number`);
    return null;
  }
  const next = descriptor.integer ? Math.round(value) : value;
  const clamped = Math.max(descriptor.minimum, Math.min(descriptor.maximum, next));
  if (clamped !== value) fidelity.push(`${samplingKnobLabel(knob)} clamped to ${clamped}`);
  return clamped;
}

function isSamplingScalarKnob(knob: SamplingKnobV2): knob is keyof typeof SAMPLING_SCALAR_DESCRIPTORS {
  return Object.hasOwn(SAMPLING_SCALAR_DESCRIPTORS, knob);
}

function clamp(value: number | null, minimum: number, maximum: number, label: string, fidelity: string[]): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    fidelity.push(`${label} not imported; it is not a finite number`);
    return null;
  }
  const next = Math.max(minimum, Math.min(maximum, value));
  if (next !== value) fidelity.push(`${label} clamped to ${next}`);
  return next;
}

function clampInteger(value: number, minimum: number, maximum: number, label: string, fidelity: string[]): number {
  const rounded = Math.round(value);
  const next = Math.max(minimum, Math.min(maximum, rounded));
  if (next !== value) fidelity.push(`${label} clamped to ${next}`);
  return next;
}
