import {
  EMPTY_SAMPLING_V2,
  PROMPT_CACHE_POLICY_V2_VALUES,
  type FeatureSupportV2,
  type SamplingSettingsV2,
  type PromptCachePolicyV2,
  type ModelConnectionV2,
  type SettingsDocumentV2,
  type SettingsView
} from "../../shared/settings-v2-types.js";
import {
  PROVIDER_VALUES,
  type GenerationSettings,
  type Provider
} from "../../shared/types.js";
import {
  applyBasicSettingsProbeDraft,
  basicSettingsConnectionName,
  basicSettingsPresetAfterIdentityChange,
  basicSettingsPresetFor,
  basicSettingsForDisplay,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import {
  applyPromptCachePolicy,
  promptCacheContextForProfile
} from "../../shared/prompt-cache-capabilities.js";
import {
  isolateSettingsProfileModel,
  prepareSettingsProfileGenerationEdit,
  selectedSettingsProfileId
} from "./settings-profile-draft.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { storedCredentialSecretId } from "../../shared/settings-stored-credential.js";
import {
  SAMPLING_SCALAR_KNOBS,
  validateSamplingBannedStrings,
  validateSamplingDryBreakers,
  validateSamplingLogitBias,
  validateSamplingPhraseBias,
  validateSamplingScalar,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "../../shared/sampling-validation-policy.js";

const SAMPLING_SCALAR_KEYS: ReadonlySet<string> = new Set(
  SAMPLING_SCALAR_KNOBS.map((key) => `sampling.${key}`)
);

/** The two sampling knobs that hold a list of strings. Both parse the same
 *  way, so the key carries its own field and bound rather than growing a
 *  second copy of the branch. A Map keeps an object key such as
 *  `constructor` from resolving to something that is not a setting. */
const SAMPLING_STRING_LISTS: ReadonlyMap<string, {
  readonly field: "stop" | "dryBreakers";
  readonly validate: (value: unknown, label: string) => readonly string[];
}> = new Map([
  ["sampling.stop", { field: "stop" as const, validate: validateSamplingStopSequences }],
  ["sampling.dryBreakers", { field: "dryBreakers" as const, validate: validateSamplingDryBreakers }]
]);

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

export function settingsTextDraftWithCachePolicy(
  draft: SettingsTextDraft,
  cachePolicy: PromptCachePolicyV2
): SettingsTextDraft {
  if (draft.document === null || draft.selectedProfileId === null) {
    return { ...draft, cachePolicy };
  }
  return settingsTextDraftForDocument(
    applyPromptCachePolicy(draft.document, cachePolicy, draft.selectedProfileId),
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

/** Draft serialization contract for generation settings: `key: value` lines, ≻ guidance
 *  stripped, unknown keys rejected so typos fail loudly instead of silently. */
export function serializeSettings(draft: SettingsTextDraft): string {
  const settings = draft.generation;
  return [
    "≻ 1667 · generation settings · key: value per line · ≻ lines are stripped.",
    "≻ provider is openai-compatible | text-completion | anthropic | dry-run · blank apiKeyEnv means none.",
    "≻ Advanced cachePolicy is off | auto | long · exact provider/model support is required.",
    `provider: ${settings.provider}`,
    `baseUrl: ${settings.baseUrl}`,
    `allowInsecureHttp: ${settings.allowInsecureHttp === true}`,
    `model: ${settings.model}`,
    `apiKeyEnv: ${settings.apiKeyEnv ?? ""}`,
    `temperature: ${settings.temperature}`,
    `maxTokens: ${settings.maxTokens}`,
    `contextWindow: ${settings.contextWindow ?? ""}`,
    `cachePolicy: ${draft.cachePolicy}`,
    // Derived from the knob list, so a new sampling parameter reaches this
    // surface with the rest of them rather than going missing here alone.
    ...SAMPLING_SCALAR_KNOBS.map((knob) => `sampling.${knob}: ${draft.sampling[knob] ?? ""}`),
    `sampling.stop: ${JSON.stringify(draft.sampling.stop)}`,
    `sampling.dryBreakers: ${JSON.stringify(draft.sampling.dryBreakers)}`,
    `sampling.logitBias: ${JSON.stringify(draft.sampling.logitBias)}`,
    `sampling.bannedStrings: ${JSON.stringify(draft.sampling.bannedStrings)}`,
    `sampling.phraseBias: ${JSON.stringify(draft.sampling.phraseBias)}`,
    `systemPrompt: ${settings.systemPrompt.replace(/\n/g, " ")}`
  ].join("\n");
}

export function parseSettings(value: string, base: SettingsTextDraft): SettingsTextDraft | { error: string } {
  const next = { ...base.generation };
  let cachePolicy = base.cachePolicy;
  let sampling = base.sampling;
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("≻")) continue;
    const divider = line.indexOf(":");
    if (divider === -1) return { error: `not key: value — "${line.slice(0, 40)}"` };
    const key = line.slice(0, divider).trim();
    const text = line.slice(divider + 1).trim();
    const scalarKnob = samplingScalarKnobForKey(key);
    const stringList = SAMPLING_STRING_LISTS.get(key);
    if (key === "provider") {
      if (!PROVIDER_VALUES.includes(text as Provider)) {
        return {
          error: `provider must be openai-compatible, text-completion, anthropic, or dry-run — "${text}"`
        };
      }
      next.provider = text as Provider;
    }
    else if (key === "baseUrl") next.baseUrl = text;
    else if (key === "allowInsecureHttp") {
      if (text !== "true" && text !== "false") {
        return { error: `allowInsecureHttp must be true or false — "${text}"` };
      }
      if (text === "true") next.allowInsecureHttp = true;
      else delete next.allowInsecureHttp;
    }
    else if (key === "model") next.model = text;
    else if (key === "apiKeyEnv") next.apiKeyEnv = text.length === 0 ? null : text;
    else if (key === "systemPrompt") next.systemPrompt = text;
    else if (key === "temperature") {
      if (text.length === 0) next.temperature = null;
      else {
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) return { error: `temperature is not a number or blank — "${text}"` };
        next.temperature = parsed;
      }
    } else if (key === "maxTokens") {
      const parsed = Number(text);
      if (!Number.isInteger(parsed) || parsed <= 0) return { error: `maxTokens must be a positive integer — "${text}"` };
      next.maxTokens = parsed;
    } else if (key === "contextWindow") {
      if (text.length === 0) next.contextWindow = null;
      else {
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed <= 0) return { error: `contextWindow must be a positive integer or blank — "${text}"` };
        next.contextWindow = parsed;
      }
    } else if (key === "cachePolicy") {
      if (!PROMPT_CACHE_POLICY_V2_VALUES.includes(text as PromptCachePolicyV2)) {
        return { error: `cachePolicy must be off, auto, or long — "${text}"` };
      }
      cachePolicy = text as PromptCachePolicyV2;
    } else if (scalarKnob !== null) {
      const parsed = text.length === 0 ? null : Number(text);
      if (parsed !== null && !Number.isFinite(parsed)) {
        return { error: `${key} is not a number or blank — "${text}"` };
      }
      if (parsed !== null) {
        try {
          validateSamplingScalar(scalarKnob, parsed, key);
        } catch (error) {
          return samplingParseError(error);
        }
      }
      sampling = { ...sampling, [scalarKnob]: parsed } as SamplingSettingsV2;
    } else if (stringList !== undefined) {
      const parsed = parseJsonValue(text, key, []);
      if (parsed.error !== undefined) return parsed;
      if (!Array.isArray(parsed.value) || parsed.value.some((item) => typeof item !== "string")) {
        return { error: `${key} must be a JSON array of strings` };
      }
      try {
        sampling = {
          ...sampling,
          [stringList.field]: stringList.validate(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else if (key === "sampling.logitBias") {
      const parsed = parseJsonValue(text, key, {});
      if (parsed.error !== undefined) return parsed;
      if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return { error: `${key} must be a JSON object` };
      }
      try {
        sampling = {
          ...sampling,
          logitBias: validateSamplingLogitBias(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else if (key === "sampling.bannedStrings") {
      const parsed = parseJsonValue(text, key, []);
      if (parsed.error !== undefined) return parsed;
      if (!Array.isArray(parsed.value) || parsed.value.some((item) => typeof item !== "string")) {
        return { error: `${key} must be a JSON array of strings` };
      }
      try {
        sampling = {
          ...sampling,
          bannedStrings: validateSamplingBannedStrings(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else if (key === "sampling.phraseBias") {
      const parsed = parseJsonValue(text, key, []);
      if (parsed.error !== undefined) return parsed;
      if (!Array.isArray(parsed.value)) {
        return { error: `${key} must be a JSON array of {phrase, weight} objects` };
      }
      try {
        sampling = {
          ...sampling,
          phraseBias: validateSamplingPhraseBias(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else return { error: `unknown setting "${key}"` };
  }
  return { ...base, generation: next, cachePolicy, sampling };
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
    );
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
  return {
    ...document,
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
                reasoningContent: provider === "text-completion" ? "unsupported" : "unknown"
                // Schema 3 adds `imageInput` as a required sibling of these
                // keys. This spread stays on schema 2 (release N keeps
                // writing schema 2), which has no `imageInput` field to
                // restate. `imageInputForModelChangeV3` below carries the
                // exact value this spread would need to add once a schema-3
                // draft path replaces it. Do not let a future edit here add
                // `imageInput` inline without also restating it, the same
                // drift hazard `reasoningContent` guards against above.
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
  };
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

function samplingScalarKnobForKey(key: string): SamplingScalarKnob | null {
  return SAMPLING_SCALAR_KEYS.has(key)
    ? key.slice("sampling.".length) as SamplingScalarKnob
    : null;
}

function samplingParseError(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

function parseJsonValue(
  text: string,
  key: string,
  emptyValue: unknown
): { value: unknown; error?: never } | { error: string } {
  if (text.length === 0) return { value: emptyValue };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `${key} must contain valid JSON` };
  }
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
