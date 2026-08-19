import type {
  ContinuationPromptOptimizationV2
} from "./continuation-prompt-optimization.js";
import type { GenerationSettings } from "./types.js";

export type { SettingsView } from "./settings-v2-view.js";

export const SETTINGS_PROTOCOL_V2_VALUES = [
  "dry-run",
  "openai-chat-completions",
  "text-completions",
  "anthropic-messages",
  "openai-codex-responses",
  "anthropic-subscription-messages"
] as const;
export type SettingsProtocolV2 = (typeof SETTINGS_PROTOCOL_V2_VALUES)[number];

/** Protocols owned by the fixed subscription connections. */
export const SETTINGS_SUBSCRIPTION_PROTOCOL_V2_VALUES = [
  "openai-codex-responses",
  "anthropic-subscription-messages"
] as const;
export type SubscriptionProtocolV2 = (typeof SETTINGS_SUBSCRIPTION_PROTOCOL_V2_VALUES)[number];

export const TEXT_PROMPT_FORMAT_V2_VALUES = [
  "raw",
  "server-template",
  "chatml"
] as const;
export type TextPromptFormatV2 = (typeof TEXT_PROMPT_FORMAT_V2_VALUES)[number];

export const SETTINGS_PRESET_V2_VALUES = [
  "dry-run",
  "openai",
  "openrouter",
  "anthropic",
  "lm-studio",
  "ollama",
  "llama-cpp",
  "koboldcpp",
  "custom",
  "chatgpt-plan",
  "claude-plan"
] as const;
export type SettingsPresetV2 = (typeof SETTINGS_PRESET_V2_VALUES)[number];

/** Presets owned by the fixed subscription connections. */
export const SETTINGS_SUBSCRIPTION_PRESET_V2_VALUES = [
  "chatgpt-plan",
  "claude-plan"
] as const;
export type SubscriptionPresetV2 = (typeof SETTINGS_SUBSCRIPTION_PRESET_V2_VALUES)[number];

export function isSubscriptionProtocolV2(
  value: SettingsProtocolV2
): value is SubscriptionProtocolV2 {
  return value === "openai-codex-responses"
    || value === "anthropic-subscription-messages";
}

export function isSubscriptionPresetV2(
  value: SettingsPresetV2
): value is SubscriptionPresetV2 {
  return value === "chatgpt-plan" || value === "claude-plan";
}

export function subscriptionPresetForProtocolV2(
  protocol: SubscriptionProtocolV2
): SubscriptionPresetV2 {
  return protocol === "openai-codex-responses" ? "chatgpt-plan" : "claude-plan";
}

export function subscriptionProtocolForPresetV2(
  preset: SubscriptionPresetV2
): SubscriptionProtocolV2 {
  return preset === "chatgpt-plan"
    ? "openai-codex-responses"
    : "anthropic-subscription-messages";
}

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
  /** Text protocols default to raw when this additive field is absent. */
  readonly textPromptFormat?: TextPromptFormatV2;
  /** Absence means false. Only literal true is persisted. */
  readonly allowInsecureHttp?: true;
  /** Split a `<think>` block out of a text route's token stream and keep it
   *  as the take's thought. Absence means false, and only literal true is
   *  persisted, the same shape as `allowInsecureHttp`. A raw text route
   *  otherwise passes every token through to the prose. */
  readonly splitThinkTags?: true;
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
  /** Whether the route ever returns reasoning content to display as a
   *  thought. Absent means unknown, the same as a model discovered before
   *  this capability existed — it renders the same as `"unknown"`, never
   *  `"supported"`. */
  readonly reasoningContent?: FeatureSupportV2;
}

export interface ModelDefinitionV2 {
  readonly connectionId: string;
  readonly remoteId: string;
  readonly name: string;
  readonly discovered: ModelScalarMetadataV2;
  readonly overrides: ModelScalarMetadataV2;
  readonly capabilities: ModelCapabilitiesV2;
}

/** Schema 3's model capability record: every field `ModelCapabilitiesV2` has,
 *  plus a required `imageInput`. This is a separate type, not an in-place
 *  addition to `ModelCapabilitiesV2`, because the settings schema release
 *  rule forbids adding `imageInput` to persisted schema 2: schema 2's wire
 *  shape and hash vectors must stay byte-identical, so an older executable
 *  can still read a schema-2 document after a downgrade. */
export interface ModelCapabilitiesV3 extends ModelCapabilitiesV2 {
  readonly imageInput: FeatureSupportV2;
  /** A conservative per-image visual-token ceiling for an explicit
   *  `"supported"` override with no built-in image-token strategy. Present
   *  only when `imageInput` is `"supported"`; the codec enforces that
   *  pairing, because the JSON Schema `closed()` helper cannot express a
   *  cross-field rule. */
  readonly imageTokenCeiling?: number;
}

