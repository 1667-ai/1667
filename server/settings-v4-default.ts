import {
  hashSettingsDocumentV4,
  hashSettingsStateV4,
  parseSettingsDocumentV4Text,
  parseSettingsStateV4Text
} from "./settings-v4-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4_HASH,
  INITIAL_SETTINGS_DOCUMENT_V4_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V4_TEXT,
  INITIAL_SETTINGS_STATE_V4_HASH,
  INITIAL_SETTINGS_STATE_V4_SHA256,
  INITIAL_SETTINGS_STATE_V4_TEXT
} from "./settings-v4-initial-vectors.js";

export {
  INITIAL_SETTINGS_DOCUMENT_V4_HASH,
  INITIAL_SETTINGS_DOCUMENT_V4_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V4_TEXT,
  INITIAL_SETTINGS_STATE_V4_HASH,
  INITIAL_SETTINGS_STATE_V4_SHA256,
  INITIAL_SETTINGS_STATE_V4_TEXT
} from "./settings-v4-initial-vectors.js";

export const INITIAL_SETTINGS_DOCUMENT_V4 = parseSettingsDocumentV4Text(INITIAL_SETTINGS_DOCUMENT_V4_TEXT);
export const INITIAL_SETTINGS_STATE_V4 = parseSettingsStateV4Text(INITIAL_SETTINGS_STATE_V4_TEXT);

if (hashSettingsDocumentV4(INITIAL_SETTINGS_DOCUMENT_V4) !== INITIAL_SETTINGS_DOCUMENT_V4_HASH) {
  throw new Error("Checked-in initial settings document v4 hash vector is stale");
}
if (hashSettingsStateV4(INITIAL_SETTINGS_STATE_V4) !== INITIAL_SETTINGS_STATE_V4_HASH) {
  throw new Error("Checked-in initial settings state v4 hash vector is stale");
}
