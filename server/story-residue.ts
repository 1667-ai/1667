import { createHash } from "node:crypto";
import { canonicalJson, decodeCanonicalUtf8 } from "./canonical-json.js";
import { StoryFormatError } from "./story-format-facts.js";
import { storyIdForMutation } from "./story-identity.js";
import { isStoryId } from "./story-v5-strict.js";
import { V6_MUTATION_ID_PATTERN } from "./story-v6-scalars.js";

export { isStoryId } from "./story-v5-strict.js";

export const STORY_CREATE_RESIDUE_PREFIX = ".1667-story-create-";
export const STORY_REAP_RESIDUE_PREFIX = ".1667-story-reap-";
export const STORY_RESIDUE_HASH_VERSION = "h1";
export const STORY_RESIDUE_IDENTITY_SUFFIX = ".identity";
export const STORY_RESIDUE_IDENTITY_TEMP_SUFFIX = ".identity.tmp";
export const MAX_STORY_RESIDUE_IDENTITY_BYTES = 1_024;
const STORY_RESERVED_PREFIX = ".1667-story-";
const STORY_RESIDUE_HASH_DOMAIN = "story-residue-v1\0";
const STORY_RESIDUE_HASH_MARKER = `${STORY_RESIDUE_HASH_VERSION}_`;
const RESIDUE_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export type StoryResidueKind = "create" | "reap";

export interface StoryDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type StoryResidueIdentityKind = "story-create-reservation" | "story-reap-reservation";

export interface StoryResidueIdentity {
  schema: 1;
  kind: StoryResidueIdentityKind;
  storyId: string;
  token: string;
  mutationId: string;
}

export type ClassifiedStoryEntry =
  | { kind: "canonical-story"; storyId: string }
  | { kind: "story-residue"; residueKind: StoryResidueKind; storyId: string }
  | { kind: "hashed-story-residue"; residueKind: StoryResidueKind; token: string }
  | {
      kind: "story-residue-identity";
      residueKind: StoryResidueKind;
      token: string;
      phase: "final" | "temporary";
    }
  | { kind: "unrelated" };

/** Classify one catalog entry without opening known successor residue. */
export function classifyStoryEntry(entry: StoryDirectoryEntry): ClassifiedStoryEntry {
  if (entry.name.startsWith(STORY_RESERVED_PREFIX)) {
    const residue = parseResidueName(entry.name);
    if (residue === null) throw malformedResidue(entry.name);
    if (residue.naming === "identity") {
      if (entry.isDirectory() || !entry.isFile()) {
        throw new StoryFormatError(`Story residue identity is not a regular file: ${entry.name}`);
      }
      return {
        kind: "story-residue-identity",
        residueKind: residue.residueKind,
        token: residue.token,
        phase: residue.phase
      };
    }
    if (!entry.isDirectory()) {
      throw new StoryFormatError(`Story ${residue.residueKind} residue is not a directory: ${entry.name}`);
    }
    return residue.naming === "hashed"
      ? { kind: "hashed-story-residue", residueKind: residue.residueKind, token: residue.token }
      : { kind: "story-residue", residueKind: residue.residueKind, storyId: residue.storyId };
  }

  if (!isStoryId(entry.name)) return { kind: "unrelated" };
  if (!entry.isDirectory()) {
    throw new StoryFormatError(`Canonical story entry is not a directory: ${entry.name}`);
  }
  return { kind: "canonical-story", storyId: entry.name };
}

/** Canonical bounded sibling names let direct lookup probe residue without a scan. */
export function storyResidueNames(storyId: string): Readonly<Record<StoryResidueKind, string>> {
  requireStoryId(storyId);
  return {
    create: hashedResidueName("create", storyId),
    reap: hashedResidueName("reap", storyId)
  };
}

export function storyResidueIdentityName(kind: StoryResidueKind, storyId: string): string {
  return `${storyResidueNames(storyId)[kind]}${STORY_RESIDUE_IDENTITY_SUFFIX}`;
}

export function storyResidueIdentityTempName(kind: StoryResidueKind, storyId: string): string {
  return `${storyResidueNames(storyId)[kind]}${STORY_RESIDUE_IDENTITY_TEMP_SUFFIX}`;
}

export function storyResidueToken(kind: StoryResidueKind, storyId: string): string {
  requireStoryId(storyId);
  return createHash("sha256")
    .update(STORY_RESIDUE_HASH_DOMAIN, "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(storyId, "utf8")
    .digest("hex");
}

export function formatStoryResidueIdentity(record: StoryResidueIdentity): string {
  validateResidueIdentity(record, { storyId: record.storyId, residueKind: kindFromIdentity(record.kind) });
  return canonicalJson(record);
}

export function parseStoryResidueIdentityBytes(
  bytes: Uint8Array,
  expected?: { storyId: string; residueKind: StoryResidueKind }
): StoryResidueIdentity {
  if (expected !== undefined) requireStoryId(expected.storyId);
  if (bytes.byteLength > MAX_STORY_RESIDUE_IDENTITY_BYTES) {
    throw new StoryFormatError(
      `Story residue identity exceeds its ${MAX_STORY_RESIDUE_IDENTITY_BYTES}-byte size limit`
    );
  }
  const label = expected === undefined ? "story residue identity" : `story ${expected.storyId} residue identity`;
  const text = decodeCanonicalUtf8(bytes, label);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new StoryFormatError(`Invalid ${label} JSON`, { cause: error });
  }
  const record = validateResidueIdentity(value, expected);
  if (canonicalJson(record) !== text) {
    throw new StoryFormatError(`${label} is not canonical JSON`);
  }
  return record;
}

