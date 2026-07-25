import { ServiceError } from "./errors.js";
import type {
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import { hashPreparedMutationRecord } from "./mutation-ledger-codec.js";
import type { StoryMutationReceipt } from "./mutation-ledger-store.js";
import type {
  CompletedMutationRecord,
  MutationResult,
  PreparedUserMutationRecord
} from "./mutation-ledger-types.js";
import { hashStoryV6ManifestBytes } from "./story-manifest-hash.js";
import { formatV6 } from "./story-v6-codec.js";
import type { StoryManifestV6 } from "./story-v6-types.js";

export type CreationMethod = "createStory" | "importSillyTavern";

export function creationPrepared(
  method: CreationMethod,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  manifest: StoryManifestV6,
  preparedAt: string
): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: request.scope,
    key: request.mutationId,
    fingerprintHash: request.fingerprint,
    method,
    oldStateHash: "absent",
    newStateHash: hashCreationManifest(manifest),
    startedRecordHash: null,
    result: creationStoryResult(manifest),
    preparedAt
  };
}

export function completedCreationRecord(
  prepared: PreparedUserMutationRecord,
  completedAt: string
): CompletedMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: prepared.aggregateKey,
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt
  };
}

export function creationStoryResult(
  manifest: StoryManifestV6
): Extract<MutationResult, { kind: "story" }> {
  if (manifest.kind !== "live") {
    throw new Error("Creation produced a deleted story");
  }
  return {
    kind: "story",
    storyId: manifest.id,
    storyRevision: manifest.revision,
    summary: manifest.summary
  };
}

export function hashCreationManifest(manifest: StoryManifestV6): string {
  return hashStoryV6ManifestBytes(Buffer.from(formatV6(manifest), "utf8"));
}

export function requireMatchingCreationReceipt(
  prepared: StoryMutationReceipt["prepared"],
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: CreationMethod
): asserts prepared is PreparedUserMutationRecord {
  if (prepared === null || prepared.purpose !== "mutation"
    || prepared.aggregateKey !== request.scope
    || prepared.key !== request.mutationId
    || prepared.method !== method
    || prepared.fingerprintHash !== request.fingerprint
    || prepared.oldStateHash !== "absent"
    || prepared.startedRecordHash !== null) {
    throw new ServiceError(
      409,
      "Mutation ID was already used for different creation input.",
      "idempotency_conflict"
    );
  }
}