export interface ModelDefinitionV3 {
  readonly connectionId: string;
  readonly remoteId: string;
  readonly name: string;
  readonly discovered: ModelScalarMetadataV2;
  readonly overrides: ModelScalarMetadataV2;
  readonly capabilities: ModelCapabilitiesV3;
}

export const GENERATION_EFFORT_V2_VALUES = ["default", "off", "low", "medium", "high"] as const;
export type GenerationEffortV2 = (typeof GENERATION_EFFORT_V2_VALUES)[number];

export const PROMPT_CACHE_POLICY_V2_VALUES = ["off", "auto", "long"] as const;
export type PromptCachePolicyV2 = (typeof PROMPT_CACHE_POLICY_V2_VALUES)[number];

/** How a part's reasoning renders: `off` never shows a thought, `marker` is
 *  the default ghost gutter word, `open` arrives unfolded. */
export const REASONING_DISPLAY_V2_VALUES = ["off", "marker", "open"] as const;
export type ReasoningDisplayV2 = (typeof REASONING_DISPLAY_V2_VALUES)[number];

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
   * boundaries than the ones resolution found.
   *
   * KoboldCpp (issue #311) is the one exception to the mechanism, not to the
   * promise: each string reaches KoboldCpp's native anti-slop `banned_tokens`
   * field as literal text instead, needing no tokenization at all — see the
   * PRESET_SUBTRACTIONS comment in shared/sampling-capabilities.ts for the
   * field's own documented description and the transport this depends on.
   * It still only makes the string unlikely: KoboldCpp's own document
   * describes backtracking and regenerating when a banned sequence appears,
   * not refusing to ever produce it, so the same "unlikely, not impossible"
   * rule applies there too. */
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
  /** Alternative tokens to ask the provider for with each generated token.
   *  Absent means the request asks for none. */
  readonly tokenProbabilities?: number;
  /** How a thought displays while reading. Absent means `"marker"`, the
   *  default fold state. */
  readonly reasoning?: ReasoningDisplayV2;
  /** Discard reasoning on arrival instead of storing it with the take.
   *  Absent means false, so a document saved before this field existed —
   *  and every other document that never sets it — keeps "Keep thoughts"
   *  on, the default. Named for the non-default action, the inverse of
   *  `ModelConnectionV2.allowInsecureHttp`, which names the non-default
   *  action for a field whose default is off rather than on. Only literal
   *  `true` is ever persisted. */
  readonly discardReasoning?: true;
  /** Experimental continuation prompt layout. Absent keeps the v0.8.0
   *  compatibility layout. Only the named opt-in is persisted. */
  readonly continuationPromptOptimization?: ContinuationPromptOptimizationV2;
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

/** Schema 3's document: identical to `SettingsDocumentV2` except every model
 *  capability record carries the required `imageInput` field. This release
 *  reads and validates schema 3; it keeps writing schema 2 until image input
 *  activates (`shared/image-input-release.ts`). */
export interface SettingsDocumentV3 {
  readonly schemaVersion: 3;
  readonly connections: Readonly<Record<string, ModelConnectionV2>>;
  readonly models: Readonly<Record<string, ModelDefinitionV3>>;
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

/** The field list for one settings-state aggregate, generic over its schema
 *  version and its document type. `SettingsStateV2` and `SettingsStateV3` are
 *  the only two instantiations; neither restates a field. */
export interface SettingsStateEnvelope<V extends 2 | 3, D> {
  readonly schemaVersion: V;
  readonly stateGeneration: number;
  readonly settingsRevisionClock: number;
  readonly documents: Readonly<Record<string, D>>;
  readonly activeRevision: number;
  readonly pendingRevision: number | null;
  readonly previousRevision: number | null;
  readonly activation: SettingsActivationV2 | null;
  readonly lastActivationOutcome: SettingsActivationOutcomeV2 | null;
  readonly lastTransaction: SettingsTransactionPointerV2 | null;
}

export type SettingsStateV2 = SettingsStateEnvelope<2, SettingsDocumentV2>;

/** Schema 3's aggregate state: identical field list to `SettingsStateV2`
 *  except its documents are schema 3. Nothing in this release writes one; it
 *  exists so a schema-3 state (produced by a later release) reads and
 *  validates. */
export type SettingsStateV3 = SettingsStateEnvelope<3, SettingsDocumentV3>;

export const SETTINGS_ROUTE_PURPOSE_VALUES = ["default", "prose", "utility"] as const;
export type SettingsRoutePurpose = (typeof SETTINGS_ROUTE_PURPOSE_VALUES)[number];

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
