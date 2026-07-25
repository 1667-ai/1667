import { createHash } from "node:crypto";
import {
  mutationUtcDay,
  requireFm1Key,
  requireLedgerStoryId,
  requireLogicalAggregateKey,
  requireMutationId,
  storyIdFromAggregateKey,
  MutationLedgerFormatError
} from "./mutation-ledger-scalars.js";
import type { Fm1Key, LogicalAggregateKey, MutationId, StoryId } from "./mutation-ledger-types.js";

export const MUTATION_LEDGER_DIRECTORY = ".1667-mutations";
export const PORTABLE_PATH_SEGMENT_BYTES = 255;

export type UserMutationLedgerSegments =
  | readonly ["settings", "user", string, string, MutationId]
  | readonly ["stories", string, "user", string, string, MutationId];

export type InternalMutationLedgerSegments = readonly ["settings", "internal", string];
export type MutationLedgerSegments = UserMutationLedgerSegments | InternalMutationLedgerSegments;

export type MutationLedgerLocator =
  | {
      readonly kind: "user";
      readonly aggregateKey: LogicalAggregateKey;
      readonly mutationId: MutationId;
      readonly segments: UserMutationLedgerSegments;
    }
  | {
      readonly kind: "format-migration-v1";
      readonly aggregateKey: "settings";
      readonly key: Fm1Key;
      readonly segments: InternalMutationLedgerSegments;
    };

/** Relative, already-validated segments under `.1667-mutations`. */
export function userMutationLedgerSegments(
  aggregateKeyValue: unknown,
  mutationIdValue: unknown
): UserMutationLedgerSegments {
  const aggregateKey = requireLogicalAggregateKey(aggregateKeyValue);
  const mutationId = requireMutationId(mutationIdValue);
  const day = mutationUtcDay(mutationId);
  const shard = createHash("sha256").update(mutationId, "utf8").digest("hex").slice(0, 2);
  const storyId = storyIdFromAggregateKey(aggregateKey);
  const segments: UserMutationLedgerSegments = storyId === null
    ? ["settings", "user", day, shard, mutationId]
    : ["stories", storyLedgerToken(storyId), "user", day, shard, mutationId];
  validateSegments(segments);
  return Object.freeze(segments);
}

/** Relative, already-validated segments under `.1667-mutations`. */
export function formatMigrationLedgerSegments(keyValue: unknown): InternalMutationLedgerSegments {
  const key = requireFm1Key(keyValue);
  const digest = key.slice("fm1:".length);
  const segments = ["settings", "internal", `fm1-${digest}`] as const;
  validateSegments(segments);
  return Object.freeze(segments);
}

export function parseMutationLedgerSegments(
  value: readonly unknown[],
  expectedAggregateKeyValue: unknown
): MutationLedgerLocator {
  if (!Array.isArray(value)) throw new MutationLedgerFormatError("Mutation ledger path must be segment array");
  if (value.length !== 3 && value.length !== 5 && value.length !== 6) {
    throw new MutationLedgerFormatError("Mutation ledger path shape is invalid");
  }
  const segments: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new MutationLedgerFormatError(`Mutation ledger path segment ${index} is missing`);
    }
    segments.push(requirePortableSegment(value[index], index));
  }
  const expectedAggregateKey = requireLogicalAggregateKey(expectedAggregateKeyValue, "expectedAggregateKey");

  if (segments.length === 3 && segments[0] === "settings" && segments[1] === "internal") {
    if (expectedAggregateKey !== "settings") {
      throw new MutationLedgerFormatError("Internal ledger path does not match its expected aggregate");
    }
    const physicalKey = segments[2]!;
    if (!physicalKey.startsWith("fm1-")) throw new MutationLedgerFormatError("Internal ledger key is invalid");
    const key = requireFm1Key(`fm1:${physicalKey.slice("fm1-".length)}`);
    const expected = formatMigrationLedgerSegments(key);
    requireExactSegments(segments, expected);
    return Object.freeze({ kind: "format-migration-v1", aggregateKey: "settings", key, segments: expected });
  }

  let aggregateKey: LogicalAggregateKey;
  let mutationId: MutationId;
  if (segments.length === 5 && segments[0] === "settings" && segments[1] === "user") {
    aggregateKey = "settings";
    mutationId = requireMutationId(segments[4]);
  } else if (segments.length === 6 && segments[0] === "stories" && segments[2] === "user") {
    if (expectedAggregateKey === "settings") {
      throw new MutationLedgerFormatError("Story ledger path does not match its expected aggregate");
    }
    const storyId = requireLedgerStoryId(
      expectedAggregateKey.slice("story:".length),
      "expected story aggregate"
    );
    if (segments[1] !== storyLedgerToken(storyId)) {
      throw new MutationLedgerFormatError("Story ledger token does not match its expected aggregate");
    }
    aggregateKey = expectedAggregateKey;
    mutationId = requireMutationId(segments[5]);
  } else {
    throw new MutationLedgerFormatError("Mutation ledger path shape is invalid");
  }

  if (aggregateKey !== expectedAggregateKey) {
    throw new MutationLedgerFormatError("Mutation ledger path does not match its expected aggregate");
  }

  const expected = userMutationLedgerSegments(aggregateKey, mutationId);
  requireExactSegments(segments, expected);
  return Object.freeze({ kind: "user", aggregateKey, mutationId, segments: expected });
}

export function storyLedgerToken(storyIdValue: unknown): string {
  const storyId = requireLedgerStoryId(storyIdValue, "storyId");
  return `h1-${createHash("sha256")
    .update("mutation-ledger-story-v1\0", "utf8")
    .update(storyId, "utf8")
    .digest("hex")}`;
}

function validateSegments(segments: readonly string[]): void {
  segments.forEach((segment, index) => requirePortableSegment(segment, index));
}

function requirePortableSegment(value: unknown, index: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MutationLedgerFormatError(`Mutation ledger path segment ${index} is invalid`);
  }
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes(":")) {
    throw new MutationLedgerFormatError(`Mutation ledger path segment ${index} is not portable`);
  }
  if (Buffer.byteLength(value, "utf8") > PORTABLE_PATH_SEGMENT_BYTES) {
    throw new MutationLedgerFormatError(`Mutation ledger path segment ${index} exceeds 255 bytes`);
  }
  return value;
}

function requireExactSegments(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((segment, index) => segment !== expected[index])) {
    throw new MutationLedgerFormatError("Mutation ledger path does not match its encoded identity");
  }
}
