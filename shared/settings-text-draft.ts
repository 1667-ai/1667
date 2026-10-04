import {
  EMPTY_SAMPLING_V2,
  type FeatureSupportV2,
  type SamplingSettingsV2,
  type PromptCachePolicyV2,
  type ModelConnectionV2,
  type SettingsView
} from "./settings-v2-types.js";
import type { SettingsDocumentV5 as SettingsDocumentV2 } from "./settings-v5-types.js";
import { updateSettingsDocumentV5 } from "./settings-document-update.js";
import type {
  GenerationSettings,
  Provider
} from "./types.js";
import {
  applyBasicSettingsProbeDraft,
  basicSettingsConnectionName,
  basicSettingsPresetAfterIdentityChange,
  basicSettingsPresetFor,
  basicSettingsForDisplay,
  basicSettingsFromDocument,
  subscriptionConnectionName
} from "./settings-basic-draft.js";
import {
  defaultConnectionTimeouts,
  defaultModelCapabilitiesV3
} from "./settings-provider-defaults.js";
import {
  subscriptionProtocolForPresetV2
} from "./settings-v2-types.js";
import {
  applyPromptCachePolicy,
  promptCacheContextForProfile
} from "./prompt-cache-capabilities.js";
import {
  isolateSettingsProfileConnection,
  isolateSettingsProfileModel,
  prepareSettingsProfileGenerationEdit,
  selectedSettingsProfileId
} from "./settings-profile-draft.js";
import { fitProfileToRoute } from "./generation-profile-transfer.js";
import { resolveSettingsProfile } from "./settings-route.js";
import { storedCredentialSecretId } from "./settings-stored-credential.js";

export interface SettingsTextDraft {
  /** Full editable document plus the selected profile's form projection.
   * Dry-run retains endpoint text that its document shape cannot represent;
   * save normalizes that inactive text away. */
  readonly document: SettingsDocumentV2 | null;
  readonly selectedProfileId: string | null;
  readonly generation: GenerationSettings;
  readonly cachePolicy: PromptCachePolicyV2;
  readonly sampling: SamplingSettingsV2;
}

export function settingsTextDraftForView(
  view: SettingsView,
  selectedProfileId?: string | null
): SettingsTextDraft {
  if (view.editable) {
    return settingsTextDraftForDocument(view.document, selectedProfileId);
  }
  return {
    document: null,
    selectedProfileId: null,
    generation: basicSettingsForDisplay(view),
    cachePolicy: "off",
    sampling: EMPTY_SAMPLING_V2
  };
}

export function settingsTextDraftForDocument(
  document: SettingsDocumentV2,
  preferredProfileId: string | null | undefined
): SettingsTextDraft {
  const selectedProfileId = selectedSettingsProfileId(document, preferredProfileId);
  const route = resolveSettingsProfile(document, selectedProfileId);
  return {
    document,
    selectedProfileId,
    generation: basicSettingsFromDocument(document, selectedProfileId),
    cachePolicy: promptCacheContextForProfile(document, selectedProfileId).policy,
    sampling: route.profile.sampling ?? EMPTY_SAMPLING_V2
  };
}

export function settingsTextDraftWithGeneration(
  draft: SettingsTextDraft,
  generation: GenerationSettings,
  retainContextWindowOverride = false
): SettingsTextDraft {
  if (draft.document === null || draft.selectedProfileId === null) {
    return { ...draft, generation };
  }
  const document = prepareSettingsProfileGenerationEdit(
    draft.document,
    draft.selectedProfileId,
    draft.generation,
    generation
  );
  const projected = settingsTextDraftForDocument(
    applySettingsGenerationDraft(
      document,
      generation,
      draft.selectedProfileId,
      retainContextWindowOverride
    ),
    draft.selectedProfileId
  );
  if (generation.provider !== "dry-run") return projected;
  return {
    ...projected,
    generation: {
      ...projected.generation,
      baseUrl: generation.baseUrl.trim().replace(/\/+$/u, ""),
      apiKeyEnv: generation.apiKeyEnv
    }
  };
}

/** Select one of the fixed subscription routes. The form keeps the legacy
 * GenerationSettings projection for shared controls, while this helper writes
 * the protocol-owned connection shape that the settings validator requires. */
