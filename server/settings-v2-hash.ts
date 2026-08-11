import { createHash } from "node:crypto";
import type { Hash256 } from "./story-v6-types.js";
import { canonicalJson } from "./canonical-json.js";

export const SETTINGS_DOCUMENT_V2_HASH_DOMAIN = "settings-document-v2\0";
export const SETTINGS_STATE_V2_HASH_DOMAIN = "settings-state-v2\0";

/** Domain-separates a settings document from every other hashed kind, not
 *  one schema version from another: `schemaVersion` is part of the hashed
 *  canonical JSON itself, so a schema-2 and a schema-3 document already
 *  hash to different values under this one domain. Schema 3 reuses it
 *  (`server/settings-v3-state-validation.ts`) instead of carrying a
 *  byte-identical copy. */
export function hashCanonicalSettingsDocument<D>(document: D): Hash256 {
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
