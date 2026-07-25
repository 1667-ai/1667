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
import {
  corruptSettingsStateReceipt,
  invalidSettingsMutation
} from "./settings-v2-mutation.js";

export function settingsViewFromState(
  state: SettingsStateV2
): Extract<SettingsView, { dataFormat: 2 }> {
  const shown = state.pendingRevision === null
    ? activeSettingsDocument(state)
    : pendingSettingsDocument(state);
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: state.stateGeneration,
    activeRevision: state.activeRevision,
    pendingRevision: state.pendingRevision,
    document: shown,
    effective: effectiveGenerationSettings(activeSettingsDocument(state))
  };
}

export function activeSettingsDocument(state: SettingsStateV2): SettingsDocumentV2 {
  return state.documents[String(state.activeRevision)]!;
}

export function pendingSettingsDocument(state: SettingsStateV2): SettingsDocumentV2 {
  if (state.pendingRevision === null) throw corruptSettingsStateReceipt("pending document");
  return state.documents[String(state.pendingRevision)]!;
}

export function credentialReferencesResolve(
  document: SettingsDocumentV2,
  environment: NodeJS.ProcessEnv
): boolean {
  for (const connection of Object.values(document.connections)) {
    if (connection.auth.type !== "none"
      && !nonemptyEnvironmentValue(environment, connection.auth.env)) return false;
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
  return url.protocol === "https:"
    || (
      url.protocol === "http:"
      && effective.apiKeyEnv === null
      && classifyHttpHost(effective.baseUrl) === "loopback"
      && ownedLoopbackHttpSupported()
    )
    || (
      url.protocol === "http:"
      && effective.apiKeyEnv === null
      && classifyHttpHost(effective.baseUrl) === "private-literal"
      && providerRuntimeFor(effective).allowInsecureHttp
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