export function settingsTextDraftWithSubscriptionPlan(
  draft: SettingsTextDraft,
  preset: "chatgpt-plan" | "claude-plan",
  generation: GenerationSettings
): SettingsTextDraft {
  const document = draft.document;
  const profileId = draft.selectedProfileId;
  if (document === null || profileId === null) return { ...draft, generation };
  const isolatedDocument = isolateSettingsProfileConnection(
    prepareSettingsProfileGenerationEdit(
      document,
      profileId,
      draft.generation,
      generation
    ),
    profileId
  );
  const route = resolveSettingsProfile(isolatedDocument, profileId);
  const protocol = subscriptionProtocolForPresetV2(preset);
  const modelId = generation.model.trim();
  const {
    allowInsecureHttp: _allowInsecureHttp,
    textPromptFormat: _textPromptFormat,
    splitThinkTags: _splitThinkTags,
    ...portableConnection
  } = route.connection;
  const connection: ModelConnectionV2 = {
    ...portableConnection,
    name: subscriptionConnectionName(preset),
    preset,
    protocol,
    baseUrl: null,
    auth: { type: "none" },
    headers: [],
    timeouts: route.connection.protocol === protocol
      ? route.connection.timeouts
      : defaultConnectionTimeouts(generation.provider)
  };
  const model = {
    ...route.model,
    remoteId: modelId,
    name: modelId,
    discovered: {},
    overrides: generation.contextWindow === null
      ? {}
      : { contextWindow: generation.contextWindow },
    capabilities: {
      ...defaultModelCapabilitiesV3(generation.provider),
      reasoningEffort: "supported" as const
    }
  };
  const {
    sampling: _sourceSampling,
    tokenProbabilities: _sourceTokenProbabilities,
    ...profileWithoutTransferFields
  } = route.profile;
  const planProfile: typeof route.profile = {
    ...profileWithoutTransferFields,
    generationReasoning: { kind: "legacy", effort: "default" },
    cachePolicy: "off",
    temperature: generation.temperature,
    maxOutputTokens: generation.maxTokens
  };
  const planDocument = updateSettingsDocumentV5(isolatedDocument, {
    connections: {
      ...isolatedDocument.connections,
      [route.model.connectionId]: connection
    },
    models: {
      ...isolatedDocument.models,
      [route.profile.modelId]: model
    },
    profiles: {
      ...isolatedDocument.profiles,
      [profileId]: planProfile
    },
    writing: {
      ...isolatedDocument.writing,
      defaultAuthorBrief: generation.systemPrompt
    }
  });
  // Re-fit every transferable profile value against the subscription route.
  // The baseline above leaves unsupported effort, cache, token-probability,
  // and sampling values out; the fitter restores only values the new route
  // can use. Temperature and output length stay owned by this draft.
  const fitted = fitProfileToRoute(planDocument as never, profileId, {
    name: route.profile.name,
    temperature: planProfile.temperature,
    maxOutputTokens: planProfile.maxOutputTokens,
    effort: route.profile.generationReasoning.effort as never,
    reasoning: route.profile.generationReasoning,
    cachePolicy: route.profile.cachePolicy,
    sampling: route.profile.sampling,
    ...(route.profile.tokenProbabilities === undefined
      ? {}
      : { tokenProbabilities: route.profile.tokenProbabilities }),
    ...(route.profile.continuationPromptOptimization === undefined
      ? {}
      : { continuationPromptOptimization: route.profile.continuationPromptOptimization })
  });
  return settingsTextDraftForDocument(fitted.document as never, profileId);
}

export function settingsTextDraftWithCachePolicy(
  draft: SettingsTextDraft,
  cachePolicy: PromptCachePolicyV2
): SettingsTextDraft {
  if (draft.document === null || draft.selectedProfileId === null) {
    return { ...draft, cachePolicy };
  }
  return settingsTextDraftForDocument(
    applyPromptCachePolicy(draft.document as unknown as never, cachePolicy, draft.selectedProfileId) as unknown as SettingsDocumentV2,
    draft.selectedProfileId
  );
}

