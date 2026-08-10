/** Fixed JCS bytes. Never rebuild these from mutable defaults.
 *
 * The exact migration of `INITIAL_SETTINGS_DOCUMENT_V2_TEXT`
 * (server/settings-v2-initial-vectors.ts) through
 * `convertSettingsDocumentV2ToV3` (server/settings-v3-conversion.ts): the
 * one `builtin:dry-run` model gains `imageInput: "unsupported"`, because its
 * connection uses the `dry-run` protocol. */
export const INITIAL_SETTINGS_DOCUMENT_V3_TEXT = "{\"connections\":{\"builtin:dry-run\":{\"auth\":{\"type\":\"none\"},\"baseUrl\":null,\"headers\":[],\"name\":\"Dry Run\",\"preset\":\"dry-run\",\"protocol\":\"dry-run\",\"timeouts\":{\"firstTokenMs\":1000,\"idleMs\":1000,\"responseHeaderMs\":1000,\"totalMs\":5000}}},\"models\":{\"builtin:dry-run\":{\"capabilities\":{\"assistantPrefill\":\"unsupported\",\"imageInput\":\"unsupported\",\"promptCaching\":\"unsupported\",\"reasoningEffort\":\"unsupported\",\"temperature\":\"supported\"},\"connectionId\":\"builtin:dry-run\",\"discovered\":{\"contextWindow\":32768},\"name\":\"Dry Run\",\"overrides\":{},\"remoteId\":\"dry-run\"}},\"profiles\":{\"default\":{\"cachePolicy\":\"off\",\"effort\":\"default\",\"maxOutputTokens\":2048,\"modelId\":\"builtin:dry-run\",\"name\":\"Default\",\"temperature\":0.8}},\"routing\":{\"default\":\"default\"},\"schemaVersion\":3,\"writing\":{\"defaultAuthorBrief\":\"Continue the story in its established voice.\"}}";

export const INITIAL_SETTINGS_STATE_V3_TEXT = "{\"activation\":null,\"activeRevision\":1,\"documents\":{\"1\":{\"connections\":{\"builtin:dry-run\":{\"auth\":{\"type\":\"none\"},\"baseUrl\":null,\"headers\":[],\"name\":\"Dry Run\",\"preset\":\"dry-run\",\"protocol\":\"dry-run\",\"timeouts\":{\"firstTokenMs\":1000,\"idleMs\":1000,\"responseHeaderMs\":1000,\"totalMs\":5000}}},\"models\":{\"builtin:dry-run\":{\"capabilities\":{\"assistantPrefill\":\"unsupported\",\"imageInput\":\"unsupported\",\"promptCaching\":\"unsupported\",\"reasoningEffort\":\"unsupported\",\"temperature\":\"supported\"},\"connectionId\":\"builtin:dry-run\",\"discovered\":{\"contextWindow\":32768},\"name\":\"Dry Run\",\"overrides\":{},\"remoteId\":\"dry-run\"}},\"profiles\":{\"default\":{\"cachePolicy\":\"off\",\"effort\":\"default\",\"maxOutputTokens\":2048,\"modelId\":\"builtin:dry-run\",\"name\":\"Default\",\"temperature\":0.8}},\"routing\":{\"default\":\"default\"},\"schemaVersion\":3,\"writing\":{\"defaultAuthorBrief\":\"Continue the story in its established voice.\"}}},\"lastActivationOutcome\":null,\"lastTransaction\":null,\"pendingRevision\":null,\"previousRevision\":null,\"schemaVersion\":3,\"settingsRevisionClock\":1,\"stateGeneration\":1}";

/** Domain-separated semantic hashes of the fixed canonical byte sequences. */
export const INITIAL_SETTINGS_DOCUMENT_V3_HASH =
  "25b00d2514e75886eeef172ccafa9e3305b1946b3d858e87e3fe5db0bbca86df" as const;
export const INITIAL_SETTINGS_STATE_V3_HASH =
  "1abbd6696d0fe171d8d14b792a485a8c34413029cf84a91cceefa0dc0d18af7d" as const;

/** Raw SHA-256 vectors make the exact checked-in bytes independently auditable. */
export const INITIAL_SETTINGS_DOCUMENT_V3_SHA256 =
  "f130318e0b432a743d275f493623adc0bc89fac57a1c87bd8a0fb733fd11b5a5" as const;
export const INITIAL_SETTINGS_STATE_V3_SHA256 =
  "94b405049feded1c1bbae6370f8791af2312dc12e96a4932dd4e93e9e814f9e0" as const;