/** P1's already-frozen direct-ID names remain valid rollback probes. */
export function legacyStoryResidueNames(storyId: string): Readonly<Record<StoryResidueKind, string>> {
  requireStoryId(storyId);
  return {
    create: `${STORY_CREATE_RESIDUE_PREFIX}${storyId}`,
    reap: `${STORY_REAP_RESIDUE_PREFIX}${storyId}`
  };
}

function parseResidueName(
  name: string
):
  | { naming: "legacy"; residueKind: StoryResidueKind; storyId: string }
  | { naming: "hashed"; residueKind: StoryResidueKind; token: string }
  | {
      naming: "identity";
      residueKind: StoryResidueKind;
      token: string;
      phase: "final" | "temporary";
    }
  | null {
  const candidates = [
    ["create", STORY_CREATE_RESIDUE_PREFIX],
    ["reap", STORY_REAP_RESIDUE_PREFIX]
  ] as const;
  for (const [residueKind, prefix] of candidates) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (suffix.startsWith(STORY_RESIDUE_HASH_MARKER)) {
      const hashedSuffix = suffix.slice(STORY_RESIDUE_HASH_MARKER.length);
      if (hashedSuffix.endsWith(STORY_RESIDUE_IDENTITY_TEMP_SUFFIX)) {
        const token = hashedSuffix.slice(0, -STORY_RESIDUE_IDENTITY_TEMP_SUFFIX.length);
        return RESIDUE_TOKEN_PATTERN.test(token)
          ? { naming: "identity", residueKind, token, phase: "temporary" }
          : null;
      }
      if (hashedSuffix.endsWith(STORY_RESIDUE_IDENTITY_SUFFIX)) {
        const token = hashedSuffix.slice(0, -STORY_RESIDUE_IDENTITY_SUFFIX.length);
        return RESIDUE_TOKEN_PATTERN.test(token)
          ? { naming: "identity", residueKind, token, phase: "final" }
          : null;
      }
      const token = hashedSuffix;
      return RESIDUE_TOKEN_PATTERN.test(token)
        ? { naming: "hashed", residueKind, token }
        : null;
    }
    return isStoryId(suffix) ? { naming: "legacy", residueKind, storyId: suffix } : null;
  }
  return null;
}

function hashedResidueName(kind: StoryResidueKind, storyId: string): string {
  const token = storyResidueToken(kind, storyId);
  const prefix = kind === "create" ? STORY_CREATE_RESIDUE_PREFIX : STORY_REAP_RESIDUE_PREFIX;
  return `${prefix}${STORY_RESIDUE_HASH_MARKER}${token}`;
}

function validateResidueIdentity(
  value: unknown,
  expected?: { storyId: string; residueKind: StoryResidueKind }
): StoryResidueIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryFormatError("Story residue identity must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["kind", "mutationId", "schema", "storyId", "token"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new StoryFormatError("Story residue identity has unknown or missing keys");
  }
  if (
    record.schema !== 1
    || (record.kind !== "story-create-reservation" && record.kind !== "story-reap-reservation")
  ) {
    throw new StoryFormatError("Story residue identity has invalid schema or kind");
  }
  if (typeof record.storyId !== "string" || !isStoryId(record.storyId)) {
    throw new StoryFormatError("Story residue identity storyId is invalid");
  }
  const storyId = record.storyId;
  const residueKind = kindFromIdentity(record.kind);
  if (expected !== undefined && (storyId !== expected.storyId || residueKind !== expected.residueKind)) {
    throw new StoryFormatError("Story residue identity does not match the expected story and kind");
  }
  const expectedToken = storyResidueToken(residueKind, storyId);
  if (record.token !== expectedToken) throw new StoryFormatError("Story residue identity token does not match");
  if (typeof record.mutationId !== "string" || !V6_MUTATION_ID_PATTERN.test(record.mutationId)) {
    throw new StoryFormatError("Story residue identity mutationId is invalid");
  }
  if (residueKind === "create" && storyIdForMutation(record.mutationId) !== storyId) {
    throw new StoryFormatError("Story create residue identity does not match its mutation ID");
  }
  return {
    schema: 1,
    kind: record.kind,
    storyId,
    token: expectedToken,
    mutationId: record.mutationId
  };
}

function kindFromIdentity(kind: StoryResidueIdentityKind): StoryResidueKind {
  return kind === "story-create-reservation" ? "create" : "reap";
}

function requireStoryId(storyId: string): void {
  if (!isStoryId(storyId)) throw new StoryFormatError(`Invalid story id: ${storyId}`);
}

function malformedResidue(name: string): StoryFormatError {
  return new StoryFormatError(`Malformed reserved story residue: ${name}`);
}
