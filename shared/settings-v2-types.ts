import type { GenerationSettings } from "./types.js";

export const SETTINGS_PROTOCOL_V2_VALUES = [
  "dry-run",
  "openai-chat-completions",
  "anthropic-messages"
] as const;
export type SettingsProtocolV2 = (typeof SETTINGS_PROTOCOL_V2_VALUES)[number];

export const SETTINGS_PRESET_V2_VALUES = [
  "dry-run",
  "openai",
  "openrouter",
  "anthropic",
  "lm-studio",
  "ollama",
  "llama-cpp",
  "koboldcpp",
  "custom"
] as const;
export type SettingsPresetV2 = (typeof SETTINGS_PRESET_V2_VALUES)[number];

export type CredentialReferenceV2 =
  | { readonly type: "none" }
  | { readonly type: "bearer-env"; readonly env: string }
  | { readonly type: "header-env"; readonly name: string; readonly env: string }
  // A future bearer-keyring variant can reuse the same opaque reference shape.
  | { readonly type: "bearer-stored"; readonly secretId: string }
  | { readonly type: "header-stored"; readonly name: string; readonly secretId: string };

export interface CustomHeaderV2 {
  readonly name: string;
  readonly value: {
    readonly type: "env";
    readonly env: string;
  };
}

export interface ConnectionTimeoutsV2 {
  readonly responseHeaderMs: number;
  readonly firstTokenMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}

export interface ModelConnectionV2 {
  readonly name: string;
  readonly preset: SettingsPresetV2;
  readonly protocol: SettingsProtocolV2;
  readonly baseUrl: string | null;
  readonly auth: CredentialReferenceV2;
  readonly headers: readonly CustomHeaderV2[];
  readonly timeouts: ConnectionTimeoutsV2;
  /** Absence means false. Only literal true is persisted. */
  readonly allowInsecureHttp?: true;
}

export const FEATURE_SUPPORT_V2_VALUES = ["supported", "unsupported", "unknown"] as const;
export type FeatureSupportV2 = (typeof FEATURE_SUPPORT_V2_VALUES)[number];

