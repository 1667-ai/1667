import {
  EMPTY_SAMPLING_V2,
  type ModelCapabilitiesV2,
  type ModelConnectionV2,
  type SettingsDocumentV2,
  type SettingsRoutePurpose
} from "../shared/settings-v2-types.js";
import {
  selectSettingsRouteV4,
  type SelectedSettingsRouteV4,
  type SettingsDocumentV4
} from "../shared/settings-v4-types.js";
import {
  selectSettingsRouteV5,
  type SelectedSettingsRouteV5,
  type SettingsDocumentV5
} from "../shared/settings-v5-types.js";
import type { GenerationReasoningV5 } from "../shared/settings-v5-reasoning.js";
import type { SelectedSettingsRouteV2 } from "../shared/settings-route.js";
import type { GenerationSettings } from "../shared/types.js";
import type { PromptCacheContext } from "./provider-cache-policy.js";
import {
  attachProviderRuntime,
  isStandardModelConnectionV2,
  isSubscriptionModelConnectionV2,
  providerRuntimeFromV2,
  type Schema4ProviderRuntimeOptions,
  type ProviderRuntimeOptions,
  type ProviderRuntime
} from "./provider-runtime.js";
import {
  projectEffectiveGeneration,
  projectEffectiveGenerationFromRoute,
  type EffectiveMetadataV2
} from "./settings-v2-conversion.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import type { SubscriptionRuntimeDependencies } from "./subscription-runtime.js";

export interface EffectiveGenerationRuntime {
  readonly settings: GenerationSettings;
  readonly promptCache: PromptCacheContext;
  readonly providerRuntime: ProviderRuntime;
  /** Exact route identity used for every field in this runtime snapshot. */
  readonly route: EffectiveRuntimeRoute;
}

export interface EffectiveRuntimeRoute {
  readonly profileId: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly reasoning: NonNullable<SettingsDocumentV2["profiles"][string]["reasoning"]>;
  readonly continuationPromptOptimization: SettingsDocumentV2["profiles"][string]["continuationPromptOptimization"];
}

export interface SettingsRuntimeRequest {
  readonly document: SettingsDocumentV2;
  readonly purpose?: SettingsRoutePurpose;
  readonly metadata?: EffectiveMetadataV2;
  /** Provider checks and discovery do not require a generation-ready model ID. */
  readonly allowBlankModel?: boolean;
  readonly storedSecrets?: ReadonlyMap<string, string>;
}

/** Read-only schema-4 runtime input. The predecessor accepts this shape for
 * execution but never feeds it into the schema-2 mutation pipeline. */
export interface SettingsRuntimeRequestV4 {
  readonly document: SettingsDocumentV4;
  readonly purpose?: SettingsRoutePurpose;
  readonly metadata?: EffectiveMetadataV2;
  readonly allowBlankModel?: boolean;
  readonly storedSecrets?: ReadonlyMap<string, string>;
}

export interface SettingsRuntimeRequestV5 {
  readonly document: SettingsDocumentV5;
  readonly purpose?: SettingsRoutePurpose;
  readonly metadata?: EffectiveMetadataV2;
  readonly allowBlankModel?: boolean;
  readonly storedSecrets?: ReadonlyMap<string, string>;
}

export interface ProviderRuntimeResolutionRequest {
  readonly connection: ModelConnectionV2;
  readonly effort: SettingsDocumentV2["profiles"][string]["effort"];
  readonly capabilities: ModelCapabilitiesV2;
  readonly storedSecrets?: ReadonlyMap<string, string>;
}

/** Resolve settings through one machine-tier runtime composition root. */
export interface SettingsRuntimeResolver {
  readonly credentials: SubscriptionRuntimeDependencies["credentials"];
  resolve(request: SettingsRuntimeRequest): EffectiveGenerationRuntime;
  resolveV4(request: SettingsRuntimeRequestV4): EffectiveGenerationRuntime;
  resolveV5(request: SettingsRuntimeRequestV5): EffectiveGenerationRuntime;
  resolveConnection(request: ProviderRuntimeResolutionRequest): ProviderRuntime;
}

export interface SettingsRuntimeDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readonly subscription: SubscriptionRuntimeDependencies;
}

export function createSettingsRuntimeResolver(
  dependencies: SettingsRuntimeDependencies
): SettingsRuntimeResolver {
  return {
    credentials: dependencies.subscription.credentials,
    resolve: (request) => materializeEffectiveGenerationRuntime(
      request,
      dependencies.environment,
      dependencies.subscription
    ),
    resolveV4: (request) => materializeEffectiveGenerationRuntimeV4(
      request,
      dependencies.environment,
      dependencies.subscription
    ),
    resolveV5: (request) => materializeEffectiveGenerationRuntimeV5(
      request,
      dependencies.environment,
      dependencies.subscription
    ),
    resolveConnection: (request) => resolveConnectionRuntime(
      request,
      dependencies.environment,
      dependencies.subscription
    )
  };
}

