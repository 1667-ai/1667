import { createHash } from "node:crypto";
import type { Hash256 } from "./story-v6-types.js";
import { canonicalJson } from "./canonical-json.js";
import type { CredentialBearingSettingsDocument } from "../shared/settings-credential-slots.js";

export const SETTINGS_DOCUMENT_V2_HASH_DOMAIN = "settings-document-v2\0";
export const SETTINGS_STATE_V2_HASH_DOMAIN = "settings-state-v2\0";

/** Domain-separates a settings document from every other hashed kind, not
 *  one schema version from another: `schemaVersion` is part of the hashed
 *  canonical JSON itself, so a schema-2 and a schema-3 document already
 *  hash to different values under this one domain. Schema 3 reuses it
 *  (`server/settings-v3-state-validation.ts`) instead of carrying a
 *  byte-identical copy. The `CredentialBearingSettingsDocument` bound stops
 *  a value of some other kind, for example a story manifest or a bare
 *  string, from hashing under this settings-document domain. */
export function hashCanonicalSettingsDocument<D extends CredentialBearingSettingsDocument>(
  document: D
): Hash256 {
  return hashSettingsBytes(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, Buffer.from(canonicalJson(document), "utf8"));
}

/** Version-free: schema 2 and schema 3 both format to bytes first, then hash
 *  those bytes through this one function. See `hashCanonicalSettingsDocument`
 *  above for why the domain itself does not need a version in its name. */
export function hashSettingsDocumentBytes(bytes: Uint8Array): Hash256 {
  return hashSettingsBytes(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, bytes);
}

/** Version-free in the same way as `hashSettingsDocumentBytes`, for a
 *  formatted settings-state envelope instead of a document. */
export function hashSettingsStateBytes(bytes: Uint8Array): Hash256 {
  return hashSettingsBytes(SETTINGS_STATE_V2_HASH_DOMAIN, bytes);
}

function hashSettingsBytes(domain: string, bytes: Uint8Array): Hash256 {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest("hex");
}