export interface ModelScalarMetadataV2 {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelCapabilitiesV2 {
  readonly temperature: FeatureSupportV2;
  readonly assistantPrefill: FeatureSupportV2;
  readonly reasoningEffort: FeatureSupportV2;
  readonly promptCaching: FeatureSupportV2;
}

export interface ModelDefinitionV2 {
  readonly connectionId: string;
  readonly remoteId: string;
  readonly name: string;
  readonly discovered: ModelScalarMetadataV2;
  readonly overrides: ModelScalarMetadataV2;
  readonly capabilities: ModelCapabilitiesV2;
}

export const GENERATION_EFFORT_V2_VALUES = ["default", "off", "low", "medium", "high"] as const;
export type GenerationEffortV2 = (typeof GENERATION_EFFORT_V2_VALUES)[number];

export const PROMPT_CACHE_POLICY_V2_VALUES = ["off", "auto", "long"] as const;
export type PromptCachePolicyV2 = (typeof PROMPT_CACHE_POLICY_V2_VALUES)[number];

export const SAMPLING_SCALAR_KNOB_V2_VALUES = [
  "topP",
  "topK",
  "minP",
  "frequencyPenalty",
  "presencePenalty",
  "repeatPenalty",
  "seed",
  "dryMultiplier",
  "dryBase",
  "dryRange",
  "xtcThreshold",
  "xtcProbability",
  "dynatempRange",
  "mirostat",
  "mirostatTau",
  "mirostatEta"
] as const;
export type SamplingScalarKnobV2 = (typeof SAMPLING_SCALAR_KNOB_V2_VALUES)[number];

export const SAMPLING_KNOB_V2_VALUES = [
  ...SAMPLING_SCALAR_KNOB_V2_VALUES,
  "stop",
  "logitBias",
  "phraseBias",
  "bannedStrings",
  "dryBreakers"
] as const;
export type SamplingKnobV2 = (typeof SAMPLING_KNOB_V2_VALUES)[number];

/** Knobs the wire decoder treats as optional, so a settings document saved
 * before they existed still loads without them — see `parseSampling` in
 * server/settings-v2-sampling-validation.ts. Every other knob stays
 * required on the wire, unchanged from the original schema.
 *
 * This is not simply "every knob added after the initial release": DRY,
 * XTC and Mirostat (issue #292) and `seed` were also added after the
 * initial release, and are required, not listed here. Only `phraseBias`
 * and `bannedStrings` (issue #282) are additive, because #282 is the change
 * that would otherwise leave a document saved just before it landed unable
 * to decode. Whether DRY/XTC/Mirostat/`seed` have the same gap for a
 * document saved between the initial release and #292 is a question for
 * that change, not this one — pre-existing on `main`, unchanged here. */
export const SAMPLING_KNOB_V2_ADDITIVE_VALUES = [
  "phraseBias",
  "bannedStrings"
] as const satisfies readonly SamplingKnobV2[];

/** The complement of `SAMPLING_KNOB_V2_ADDITIVE_VALUES`: every knob that
 * stays required on the wire. Exported once so the schema definition
 * (`scripts/settings-v2-schema-definition.ts`) and the wire decoder
 * (`server/settings-v2-sampling-validation.ts`) read the same derived list
 * instead of each spelling "every non-additive knob" its own way — two
 * spellings of one set is exactly the drift a new additive knob could fall
 * through (issue #282 review round 5, finding 4). */
export const SAMPLING_KNOB_V2_REQUIRED_VALUES: readonly SamplingKnobV2[] =
  SAMPLING_KNOB_V2_VALUES.filter(
    (knob) => !(SAMPLING_KNOB_V2_ADDITIVE_VALUES as readonly SamplingKnobV2[]).includes(knob)
  );

/** One text phrase and the weight applied to every token it tokenizes to.
 * Resolution happens at request time (`server/provider-sampling.ts`) and in
 * the editor preview (`server/sampling-phrase-bias.ts`); this shape never
 * stores token IDs, only the phrase a writer typed. */
export interface SamplingPhraseBiasEntryV2 {
  readonly phrase: string;
  readonly weight: number;
}

export type SamplingSettingsV2 = {
  readonly [Knob in SamplingScalarKnobV2]: number | null;
} & {
  readonly stop: readonly string[];
  readonly logitBias: Readonly<Record<string, number>>;
  /** A negative-bias shortcut: each string resolves to token IDs biased by
   * the most negative allowed weight. This makes the string unlikely, not
   * impossible — the same text can still appear through different token
   * boundaries than the ones resolution found. */
  readonly bannedStrings: readonly string[];
  readonly phraseBias: readonly SamplingPhraseBiasEntryV2[];
  readonly dryBreakers: readonly string[];
};

export const EMPTY_SAMPLING_V2: SamplingSettingsV2 = Object.freeze({
  topP: null,
  topK: null,
  minP: null,
  frequencyPenalty: null,
  presencePenalty: null,
  repeatPenalty: null,
  seed: null,
  dryMultiplier: null,
  dryBase: null,
  dryRange: null,
  xtcThreshold: null,
  xtcProbability: null,
  dynatempRange: null,
  mirostat: null,
  mirostatTau: null,
  mirostatEta: null,
  stop: Object.freeze([]) as readonly string[],
  logitBias: Object.freeze({}) as Readonly<Record<string, number>>,
  bannedStrings: Object.freeze([]) as readonly string[],
  phraseBias: Object.freeze([]) as readonly SamplingPhraseBiasEntryV2[],
  dryBreakers: Object.freeze([]) as readonly string[]
});

export interface GenerationProfileV2 {
  readonly name: string;
  readonly modelId: string;
  readonly temperature: number | null;
  readonly maxOutputTokens: number;
  readonly effort: GenerationEffortV2;
  readonly cachePolicy: PromptCachePolicyV2;
  /** Absent means every sampling knob is omitted from the request. */
  readonly sampling?: SamplingSettingsV2;
}

export interface SettingsRoutingV2 {
  readonly default: string;
  readonly prose?: string;
  readonly utility?: string;
}

export interface SettingsDocumentV2 {
  readonly schemaVersion: 2;
  readonly connections: Readonly<Record<string, ModelConnectionV2>>;
  readonly models: Readonly<Record<string, ModelDefinitionV2>>;
  readonly profiles: Readonly<Record<string, GenerationProfileV2>>;
  readonly routing: SettingsRoutingV2;
  readonly writing: {
    readonly defaultAuthorBrief: string;
  };
}

export type ModelDiscoverySourceV2 =
  | "anthropic-models"
  | "openai-models"
  | "lm-studio-models"
  | "ollama-tags";

export interface DiscoveredModelV2 {
  readonly remoteId: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly source: ModelDiscoverySourceV2;
}

export interface ModelDiscoveryResultV2 {
  readonly observedAt: string;
  readonly models: readonly DiscoveredModelV2[];
}

/** A probe may carry a validated draft document so connection policy is not
 * flattened out before the server constructs its provider runtime.
 *
 * `secrets` carries key material the editor holds but has not saved yet, so a
 * key can be tested the moment it is typed. The server resolves it in memory
 * for this one request and never writes it to the secret store: a probe proves
 * possession of the key, it does not activate a credential. */
export interface ProviderProbeDocumentTargetV2 {
  readonly kind: "settings-document";
  readonly document: SettingsDocumentV2;
  readonly purpose: SettingsRoutePurpose;
  readonly secrets?: Readonly<Record<string, string>>;
}

export type ProviderProbeTarget = GenerationSettings | ProviderProbeDocumentTargetV2;

export const SETTINGS_ACTIVATION_STATE_V2_VALUES = [
  "validating",
  "prepared",
  "promoted",
  "rolling-back",
  "committed"
] as const;
export type SettingsActivationStateV2 = (typeof SETTINGS_ACTIVATION_STATE_V2_VALUES)[number];

export interface SettingsActivationV2 {
  readonly transactionId: string;
  readonly oldHash: string;
  readonly candidateHash: string;
  readonly state: SettingsActivationStateV2;
  readonly attempt: 1;
}

export const SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES = [
  "candidate_invalid",
  "credential_unresolved",
  "activation_failed",
  "activation_crashed",
  "readiness_failed"
] as const;
export type SettingsActivationErrorCodeV2 =
  (typeof SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES)[number];

export const SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES = [
  "committed",
  "validation-failed",
  "rolled-back"
] as const;
export type SettingsActivationOutcomeResultV2 =
  (typeof SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES)[number];
export type SettingsActivationFailureResultV2 =
  Exclude<SettingsActivationOutcomeResultV2, "committed">;

interface SettingsActivationOutcomeBaseV2 {
  readonly transactionId: string;
  readonly candidateRevision: number;
  readonly atStateGeneration: number;
}

export type SettingsActivationOutcomeV2 = SettingsActivationOutcomeBaseV2 & (
  | {
      readonly result: "committed";
      readonly errorCode: null;
    }
  | {
      readonly result: SettingsActivationFailureResultV2;
      readonly errorCode: SettingsActivationErrorCodeV2;
    }
);

export type SettingsTransactionPointerV2 =
  | {
      readonly receiptKind: "user";
      readonly mutationId: string;
      readonly phase: "prepared";
    }
  | {
      readonly receiptKind: "format-migration-v1";
      readonly key: string;
      readonly phase: "prepared";
    };

export interface SettingsStateV2 {
  readonly schemaVersion: 2;
  readonly stateGeneration: number;
  readonly settingsRevisionClock: number;
  readonly documents: Readonly<Record<string, SettingsDocumentV2>>;
  readonly activeRevision: number;
  readonly pendingRevision: number | null;
  readonly previousRevision: number | null;
  readonly activation: SettingsActivationV2 | null;
  readonly lastActivationOutcome: SettingsActivationOutcomeV2 | null;
  readonly lastTransaction: SettingsTransactionPointerV2 | null;
}

export const SETTINGS_ROUTE_PURPOSE_VALUES = ["default", "prose", "utility"] as const;
export type SettingsRoutePurpose = (typeof SETTINGS_ROUTE_PURPOSE_VALUES)[number];

export type SettingsView =
  | {
      readonly dataFormat: 1;
      readonly editable: false;
      readonly stateGeneration: null;
      readonly activeRevision: null;
      readonly pendingRevision: null;
      readonly document: null;
      readonly effective: GenerationSettings;
      /** The active continuation route. Format 1 falls back to `effective`. */
      readonly effectiveProse: GenerationSettings;
      readonly lastActivationOutcome: null;
    }
  | {
      readonly dataFormat: 2;
      readonly editable: true;
      readonly stateGeneration: number;
      readonly activeRevision: number;
      readonly pendingRevision: number | null;
      readonly document: SettingsDocumentV2;
      readonly effective: GenerationSettings;
      /** The active continuation route, never a pending document projection. */
      readonly effectiveProse: GenerationSettings;
      readonly lastActivationOutcome: SettingsActivationOutcomeV2 | null;
    };

export interface SaveSettingsCommand {
  readonly transportOperationId: string;
  readonly mutationId: string;
  readonly expectedStateGeneration: number;
  readonly document: SettingsDocumentV2;
  /** Secret values are a write-only sidecar and never enter the settings document. */
  readonly connectionSecrets?: Readonly<Record<string, string | null>>;
}

export interface DiscardPendingSettingsCommand {
  readonly transportOperationId: string;
  readonly mutationId: string;
  readonly expectedStateGeneration: number;
}

/** Settings mutation response. The first four fields are the exact bounded
 * durable result retained in the settings receipt; `activationOutcome` is
 * composed at response time from the surfaced activation state, so a save
 * that ran its in-process activation reports what happened in one round
 * trip, and an idempotent replay reports the attempt that has since run. */
export interface SettingsMutationResult {
  readonly kind: "settings";
  readonly settingsStateGeneration: number;
  readonly activeSettingsRevision: number;
  readonly pendingSettingsRevision: number | null;
  readonly activationOutcome: SettingsActivationOutcomeV2 | null;
}

/** What a fresh profile ships with. The C-08 tracks mark these as the default
 *  and the sentinel opens on them, so they have to be the same two numbers the
 *  initial settings document carries — a test holds the two together. */
export const DEFAULT_PROFILE_TEMPERATURE = 0.8;
export const DEFAULT_PROFILE_MAX_OUTPUT_TOKENS = 2_048;
