import type { CredentialStore } from "@earendil-works/pi-ai";
import type { SettingsView } from "../shared/settings-v2-types.js";
import type { SettingsStateV4 } from "../shared/settings-v4-types.js";
import { hashSettingsStateV2 } from "./settings-v2-codec.js";
import { INITIAL_SETTINGS_STATE_V2_HASH } from "./settings-v2-initial-vectors.js";
import { readSettingsStateSlot } from "./settings-state-file.js";
import {
  settingsStateSlotReadOnlyView,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import type { SettingsRuntimeResolver } from "./settings-runtime-resolver.js";
import { readSubscriptionAuthState } from "./subscription-runtime.js";
import { activeSettingsDocumentV4 } from "./settings-v4-state-validation.js";
import { settingsViewFromState } from "./settings-v2-runtime.js";

/** Read the settings view and its machine-tier subscription presentation. */
export async function readSettingsView(
  dataDir: string,
  credentials: Pick<CredentialStore, "read">,
  runtimeResolver: SettingsRuntimeResolver
): Promise<SettingsView> {
  const slot = await readSettingsStateSlot(dataDir);
  const view = slot.kind === "v4"
    ? settingsViewFromStateV4(slot.state, runtimeResolver)
    : settingsViewFromState(settingsStateSlotReadOnlyView(slot));
  return {
    ...view,
    subscriptionAutoSelectEligible: exactInitialStateOwnedByThisRelease(slot),
    subscriptionAuth: await readSubscriptionAuthState(credentials)
  };
}

/** Present successor settings without projecting their document into a
 * predecessor schema. The view is read-only because this release cannot
 * preserve schema-4 controls through its writer. */
function settingsViewFromStateV4(
  state: SettingsStateV4,
  runtimeResolver: SettingsRuntimeResolver
): Extract<SettingsView, { dataFormat: 1 }> {
  const document = activeSettingsDocumentV4(state);
  const effective = runtimeResolver.resolveV4({ document }).settings;
  const effectiveProseRuntime = runtimeResolver.resolveV4({ document, purpose: "prose" });
  return {
    dataFormat: 1,
    editable: false,
    readOnlyReason: "successor-schema",
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective,
    effectiveProse: effectiveProseRuntime.settings,
    effectiveProseReasoning: effectiveProseRuntime.route.reasoning,
    effectiveProseContinuationPromptLayout: effectiveProseRuntime.providerRuntime.continuationPromptLayout
      ?? "compatibility",
    lastActivationOutcome: null
  };
}

/** A successor-owned slot must not be inferred from its downgraded view. */
function exactInitialStateOwnedByThisRelease(slot: SettingsStateSlot): boolean {
  return slot.kind === "v2"
    && hashSettingsStateV2(slot.state) === INITIAL_SETTINGS_STATE_V2_HASH;
}
