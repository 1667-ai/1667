import {
  SETTINGS_ROUTE_PURPOSE_VALUES,
  type SettingsDocumentV2,
  type SettingsStateV2,
  type SettingsView
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { checkModelServer } from "./server-check.js";
import { ownedLoopbackHttpSupported } from "./provider-fetch.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { effectiveGenerationSettings } from "./settings-v2-conversion.js";
import { classifyHttpHost, SettingsFormatError } from "./settings-v2-scalars.js";
import { settingsStateRelation } from "./settings-v2-state-validation.js";
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
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: state.stateGeneration,
    activeRevision: effectiveActiveSettingsRevision(state),
    pendingRevision,
    document: shown,
    effective: effectiveGenerationSettings(activeSettingsDocument(state)),
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
  return settingsStateRelation(state) === "promoted"
    ? state.previousRevision!
    : state.activeRevision;
}

export function activeSettingsDocument(state: SettingsStateV2): SettingsDocumentV2 {
  return state.documents[String(effectiveActiveSettingsRevision(state))]!;
}

export function pendingSettingsDocument(state: SettingsStateV2): SettingsDocumentV2 {
  if (state.pendingRevision === null) throw corruptSettingsStateReceipt("pending document");
  return state.documents[String(state.pendingRevision)]!;
}

export function credentialReferencesResolve(
  document: SettingsDocumentV2,
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

export function assertRuntimeDocumentSupported(document: SettingsDocumentV2): void {
  try {
    for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
      effectiveGenerationSettings(document, purpose);
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
      && ownedLoopbackHttpSupported()
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
