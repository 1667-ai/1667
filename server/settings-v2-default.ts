import {
  hashSettingsDocumentV2,
  hashSettingsStateV2,
  parseSettingsDocumentV2Text,
  parseSettingsStateV2Text
} from "./settings-v2-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2_HASH,
  INITIAL_SETTINGS_DOCUMENT_V2_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V2_TEXT,
  INITIAL_SETTINGS_STATE_V2_HASH,
  INITIAL_SETTINGS_STATE_V2_SHA256,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "./settings-v2-initial-vectors.js";

export {
  INITIAL_SETTINGS_DOCUMENT_V2_HASH,
  INITIAL_SETTINGS_DOCUMENT_V2_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V2_TEXT,
  INITIAL_SETTINGS_STATE_V2_HASH,
  INITIAL_SETTINGS_STATE_V2_SHA256,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "./settings-v2-initial-vectors.js";

export const INITIAL_SETTINGS_DOCUMENT_V2 = parseSettingsDocumentV2Text(INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
export const INITIAL_SETTINGS_STATE_V2 = parseSettingsStateV2Text(INITIAL_SETTINGS_STATE_V2_TEXT);

if (hashSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2) !== INITIAL_SETTINGS_DOCUMENT_V2_HASH) {
  throw new Error("Checked-in initial settings document hash vector is stale");
}
if (hashSettingsStateV2(INITIAL_SETTINGS_STATE_V2) !== INITIAL_SETTINGS_STATE_V2_HASH) {
  throw new Error("Checked-in initial settings state hash vector is stale");
}
