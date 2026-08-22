import {
  hashSettingsDocumentV5,
  hashSettingsStateV5,
  parseSettingsDocumentV5Text,
  parseSettingsStateV5Text
} from "./settings-v5-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V5_HASH,
  INITIAL_SETTINGS_DOCUMENT_V5_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V5_TEXT,
  INITIAL_SETTINGS_STATE_V5_HASH,
  INITIAL_SETTINGS_STATE_V5_SHA256,
  INITIAL_SETTINGS_STATE_V5_TEXT
} from "./settings-v5-initial-vectors.js";

export {
  INITIAL_SETTINGS_DOCUMENT_V5_HASH,
  INITIAL_SETTINGS_DOCUMENT_V5_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V5_TEXT,
  INITIAL_SETTINGS_STATE_V5_HASH,
  INITIAL_SETTINGS_STATE_V5_SHA256,
  INITIAL_SETTINGS_STATE_V5_TEXT
} from "./settings-v5-initial-vectors.js";

export const INITIAL_SETTINGS_DOCUMENT_V5 = parseSettingsDocumentV5Text(INITIAL_SETTINGS_DOCUMENT_V5_TEXT);
export const INITIAL_SETTINGS_STATE_V5 = parseSettingsStateV5Text(INITIAL_SETTINGS_STATE_V5_TEXT);

if (hashSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5) !== INITIAL_SETTINGS_DOCUMENT_V5_HASH) {
  throw new Error("Checked-in initial settings document v5 hash vector is stale");
}
if (hashSettingsStateV5(INITIAL_SETTINGS_STATE_V5) !== INITIAL_SETTINGS_STATE_V5_HASH) {
  throw new Error("Checked-in initial settings state v5 hash vector is stale");
}
