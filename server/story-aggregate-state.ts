import { ServiceError } from "./errors.js";
import {
  hashStoryV5ManifestBytes,
  hashStoryV6ManifestBytes
} from "./story-manifest-hash.js";
import type {
  StoryAggregateVersion
} from "./mutation-coordinator.js";
import type {
  RecoveryStoryStateProjection
} from "./mutation-ledger-types.js";
import type {
  StoredStorySlot
} from "./story-storage-reader.js";
import {
  storySummaryV6FromContent
} from "./story-v6-codec.js";
import { REVISION_ONE } from "./story-v6-scalars.js";
import type {
  Hash256,
  StoryManifestV6
} from "./story-v6-types.js";

type PersistedStorySlot = Extract<
  StoredStorySlot,
  { kind: "v5" | "v6-live" | "v6-deleted" }
>;

export interface StoryAggregateSnapshot {
  readonly storageKind: "v5" | "v6";
  readonly manifest: StoryManifestV6;
  readonly manifestHash: Hash256;
  readonly projection: RecoveryStoryStateProjection;
  readonly source: PersistedStorySlot;
}

export function storyAggregateSnapshot(
  slot: PersistedStorySlot
): StoryAggregateSnapshot {
  if (slot.kind === "v5") {
    const manifestHash = hashStoryV5ManifestBytes(slot.manifestBytes);
    const manifest: StoryManifestV6 = {
      format: "1667-story",
      schemaVersion: 6,
      kind: "live",
      id: slot.manifest.id,
      revision: REVISION_ONE,
      previousManifestHash: null,
      content: slot.manifest,
      summary: storySummaryV6FromContent(slot.manifest),
      unresolvedProvider: null,
      lastTransaction: null
    };
    return {
      storageKind: "v5",
      manifest,
      manifestHash,
      projection: storyProjection(manifest),
      source: slot
    };
  }
  const manifestHash = hashStoryV6ManifestBytes(slot.manifestBytes);
  return {
    storageKind: "v6",
    manifest: slot.manifest,
    manifestHash,
    projection: storyProjection(slot.manifest),
    source: slot
  };
}

export function requireExpectedStoryVersion(
  snapshot: StoryAggregateSnapshot,
  expected: StoryAggregateVersion
): void {
  if (!matchesExpectedStoryVersion(snapshot, expected)) throwRevisionConflict();
}

/** Provider start is a durable metadata-only revision that clients cannot
 * observe until their stream settles. A local edit may therefore present the
 * exact content version immediately before that hidden revision. */
export function requireExpectedLocalStoryVersion(
  snapshot: StoryAggregateSnapshot,
  expected: StoryAggregateVersion
): void {
  if (matchesExpectedStoryVersion(snapshot, expected)
    || matchesHiddenProviderStart(snapshot, expected)) {
    return;
  }
  throwRevisionConflict();
}

export function storyAggregateVersion(
  snapshot: StoryAggregateSnapshot
): Exclude<StoryAggregateVersion, { kind: "absent" }> {
  return snapshot.storageKind === "v5"
    ? { kind: "v5", manifestHash: snapshot.manifestHash }
    : { kind: "v6", revision: snapshot.manifest.revision };
}

export function storyProjection(
  manifest: StoryManifestV6
): RecoveryStoryStateProjection {
  return {
    kind: "story",
    storyId: manifest.id,
    storyRevision: manifest.revision,
    summary: manifest.kind === "live" ? manifest.summary : null,
    previousManifestHash: manifest.previousManifestHash
  };
}

function matchesExpectedStoryVersion(
  snapshot: StoryAggregateSnapshot,
  expected: StoryAggregateVersion
): boolean {
  return expected.kind === "v5"
    ? snapshot.storageKind === "v5"
      && expected.manifestHash === snapshot.manifestHash
    : expected.kind === "v6"
      ? snapshot.storageKind === "v6"
        && expected.revision === snapshot.manifest.revision
      : false;
}

function matchesHiddenProviderStart(
  snapshot: StoryAggregateSnapshot,
  expected: StoryAggregateVersion
): boolean {
  const manifest = snapshot.manifest;
  if (snapshot.storageKind !== "v6"
    || manifest.kind !== "live"
    || manifest.unresolvedProvider === null
    || manifest.lastTransaction?.phase !== "started"
    || manifest.lastTransaction.mutationId
      !== manifest.unresolvedProvider.mutationId) {
    return false;
  }
  if (expected.kind === "v5") {
    return manifest.previousManifestHash === expected.manifestHash;
  }
  return expected.kind === "v6"
    && BigInt(manifest.revision) === BigInt(expected.revision) + 1n;
}

function throwRevisionConflict(): never {
  throw new ServiceError(
    409,
    "Story changed since this operation began; reload before retrying.",
    "revision_conflict"
  );
}
