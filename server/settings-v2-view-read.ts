import type { CredentialStore } from "@earendil-works/pi-ai";
import type { SettingsView } from "../shared/settings-v2-types.js";
import { hashSettingsStateV2 } from "./settings-v2-codec.js";
import { INITIAL_SETTINGS_STATE_V2_HASH } from "./settings-v2-initial-vectors.js";
import { hashSettingsStateV5 } from "./settings-v5-codec.js";
import { INITIAL_SETTINGS_STATE_V5_HASH } from "./settings-v5-initial-vectors.js";
import { readSettingsStateSlot } from "./settings-state-file.js";
import type { SettingsStateSlot } from "./settings-state-slot.js";
import type { SettingsRuntimeResolver } from "./settings-runtime-resolver.js";
import { readSubscriptionAuthState } from "./subscription-runtime.js";
import { settingsViewFromSlot } from "./settings-v5-runtime.js";

/** Read the settings view and its machine-tier subscription presentation. */
export async function readSettingsView(
  dataDir: string,
  credentials: Pick<CredentialStore, "read">,
  runtimeResolver: SettingsRuntimeResolver
): Promise<SettingsView> {
  const slot = await readSettingsStateSlot(dataDir);
  const view = settingsViewFromSlot(slot, runtimeResolver);
  return {
    ...view,
    subscriptionAutoSelectEligible: exactInitialStateOwnedByThisRelease(slot),
    subscriptionAuth: await readSubscriptionAuthState(credentials)
  };
}

function exactInitialStateOwnedByThisRelease(slot: SettingsStateSlot): boolean {
  if (slot.kind === "v2") {
    return hashSettingsStateV2(slot.state) === INITIAL_SETTINGS_STATE_V2_HASH;
  }
  if (slot.kind === "v5") {
    return hashSettingsStateV5(slot.state) === INITIAL_SETTINGS_STATE_V5_HASH;
  }
  return false;
}