/** Resolve schema 4 through the same provider composition root. The selected
 *  route adapts only the frozen scalar and prompt-cache fields; schema-4
 *  effort and thinking mode go directly to the provider runtime. */
function materializeEffectiveGenerationRuntimeV4(
  request: SettingsRuntimeRequestV4,
  environment?: NodeJS.ProcessEnv,
  subscription?: SubscriptionRuntimeDependencies
): EffectiveGenerationRuntime {
  const route = selectSettingsRouteV4(
    request.document,
    request.purpose ?? "default"
  );
  const projection = projectEffectiveGenerationFromRoute(
    request.document.writing.defaultAuthorBrief,
    settingsRouteV4RuntimeProjection(route),
    request.metadata ?? {},
    request.allowBlankModel === true
  );
  const runtimeOptions: Schema4ProviderRuntimeOptions = {
    environment,
    storedSecrets: request.storedSecrets,
    sampling: route.profile.sampling ?? EMPTY_SAMPLING_V2,
    tokenProbabilities: route.profile.tokenProbabilities ?? null,
    reasoning: route.profile.reasoning ?? "marker",
    keepReasoning: route.profile.discardReasoning !== true,
    thinkingMode: route.profile.thinkingMode,
    continuationPromptOptimization: route.profile.continuationPromptOptimization
  };
  const providerRuntime = resolveProviderRuntimeV4(
    route.connection,
    route.profile.effort,
    route.model.capabilities,
    runtimeOptions,
    subscription
  );
  return {
    promptCache: projection.promptCache,
    providerRuntime,
    settings: attachProviderRuntime(projection.settings, providerRuntime),
    route: effectiveRuntimeRoute(route)
  };
}

/** Adapt only the frozen scalar/cache fields of the selected schema-4 route.
 * Its IDs and records stay bound to the one route selected above. */
function settingsRouteV4RuntimeProjection(
  route: SelectedSettingsRouteV4
): SelectedSettingsRouteV2 {
  const {
    thinkingMode: _thinkingMode,
    effort: _effort,
    ...profile
  } = route.profile;
  const {
    imageInput: _imageInput,
    imageTokenCeiling: _imageTokenCeiling,
    ...capabilities
  } = route.model.capabilities;
  return {
    profileId: route.profileId,
    profile: { ...profile, effort: "default" },
    model: { ...route.model, capabilities },
    connection: route.connection
  };
}

/** Project one standard provider route without subscription infrastructure. */
export function effectiveStandardGenerationRuntime(
  document: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default",
  metadata: EffectiveMetadataV2 = {},
  environment?: NodeJS.ProcessEnv,
  options: { readonly allowBlankModel?: boolean } = {},
  storedSecrets?: ReadonlyMap<string, string>
): EffectiveGenerationRuntime {
  return materializeEffectiveGenerationRuntime({
    document,
    purpose,
    metadata,
    allowBlankModel: options.allowBlankModel,
    storedSecrets
  }, environment);
}

/** Project settings and cache policy from one parsed route snapshot. */
function materializeEffectiveGenerationRuntime(
  request: SettingsRuntimeRequest,
  environment?: NodeJS.ProcessEnv,
  subscription?: SubscriptionRuntimeDependencies
): EffectiveGenerationRuntime {
  const projection = projectEffectiveGeneration(
    request.document,
    request.purpose ?? "default",
    request.metadata ?? {},
    request.allowBlankModel === true
  );
  const { profile, model, connection } = projection.route;
  const runtimeOptions = {
    environment,
    storedSecrets: request.storedSecrets,
    sampling: profile.sampling ?? EMPTY_SAMPLING_V2,
    tokenProbabilities: profile.tokenProbabilities ?? null,
    reasoning: profile.reasoning ?? "marker",
    keepReasoning: profile.discardReasoning !== true,
    continuationPromptOptimization: profile.continuationPromptOptimization
  };
  const providerRuntime = resolveProviderRuntime(
    connection,
    profile.effort,
    model.capabilities,
    runtimeOptions,
    subscription
  );
  return {
    promptCache: projection.promptCache,
    providerRuntime,
    settings: attachProviderRuntime(projection.settings, providerRuntime),
    route: effectiveRuntimeRoute(projection.route)
  };
}

function effectiveRuntimeRoute(
  route: SelectedSettingsRouteV2 | SelectedSettingsRouteV4 | SelectedSettingsRouteV5
): EffectiveRuntimeRoute {
  return {
    profileId: route.profileId,
    modelId: route.profile.modelId,
    connectionId: route.model.connectionId,
    reasoning: route.profile.reasoning ?? "marker",
    continuationPromptOptimization: route.profile.continuationPromptOptimization
  };
}

