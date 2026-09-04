export interface AbsentStoryAggregateVersion {
  readonly kind: "absent";
}

export interface V5StoryAggregateVersion {
  readonly kind: "v5";
  readonly manifestHash: string;
}

export interface V6StoryAggregateVersion {
  readonly kind: "v6";
  readonly revision: string;
}

export type StoryAggregateVersion =
  | AbsentStoryAggregateVersion
  | V5StoryAggregateVersion
  | V6StoryAggregateVersion;

const HASH_256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_20_PATTERN = /^[0-9]{20}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export function parseStoryAggregateVersion(
  value: unknown,
  label = "story aggregate version"
): StoryAggregateVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "absent") {
    requireExactKeys(record, ["kind"], label);
    return { kind: "absent" };
  }
  if (record.kind === "v5") {
    requireExactKeys(record, ["kind", "manifestHash"], label);
    if (typeof record.manifestHash !== "string"
      || !HASH_256_PATTERN.test(record.manifestHash)) {
      throw new Error(`${label}.manifestHash is invalid`);
    }
    return { kind: "v5", manifestHash: record.manifestHash };
  }
  if (record.kind === "v6") {
    requireExactKeys(record, ["kind", "revision"], label);
    if (typeof record.revision !== "string"
      || !REVISION_20_PATTERN.test(record.revision)
      || BigInt(record.revision) === 0n
      || BigInt(record.revision) > UINT64_MAX) {
      throw new Error(`${label}.revision is invalid`);
    }
    return { kind: "v6", revision: record.revision };
  }
  throw new Error(`${label}.kind must be absent, v5, or v6`);
}

export function assertStoryAggregateVersion(
  value: unknown,
  label = "story aggregate version"
): asserts value is StoryAggregateVersion {
  parseStoryAggregateVersion(value, label);
}

/** Return whether `candidate` is known not to predate `current`. V6 revisions
 * are ordered. V5 hashes have no ordering, so different hashes are treated as
 * incomparable and never replace one another. */
export function storyAggregateVersionIsAtLeast(
  candidate: StoryAggregateVersion,
  current: StoryAggregateVersion
): boolean {
  if (candidate.kind === "v6" && current.kind === "v6") {
    return BigInt(candidate.revision) >= BigInt(current.revision);
  }
  if (candidate.kind === "v6") return current.kind !== "v6";
  if (current.kind === "v6") return false;
  if (candidate.kind === "v5" && current.kind === "v5") {
    return candidate.manifestHash === current.manifestHash;
  }
  return current.kind === "absent";
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}
