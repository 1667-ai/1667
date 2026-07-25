/** Fixed JCS bytes. Never rebuild these from mutable defaults. */
export const INITIAL_SETTINGS_DOCUMENT_V2_TEXT = "{\"connections\":{\"builtin:dry-run\":{\"auth\":{\"type\":\"none\"},\"baseUrl\":null,\"headers\":[],\"name\":\"Dry Run\",\"preset\":\"dry-run\",\"protocol\":\"dry-run\",\"timeouts\":{\"firstTokenMs\":1000,\"idleMs\":1000,\"responseHeaderMs\":1000,\"totalMs\":5000}}},\"models\":{\"builtin:dry-run\":{\"capabilities\":{\"assistantPrefill\":\"unsupported\",\"promptCaching\":\"unsupported\",\"reasoningEffort\":\"unsupported\",\"temperature\":\"supported\"},\"connectionId\":\"builtin:dry-run\",\"discovered\":{\"contextWindow\":32768},\"name\":\"Dry Run\",\"overrides\":{},\"remoteId\":\"dry-run\"}},\"profiles\":{\"default\":{\"cachePolicy\":\"off\",\"effort\":\"default\",\"maxOutputTokens\":2048,\"modelId\":\"builtin:dry-run\",\"name\":\"Default\",\"temperature\":0.8}},\"routing\":{\"default\":\"default\"},\"schemaVersion\":2,\"writing\":{\"defaultAuthorBrief\":\"Continue the story in its established voice.\"}}";

export const INITIAL_SETTINGS_STATE_V2_TEXT = "{\"activation\":null,\"activeRevision\":1,\"documents\":{\"1\":{\"connections\":{\"builtin:dry-run\":{\"auth\":{\"type\":\"none\"},\"baseUrl\":null,\"headers\":[],\"name\":\"Dry Run\",\"preset\":\"dry-run\",\"protocol\":\"dry-run\",\"timeouts\":{\"firstTokenMs\":1000,\"idleMs\":1000,\"responseHeaderMs\":1000,\"totalMs\":5000}}},\"models\":{\"builtin:dry-run\":{\"capabilities\":{\"assistantPrefill\":\"unsupported\",\"promptCaching\":\"unsupported\",\"reasoningEffort\":\"unsupported\",\"temperature\":\"supported\"},\"connectionId\":\"builtin:dry-run\",\"discovered\":{\"contextWindow\":32768},\"name\":\"Dry Run\",\"overrides\":{},\"remoteId\":\"dry-run\"}},\"profiles\":{\"default\":{\"cachePolicy\":\"off\",\"effort\":\"default\",\"maxOutputTokens\":2048,\"modelId\":\"builtin:dry-run\",\"name\":\"Default\",\"temperature\":0.8}},\"routing\":{\"default\":\"default\"},\"schemaVersion\":2,\"writing\":{\"defaultAuthorBrief\":\"Continue the story in its established voice.\"}}},\"lastActivationOutcome\":null,\"lastTransaction\":null,\"pendingRevision\":null,\"previousRevision\":null,\"schemaVersion\":2,\"settingsRevisionClock\":1,\"stateGeneration\":1}";

/** Domain-separated semantic hashes of the fixed canonical byte sequences. */
export const INITIAL_SETTINGS_DOCUMENT_V2_HASH =
  "11657ea1b0c88aaf320273168c8863d409728f6c2eee860d38bc5b0f95421771" as const;
export const INITIAL_SETTINGS_STATE_V2_HASH =
  "5ec9bbba748ba710ab9e5cc8ea615bf37e89f52ddd926003e9ef3af352c7482c" as const;

/** Raw SHA-256 vectors make the exact checked-in bytes independently auditable. */
export const INITIAL_SETTINGS_DOCUMENT_V2_SHA256 =
  "29718d39c33bd620e64a7aed11c40296420d0f0ff6609a7602f48676bb9376d3" as const;
export const INITIAL_SETTINGS_STATE_V2_SHA256 =
  "c119da7f21cf983494a68b6c0eac688e5f7b3efc78412ce3b2e714701e44e48d" as const;
