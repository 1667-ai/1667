import {
  EMPTY_SAMPLING_V2,
  type ModelCapabilitiesV2,
  type ModelConnectionV2,
  type SettingsDocumentV2,
  type SettingsRoutePurpose
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import type { PromptCacheContext } from "./provider-cache-policy.js";
import {
  attachProviderRuntime,
  isStandardModelConnectionV2,
  isSubscriptionModelConnectionV2,
  providerRuntimeFromV2,
  type ProviderRuntime
} from "./provider-runtime.js";
import {
  projectEffectiveGeneration,
  type EffectiveMetadataV2
} from "./settings-v2-conversion.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import type { SubscriptionRuntimeDependencies } from "./subscription-runtime.js";

export interface EffectiveGenerationRuntime {
  readonly settings: GenerationSettings;
  readonly promptCache: PromptCacheContext;
  readonly providerRuntime: ProviderRuntime;
}

export interface SettingsRuntimeRequest {
  readonly document: SettingsDocumentV2;
  readonly purpose?: SettingsRoutePurpose;
  readonly metadata?: EffectiveMetadataV2;
  /** Provider checks and discovery do not require a generation-ready model ID. */
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
    resolveConnection: (request) => resolveConnectionRuntime(
      request,
      dependencies.environment,
      dependencies.subscription
    )
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
  let providerRuntime: ProviderRuntime;
  if (isSubscriptionModelConnectionV2(connection)) {
    if (subscription === undefined) {
      throw new SettingsFormatError(
        "A subscription route requires a subscription-aware runtime resolver."
      );
    }
    providerRuntime = providerRuntimeFromV2(
      connection,
      profile.effort,
      model.capabilities,
      { ...runtimeOptions, subscription }
    );
  } else if (isStandardModelConnectionV2(connection)) {
    providerRuntime = providerRuntimeFromV2(
      connection,
      profile.effort,
      model.capabilities,
      runtimeOptions
    );
  } else {
    throw new SettingsFormatError("The selected provider protocol is unavailable.");
  }
  return {
    promptCache: projection.promptCache,
    providerRuntime,
    settings: attachProviderRuntime(projection.settings, providerRuntime)
  };
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