/** Apply the explicit native text adapter selected in the provider picker. */
export function settingsTextDraftWithTextPreset(
  draft: SettingsTextDraft,
  preset: "custom" | "llama-cpp" | "koboldcpp"
): SettingsTextDraft {
  const document = draft.document;
  const profileId = draft.selectedProfileId;
  if (document === null || profileId === null) return draft;
  const route = resolveSettingsProfile(document, profileId);
  if (route.connection.protocol !== "text-completions") return draft;
  const textPromptFormat = route.connection.textPromptFormat === "server-template"
    && preset !== "llama-cpp"
    ? "raw"
    : route.connection.textPromptFormat ?? "raw";
  return settingsTextDraftForDocument({
    ...document,
    connections: {
      ...document.connections,
      [route.model.connectionId]: {
        ...route.connection,
        name: basicSettingsConnectionName(preset),
        preset,
        textPromptFormat
      }
    }
  }, profileId);
}

/** Apply an explicit context probe after the provider/model identity has
 * reached the document. This keeps an equal numeric limit from being mistaken
 * for stale metadata that must reset with the old model identity. */
export function settingsTextDraftWithDetectedContext(
  draft: SettingsTextDraft,
  contextWindow: number
): SettingsTextDraft {
  const document = draft.document;
  const profileId = draft.selectedProfileId;
  if (document === null || profileId === null) {
    return {
      ...draft,
      generation: { ...draft.generation, contextWindow }
    };
  }
  const isolated = isolateSettingsProfileModel(document, profileId);
  const route = resolveSettingsProfile(isolated, profileId);
  const overrides = { ...route.model.overrides };
  delete overrides.contextWindow;
  return settingsTextDraftForDocument({
    ...isolated,
    models: {
      ...isolated.models,
      [route.profile.modelId]: {
        ...route.model,
        discovered: { ...route.model.discovered, contextWindow },
        overrides
      }
    }
  }, profileId);
}

/** Identify only form values that the selected document cannot project. This
 * keeps a profile switch clean while an inactive dry-run endpoint stays dirty. */
export function settingsTextDraftProjectionIdentity(
  draft: SettingsTextDraft
): string {
  if (draft.document === null || draft.selectedProfileId === null) return "[]";
  const current = draft.generation;
  const projected = basicSettingsFromDocument(draft.document, draft.selectedProfileId);
  const difference = <T>(left: T, right: T): readonly [false] | readonly [true, T] =>
    Object.is(left, right) ? [false] : [true, left];
  return JSON.stringify([
    difference(current.provider, projected.provider),
    difference(current.baseUrl, projected.baseUrl),
    difference(current.model, projected.model),
    difference(current.apiKeyEnv, projected.apiKeyEnv),
    difference(current.allowInsecureHttp === true, projected.allowInsecureHttp === true),
    difference(current.temperature, projected.temperature),
    difference(current.maxTokens, projected.maxTokens),
    difference(current.contextWindow, projected.contextWindow),
    difference(current.systemPrompt, projected.systemPrompt)
  ]);
}

/** The document stays authoritative while a writer is between fields. The
 * shared reducer intentionally refuses an incomplete network configuration;
 * this editor must retain it long enough for the next row edit to complete it.
 * Save remains the validation boundary. */
function applySettingsGenerationDraft(
  document: SettingsDocumentV2,
  generation: GenerationSettings,
  profileId: string,
  retainContextWindowOverride = false
): SettingsDocumentV2 {
  try {
    return applyBasicSettingsProbeDraft(
      document,
      generation,
      profileId,
      retainContextWindowOverride
    ) as SettingsDocumentV2;
  } catch {
    return applyIncompleteGenerationDraft(document, generation, profileId);
  }
}

