import { createHash } from "node:crypto";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import type { Hash256 } from "./story-v6-types.js";
import { canonicalJson } from "./canonical-json.js";

export const SETTINGS_DOCUMENT_V2_HASH_DOMAIN = "settings-document-v2\0";
export const SETTINGS_STATE_V2_HASH_DOMAIN = "settings-state-v2\0";

export function hashCanonicalSettingsDocumentV2(document: SettingsDocumentV2): Hash256 {
  return hashSettingsBytes(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, Buffer.from(canonicalJson(document), "utf8"));
}

export function hashSettingsDocumentV2Bytes(bytes: Uint8Array): Hash256 {
  return hashSettingsBytes(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, bytes);
}

export function hashSettingsStateV2Bytes(bytes: Uint8Array): Hash256 {
  return hashSettingsBytes(SETTINGS_STATE_V2_HASH_DOMAIN, bytes);
}

function hashSettingsBytes(domain: string, bytes: Uint8Array): Hash256 {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest("hex");
}
