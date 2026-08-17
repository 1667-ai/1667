import { canonicalJson } from "../server/canonical-json.js";
import {
  type FeatureSupportV2,
  type ReasoningDisplayV2,
  type SamplingSettingsV2,
  type SettingsDocumentV2
} from "../shared/settings-v2-types.js";

/** Simulate a document saved before phrase and banned-string bias existed. */
export function legacyShapedSamplingDocumentText(document: SettingsDocumentV2): string {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  if (profile === undefined || profile.sampling === undefined) {
    throw new Error("Canonical settings are missing sampling on the default profile");
  }
  const { phraseBias: _phraseBias, bannedStrings: _bannedStrings, ...legacySampling } = profile.sampling;
  return canonicalJson({
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: { ...profile, sampling: legacySampling }
    }
  });
}

export function withDefaultModelId(modelId: string, document: SettingsDocumentV2): SettingsDocumentV2 {
  const defaultProfile = document.profiles.default;
  if (defaultProfile === undefined) {
    throw new Error("Canonical initial settings are missing the default profile");
  }
  return {
    ...document,
    profiles: {
      ...document.profiles,
      default: { ...defaultProfile, modelId }
    }
  };
}

export function withTokenProbabilities(
  document: SettingsDocumentV2,
  tokenProbabilities: number
): SettingsDocumentV2 {
  return withDefaultProfile(document, (profile) => ({ ...profile, tokenProbabilities }));
}

export function withContinuationPromptOptimization(
  document: SettingsDocumentV2,
  continuationPromptOptimization: "late-cache-stable"
): SettingsDocumentV2 {
  return withRawContinuationPromptOptimization(document, continuationPromptOptimization) as SettingsDocumentV2;
}

export function withRawContinuationPromptOptimization(
  document: SettingsDocumentV2,
  continuationPromptOptimization: unknown
): unknown {
  return withDefaultProfile(document, (profile) => ({ ...profile, continuationPromptOptimization }));
}

/** Declare what the default profile's model reports about thought content. */
export function withReasoningCapability(
  document: SettingsDocumentV2,
  reasoningContent: FeatureSupportV2 = "supported"
): SettingsDocumentV2 {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  const model = profile === undefined ? undefined : document.models[profile.modelId];
  if (profile === undefined || model === undefined) {
    throw new Error("Canonical settings are missing the default profile's model");
  }
  return {
    ...document,
    models: {
      ...document.models,
      [profile.modelId]: {
        ...model,
        capabilities: { ...model.capabilities, reasoningContent }
      }
    }
  };
}

export function withReasoning(
  document: SettingsDocumentV2,
  reasoning: ReasoningDisplayV2,
  discardReasoning?: true
): SettingsDocumentV2 {
  return withDefaultProfile(document, (profile) => ({
    ...profile,
    reasoning,
    ...(discardReasoning === undefined ? {} : { discardReasoning })
  }));
}

/** Accept an invalid raw value for corpus cases that test parser rejection. */
export function withRawReasoning(document: SettingsDocumentV2, reasoning: unknown): unknown {
  return withDefaultProfile(document, (profile) => ({ ...profile, reasoning }));
}

export function withKnownTokenizerModel(document: SettingsDocumentV2): SettingsDocumentV2 {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  const model = profile === undefined ? undefined : document.models[profile.modelId];
  if (profile === undefined || model === undefined) {
    throw new Error("Canonical settings are missing the default profile's model");
  }
  return {
    ...document,
    models: {
      ...document.models,
      [profile.modelId]: { ...model, remoteId: "gpt-4o" }
    }
  };
}

export function withSampling(
  document: SettingsDocumentV2,
  sampling: SamplingSettingsV2
): SettingsDocumentV2 {
  return withDefaultProfile(document, (profile) => ({ ...profile, sampling }));
}

/** Accept an invalid raw shape for corpus cases that test parser rejection. */
export function withRawSampling(document: SettingsDocumentV2, sampling: unknown): unknown {
  return withDefaultProfile(document, (profile) => ({ ...profile, sampling }));
}

function withDefaultProfile(
  document: SettingsDocumentV2,
  update: (profile: SettingsDocumentV2["profiles"][string]) => unknown
): SettingsDocumentV2 {
  const profileId = document.routing.default;
  const profile = document.profiles[profileId];
  if (profile === undefined) throw new Error("Canonical settings are missing the default profile");
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: update(profile)
    }
  } as SettingsDocumentV2;
}