function applyIncompleteGenerationDraft(
  document: SettingsDocumentV2,
  generation: GenerationSettings,
  profileId: string
): SettingsDocumentV2 {
  const route = resolveSettingsProfile(document, profileId);
  const provider = generation.provider;
  const protocol = provider === "dry-run"
    ? "dry-run"
    : provider === "anthropic"
      ? "anthropic-messages"
      : provider === "text-completion"
        ? "text-completions"
        : "openai-chat-completions";
  const baseUrl = provider === "dry-run"
    ? null
    : generation.baseUrl.trim().replace(/\/+$/u, "");
  const existingSecretId = storedCredentialSecretId(route.connection.auth);
  const auth = incompleteDraftAuth(provider, generation.apiKeyEnv, existingSecretId);
  const modelId = provider === "dry-run" && generation.model.trim().length === 0
    ? "dry-run"
    : generation.model.trim();
  const protocolChanged = route.connection.protocol !== protocol;
  const inferredPreset = incompletePreset(provider, baseUrl);
  const preset = basicSettingsPresetAfterIdentityChange(
    route.connection.preset,
    protocol,
    protocolChanged,
    inferredPreset
  );
  const modelChanged = route.model.remoteId !== modelId || protocolChanged || route.connection.baseUrl !== baseUrl;
  const overrides = { ...route.model.overrides };
  if (generation.contextWindow === null) delete overrides.contextWindow;
  else overrides.contextWindow = generation.contextWindow;
  const {
    allowInsecureHttp: _currentAllowInsecureHttp,
    textPromptFormat: currentTextPromptFormat,
    ...connectionBase
  } = route.connection;
  return updateSettingsDocumentV5(document, {
    connections: {
      ...document.connections,
      [route.model.connectionId]: {
        ...connectionBase,
        name: provider === "dry-run" ? "Dry Run" : "Custom",
        preset,
        protocol,
        baseUrl,
        auth,
        ...(protocol === "text-completions"
          ? {
              textPromptFormat: protocolChanged
                || (currentTextPromptFormat === "server-template" && preset !== "llama-cpp")
                ? "raw" as const
                : currentTextPromptFormat ?? "raw" as const
            }
          : {}),
        ...(protocolChanged ? { headers: [] } : {}),
        ...(generation.allowInsecureHttp === true && provider !== "dry-run"
          ? { allowInsecureHttp: true as const }
          : {})
      }
    },
    models: {
      ...document.models,
      [route.profile.modelId]: {
        ...route.model,
        ...(modelChanged
          ? {
              remoteId: modelId,
              name: provider === "dry-run" ? "Dry Run" : modelId,
              discovered: {},
              capabilities: {
                ...route.model.capabilities,
                promptCaching: provider === "dry-run" ? "unsupported" : "unknown",
                reasoningEffort: provider === "dry-run" ? "unsupported" : "unknown",
                // Always restated rather than inherited: a route moved off
                // text completion must lose that protocol's refusal.
                reasoningContent: provider === "text-completion" ? "unsupported" : "unknown",
                imageInput: imageInputForModelChangeV3(provider)
              }
            }
          : {}),
        overrides
      }
    },
    profiles: {
      ...document.profiles,
      [profileId]: {
        ...route.profile,
        temperature: generation.temperature,
        maxOutputTokens: generation.maxTokens
      }
    },
    writing: { ...document.writing, defaultAuthorBrief: generation.systemPrompt }
  });
}

function incompletePreset(
  provider: Provider,
  baseUrl: string | null
): ModelConnectionV2["preset"] {
  if (provider === "dry-run") return "dry-run";
  if (baseUrl === null || baseUrl.length === 0) return "custom";
  try {
    return basicSettingsPresetFor(provider, baseUrl);
  } catch {
    return "custom";
  }
}

function incompleteDraftAuth(
  provider: Provider,
  apiKeyEnv: string | null,
  storedSecretId: string | null
): ModelConnectionV2["auth"] {
  if (provider === "dry-run") return { type: "none" };
  if (apiKeyEnv !== null) {
    return provider === "anthropic"
      ? { type: "header-env", name: "x-api-key", env: apiKeyEnv }
      : { type: "bearer-env", env: apiKeyEnv };
  }
  if (storedSecretId === null) return { type: "none" };
  return provider === "anthropic"
    ? { type: "header-stored", name: "x-api-key", secretId: storedSecretId }
    : { type: "bearer-stored", secretId: storedSecretId };
}

/** Schema 3's per-key counterpart to the `reasoningContent` restatement
 *  inside `applyIncompleteGenerationDraft` above: `imageInput` must be
 *  restated explicitly on every model-identity change, never inherited from
 *  the old record, or a stale `"supported"` would survive the change.
 *  `dry-run` stays `"unsupported"`; every other provider becomes
 *  `"unknown"`. Exact built-in model knowledge resolves it from there
 *  (shared/image-input-capabilities.ts), not the model-change reset. */
export function imageInputForModelChangeV3(provider: Provider): FeatureSupportV2 {
  return provider === "dry-run" ? "unsupported" : "unknown";
}