function resolveProviderRuntime(
  connection: ModelConnectionV2,
  effort: SettingsDocumentV2["profiles"][string]["effort"],
  capabilities: ModelCapabilitiesV2,
  options: ProviderRuntimeOptions,
  subscription?: SubscriptionRuntimeDependencies
): ProviderRuntime {
  if (isSubscriptionModelConnectionV2(connection)) {
    if (subscription === undefined) {
      throw new SettingsFormatError(
        "A subscription route requires a subscription-aware runtime resolver."
      );
    }
    return providerRuntimeFromV2(
      connection,
      effort,
      capabilities,
      { ...options, subscription }
    );
  }
  if (isStandardModelConnectionV2(connection)) {
    return providerRuntimeFromV2(connection, effort, capabilities, options);
  }
  throw new SettingsFormatError("The selected provider protocol is unavailable.");
}

function resolveProviderRuntimeV4(
  connection: ModelConnectionV2,
  effort: SettingsDocumentV4["profiles"][string]["effort"],
  capabilities: ModelCapabilitiesV2,
  options: Schema4ProviderRuntimeOptions,
  subscription?: SubscriptionRuntimeDependencies
): ProviderRuntime {
  if (isSubscriptionModelConnectionV2(connection)) {
    if (subscription === undefined) {
      throw new SettingsFormatError(
        "A subscription route requires a subscription-aware runtime resolver."
      );
    }
    return providerRuntimeFromV2(
      connection,
      effort,
      capabilities,
      { ...options, subscription }
    );
  }
  if (isStandardModelConnectionV2(connection)) {
    return providerRuntimeFromV2(connection, effort, capabilities, options);
  }
  throw new SettingsFormatError("The selected provider protocol is unavailable.");
}

/** Resolve schema 5 through the persisted reasoning discriminator. Legacy
 *  profiles keep historical lowering. Independent profiles keep the schema-4
 *  effort and Thinking Mode pair. */
function materializeEffectiveGenerationRuntimeV5(
  request: SettingsRuntimeRequestV5,
  environment?: NodeJS.ProcessEnv,
  subscription?: SubscriptionRuntimeDependencies
): EffectiveGenerationRuntime {
  const route = selectSettingsRouteV5(
    request.document,
    request.purpose ?? "default"
  );
  const projection = projectEffectiveGenerationFromRoute(
    request.document.writing.defaultAuthorBrief,
    settingsRouteV5RuntimeProjection(route),
    request.metadata ?? {},
    request.allowBlankModel === true
  );
  const sharedOptions = {
    environment,
    storedSecrets: request.storedSecrets,
    sampling: route.profile.sampling ?? EMPTY_SAMPLING_V2,
    tokenProbabilities: route.profile.tokenProbabilities ?? null,
    reasoning: route.profile.reasoning ?? "marker",
    keepReasoning: route.profile.discardReasoning !== true,
    continuationPromptOptimization: route.profile.continuationPromptOptimization
  };
  const providerRuntime = resolveProviderRuntimeFromReasoning(
    route.connection,
    route.profile.generationReasoning,
    route.model.capabilities,
    sharedOptions,
    subscription
  );
  return {
    promptCache: projection.promptCache,
    providerRuntime,
    settings: attachProviderRuntime(projection.settings, providerRuntime),
    route: effectiveRuntimeRoute(route)
  };
}

function settingsRouteV5RuntimeProjection(
  route: SelectedSettingsRouteV5
): SelectedSettingsRouteV2 {
  const {
    generationReasoning,
    ...profile
  } = route.profile;
  const {
    imageInput: _imageInput,
    imageTokenCeiling: _imageTokenCeiling,
    ...capabilities
  } = route.model.capabilities;
  const effort = generationReasoning.kind === "legacy" ? generationReasoning.effort : "default";
  return {
    profileId: route.profileId,
    profile: { ...profile, effort },
    model: { ...route.model, capabilities },
    connection: route.connection
  };
}

function resolveProviderRuntimeFromReasoning(
  connection: ModelConnectionV2,
  generationReasoning: GenerationReasoningV5,
  capabilities: ModelCapabilitiesV2,
  options: ProviderRuntimeOptions,
  subscription?: SubscriptionRuntimeDependencies
): ProviderRuntime {
  if (generationReasoning.kind === "independent") {
    return resolveProviderRuntimeV4(
      connection,
      generationReasoning.effort,
      capabilities,
      { ...options, thinkingMode: generationReasoning.thinkingMode },
      subscription
    );
  }
  return resolveProviderRuntime(
    connection,
    generationReasoning.effort,
    capabilities,
    options,
    subscription
  );
}

function resolveConnectionRuntime(
  request: ProviderRuntimeResolutionRequest,
  environment: NodeJS.ProcessEnv,
  subscription: SubscriptionRuntimeDependencies
): ProviderRuntime {
  const options = { environment, storedSecrets: request.storedSecrets };
  if (isSubscriptionModelConnectionV2(request.connection)) {
    return providerRuntimeFromV2(
      request.connection,
      request.effort,
      request.capabilities,
      { ...options, subscription }
    );
  }
  if (isStandardModelConnectionV2(request.connection)) {
    return providerRuntimeFromV2(
      request.connection,
      request.effort,
      request.capabilities,
      options
    );
  }
  throw new SettingsFormatError("The selected provider protocol is unavailable.");
}
