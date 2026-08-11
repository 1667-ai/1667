import { createHash } from "node:crypto";
import type { SettingsDocumentV3 } from "../shared/settings-v2-types.js";
import type { Hash256 } from "./story-v6-types.js";
import { canonicalJson } from "./canonical-json.js";
import {
  SETTINGS_DOCUMENT_V2_HASH_DOMAIN,
  SETTINGS_STATE_V2_HASH_DOMAIN
} from "./settings-v2-hash.js";

/** Schema 3 reuses the settings-document and settings-state hash domains.
 *  They separate settings hashes from every other hashed kind in this
 *  codebase, not one schema version from another: `schemaVersion` is part
 *  of the hashed canonical JSON itself, so a schema-2 and a schema-3
 *  document already hash to different values under the same domain. */
export function hashCanonicalSettingsDocumentV3(document: SettingsDocumentV3): Hash256 {
  return hashSettingsBytes(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, Buffer.from(canonicalJson(document), "utf8"));
}

export function hashSettingsDocumentV3Bytes(bytes: Uint8Array): Hash256 {
  return hashSettingsBytes(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, bytes);
}

export function hashSettingsStateV3Bytes(bytes: Uint8Array): Hash256 {
  return hashSettingsBytes(SETTINGS_STATE_V2_HASH_DOMAIN, bytes);
}

function hashSettingsBytes(domain: string, bytes: Uint8Array): Hash256 {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest("hex");
}
