import {
  hashSettingsDocumentV3,
  hashSettingsStateV3,
  parseSettingsDocumentV3Text,
  parseSettingsStateV3Text
} from "./settings-v3-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V3_HASH,
  INITIAL_SETTINGS_DOCUMENT_V3_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V3_TEXT,
  INITIAL_SETTINGS_STATE_V3_HASH,
  INITIAL_SETTINGS_STATE_V3_SHA256,
  INITIAL_SETTINGS_STATE_V3_TEXT
} from "./settings-v3-initial-vectors.js";

export {
  INITIAL_SETTINGS_DOCUMENT_V3_HASH,
  INITIAL_SETTINGS_DOCUMENT_V3_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V3_TEXT,
  INITIAL_SETTINGS_STATE_V3_HASH,
  INITIAL_SETTINGS_STATE_V3_SHA256,
  INITIAL_SETTINGS_STATE_V3_TEXT
} from "./settings-v3-initial-vectors.js";

export const INITIAL_SETTINGS_DOCUMENT_V3 = parseSettingsDocumentV3Text(INITIAL_SETTINGS_DOCUMENT_V3_TEXT);
export const INITIAL_SETTINGS_STATE_V3 = parseSettingsStateV3Text(INITIAL_SETTINGS_STATE_V3_TEXT);

if (hashSettingsDocumentV3(INITIAL_SETTINGS_DOCUMENT_V3) !== INITIAL_SETTINGS_DOCUMENT_V3_HASH) {
  throw new Error("Checked-in initial settings document v3 hash vector is stale");
}
if (hashSettingsStateV3(INITIAL_SETTINGS_STATE_V3) !== INITIAL_SETTINGS_STATE_V3_HASH) {
  throw new Error("Checked-in initial settings state v3 hash vector is stale");
}
