import type { SettingsView } from "../shared/settings-v2-types.js";
import { hashSettingsStateV2 } from "./settings-v2-codec.js";
import { INITIAL_SETTINGS_STATE_V2_HASH } from "./settings-v2-initial-vectors.js";
import { readSettingsStateSlot } from "./settings-state-file.js";
import {
  settingsStateSlotReadOnlyView,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import {
  readSubscriptionAuthState,
  type SubscriptionRuntimeDependencies
} from "./subscription-runtime.js";
import { settingsViewFromState } from "./settings-v2-runtime.js";

/** Read the settings view and its machine-tier subscription presentation. */
export async function readSettingsView(
  dataDir: string,
  subscription: SubscriptionRuntimeDependencies
): Promise<SettingsView> {
  const slot = await readSettingsStateSlot(dataDir);
  const view = settingsViewFromState(
    settingsStateSlotReadOnlyView(slot),
    subscription
  );
  return {
    ...view,
    subscriptionAutoSelectEligible: exactInitialStateOwnedByThisRelease(slot),
    subscriptionAuth: await readSubscriptionAuthState(subscription.credentials)
  };
}

/** A successor-owned slot must not be inferred from its downgraded view. */
function exactInitialStateOwnedByThisRelease(slot: SettingsStateSlot): boolean {
  return slot.kind === "v2"
    && hashSettingsStateV2(slot.state) === INITIAL_SETTINGS_STATE_V2_HASH;
}
