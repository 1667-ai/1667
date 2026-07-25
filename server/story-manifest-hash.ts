import { createHash } from "node:crypto";
import type { Hash256 } from "./story-v6-types.js";

export const STORY_V5_HASH_DOMAIN = "story-v5\0";
export const STORY_V6_HASH_DOMAIN = "story-v6\0";
export const MUTATION_STARTED_RECORD_HASH_DOMAIN = "mutation-started-v1\0";
export const MUTATION_PREPARED_RECORD_HASH_DOMAIN = "mutation-prepared-v1\0";

/** Hash exact authoritative V5 manifest bytes; this helper never parses or canonicalizes them. */
export function hashStoryV5ManifestBytes(bytes: Uint8Array): Hash256 {
  return hashDomainSeparatedBytes(STORY_V5_HASH_DOMAIN, bytes);
}

/** Hash exact canonical V6 manifest bytes; callers are responsible for canonical validation. */
export function hashStoryV6ManifestBytes(bytes: Uint8Array): Hash256 {
  return hashDomainSeparatedBytes(STORY_V6_HASH_DOMAIN, bytes);
}

/** Hash exact canonical started-record bytes; this helper never rewrites the record. */
export function hashMutationStartedRecordBytes(bytes: Uint8Array): Hash256 {
  return hashDomainSeparatedBytes(MUTATION_STARTED_RECORD_HASH_DOMAIN, bytes);
}

/** Hash exact canonical prepared-record bytes; this helper never rewrites the record. */
export function hashMutationPreparedRecordBytes(bytes: Uint8Array): Hash256 {
  return hashDomainSeparatedBytes(MUTATION_PREPARED_RECORD_HASH_DOMAIN, bytes);
}

function hashDomainSeparatedBytes(domain: string, bytes: Uint8Array): Hash256 {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest("hex");
}
