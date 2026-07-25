import type { SettingsStateV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import type { Fm1Key } from "./mutation-ledger-types.js";
import { parseSettingsStateV2 } from "./settings-v2-codec.js";
import { convertGenerationSettingsV1 } from "./settings-v2-conversion.js";

/**
 * Build Release B's first format-2 authority. The migration pointer makes this
 * distinct from fresh-directory initialization even when the v1 source is the
 * frozen absent default.
 */
export function settingsFormatMigrationV1State(
  source: GenerationSettings,
  key: Fm1Key
): SettingsStateV2 {
  return parseSettingsStateV2({
    schemaVersion: 2,
    stateGeneration: 1,
    settingsRevisionClock: 1,
    documents: {
      "1": convertGenerationSettingsV1(source)
    },
    activeRevision: 1,
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: null,
    lastTransaction: {
      receiptKind: "format-migration-v1",
      key,
      phase: "prepared"
    }
  });
}
