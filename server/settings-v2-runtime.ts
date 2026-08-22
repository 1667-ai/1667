import {
  SETTINGS_ROUTE_PURPOSE_VALUES,
  isSubscriptionProtocolV2,
  type SettingsDocumentV2,
  type SettingsStateV2,
  type SettingsView
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { checkModelServer } from "./server-check.js";
import { ownedLoopbackHttpSupported } from "./provider-fetch.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { projectEffectiveGeneration } from "./settings-v2-conversion.js";
import type { SettingsRuntimeResolver } from "./settings-runtime-resolver.js";
import { classifyHttpHost, SettingsFormatError } from "./settings-v2-scalars.js";
import { continuationPromptLayoutForOptimization } from "../shared/continuation-prompt-optimization.js";
import { writingPromptSettingsFromAuthorBrief } from "../shared/settings-v5-writing.js";
import { convertSettingsDocumentV2ToV5 } from "./settings-v5-conversion.js";
import {
  effectiveSettingsStateRevision,
  settingsStateRelation
} from "./settings-state-validation.js";
import {
  corruptSettingsStateReceipt,
  invalidSettingsMutation
} from "./settings-v2-mutation.js";

export function settingsViewFromState(
  state: SettingsStateV2
): Extract<SettingsView, { dataFormat: 2 }> {
  // A committed activation is past its point of no return: the candidate is
  // the document generation already uses, so the view reports it as plainly
  // active rather than as its own pending revision — even when the final
  // tidy-up publish is still owed after a crash.
  const pendingRevision = settingsStateRelation(state) === "committed"
    ? null
    : state.pendingRevision;
  const shown = pendingRevision === null
    ? activeSettingsDocument(state)
    : pendingSettingsDocument(state);
  const active = activeSettingsDocument(state);
  const effective = projectEffectiveGeneration(active, "default", {});
  const effectiveProse = projectEffectiveGeneration(active, "prose", {});
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: state.stateGeneration,
    activeRevision: effectiveActiveSettingsRevision(state),
    pendingRevision,
    document: convertSettingsDocumentV2ToV5(shown),
    effective: effective.settings,
    effectiveProse: effectiveProse.settings,
    // Read from `active`, never `shown`: `effectiveProse` above already
    // resolves against the active (never pending) document, and this must
    // describe the same route, not whichever document a mid-activation
    // window happens to be showing the editor.
    effectiveProseReasoning: effectiveProse.route.profile.reasoning ?? "marker",
    effectiveProseContinuationPromptLayout: continuationPromptLayoutForOptimization(
      effectiveProse.route.profile.continuationPromptOptimization
    ),
    activeWriting: writingPromptSettingsFromAuthorBrief(active.writing.defaultAuthorBrief),
    lastActivationOutcome: state.lastActivationOutcome
  };
}

/** The revision reads may act on. Activation publishes every edge for crash
 * recovery, and the promote edge flips `activeRevision` while the attempt is
 * still reversible — recovery rolls a promoted state back. Readers therefore
 * keep the old document until the commit edge, the durable point of no
 * return, after which recovery only completes the activation forward. This
 * keeps concurrent views and generation starts on pre-activation or
 * committed credentials, never on a half-activated candidate. */
export function effectiveActiveSettingsRevision(state: SettingsStateV2): number {
  return effectiveSettingsStateRevision(state);
}

export function activeSettingsDocument(state: SettingsStateV2): SettingsDocumentV2 {
  return state.documents[String(effectiveActiveSettingsRevision(state))]!;
}

export function pendingSettingsDocument(state: SettingsStateV2): SettingsDocumentV2 {
  if (state.pendingRevision === null) throw corruptSettingsStateReceipt("pending document");
  return state.documents[String(state.pendingRevision)]!;
}

export function credentialReferencesResolve(
  document: { readonly connections: SettingsDocumentV2["connections"] },
  environment: NodeJS.ProcessEnv,
  storedSecretIds: ReadonlySet<string> = new Set()
): boolean {
  for (const connection of Object.values(document.connections)) {
    if (
      (connection.auth.type === "bearer-env" || connection.auth.type === "header-env")
      && !nonemptyEnvironmentValue(environment, connection.auth.env)
    ) return false;
    if (
      (connection.auth.type === "bearer-stored" || connection.auth.type === "header-stored")
      && !storedSecretIds.has(connection.auth.secretId)
    ) return false;
    for (const header of connection.headers) {
      if (!nonemptyEnvironmentValue(environment, header.value.env)) return false;
    }
  }
  return true;
}

export function assertRuntimeDocumentSupported(
  document: SettingsDocumentV2,
  runtimeResolver: SettingsRuntimeResolver
): void {
  try {
    for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
      runtimeResolver.resolve({ document, purpose });
    }
  } catch (error) {
    throw invalidSettingsMutation(error);
  }
}

export const PLAINTEXT_PROVIDER_HTTPS_REMEDIATION =
  "Plain HTTP provider requests are unavailable on this release target; configure an authenticated HTTPS endpoint.";

/** Plaintext settings remain valid configuration so migration and editing do
 * not lose local-provider details. Only provider execution is unavailable. */
export function providerRequestTransportAvailable(
  effective: GenerationSettings
): boolean {
  const protocol = providerRuntimeFor(effective).protocol;
  if (protocol !== undefined && isSubscriptionProtocolV2(protocol)) return true;
  if (effective.provider === "dry-run") return true;
  const url = new URL(effective.baseUrl);
  const runtime = providerRuntimeFor(effective);
  const keyless = runtime.auth.type === "none";
  const hostClass = classifyHttpHost(effective.baseUrl);
  return url.protocol === "https:"
    || (
      url.protocol === "http:"
      && keyless
      && hostClass === "loopback"
      // The proof runs where it exists. Where it does not, the explicit
      // opt-in stands in for it, exactly as it does for a LAN address.
      && (ownedLoopbackHttpSupported() || runtime.allowInsecureHttp)
    )
    || (
      url.protocol === "http:"
      && keyless
      && (hostClass === "private-literal" || hostClass === "lan-hostname")
      && runtime.allowInsecureHttp
    );
}

/** Keep this check at every runtime/provider boundary, not at storage or Save. */
export function assertRuntimeGenerationSettingsSupported(
  effective: GenerationSettings
): void {
  if (!providerRequestTransportAvailable(effective)) {
    throw new SettingsFormatError(PLAINTEXT_PROVIDER_HTTPS_REMEDIATION);
  }
}

export async function defaultCandidateValidator(
  settings: GenerationSettings
): Promise<boolean> {
  const protocol = providerRuntimeFor(settings).protocol;
  if (protocol !== undefined && isSubscriptionProtocolV2(protocol)) return true;
  return (await checkModelServer(
    settings,
    undefined,
    { validateSuccessfulResponse: false }
  )).state === "ready";
}

function nonemptyEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  const match = process.platform === "win32"
    ? Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
    : name;
  if (match === undefined || !Object.hasOwn(environment, match)) return false;
  const value = environment[match];
  return typeof value === "string" && value.length > 0;
}
