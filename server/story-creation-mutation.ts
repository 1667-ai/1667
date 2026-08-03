import {
  link,
  lstat,
  mkdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import type { Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import type {
  MutationCoordinator,
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import {
  MutationLedgerStore,
} from "./mutation-ledger-store.js";
import {
  isAbsentStoryMutationMethod,
  type MutationResult,
  type PreparedUserMutationRecord
} from "./mutation-ledger-types.js";
import { storyIdForMutation } from "./story-identity.js";
import {
  StoryDurabilityError,
  syncDirectory,
  writeDurableFile
} from "./story-lifecycle.js";
import {
  storyResidueIdentityName,
  storyResidueIdentityTempName,
  storyResidueNames,
  storyResidueToken,
  formatStoryResidueIdentity,
  MAX_STORY_RESIDUE_IDENTITY_BYTES,
  parseStoryResidueIdentityBytes
} from "./story-residue.js";
import { encodeStoryBundle } from "./story-codec.js";
import { StoryObjectStore } from "./story-objects.js";
import { reduceStoryV6 } from "./story-v6-reducer.js";
import {
  formatV6,
  parseStoryManifestBytes,
  storySummaryV6FromContent
} from "./story-v6-codec.js";
import type { StoryManifestV6 } from "./story-v6-types.js";
import type { StoryStore } from "./stories.js";
import { readStoredStorySlot } from "./story-storage-reader.js";
import { storyAggregateSnapshot } from "./story-aggregate-state.js";
import { liveObjectIds } from "./story-format.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { requireFreshUnseenMutationId } from "./mutation-id-policy.js";
import { MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";
import {
  completedCreationRecord,
  creationPrepared,
  creationStoryResult,
  hashCreationManifest,
  requireMatchingCreationReceipt,
  type CreationMethod
} from "./story-creation-record.js";

export interface StoryCreationCommit {
  readonly story: Story;
  readonly result: Extract<MutationResult, { kind: "story" }>;
}

export interface StoryCreationMutationHooks {
  readonly afterIdentity?: () => void | Promise<void>;
  readonly afterResidue?: () => void | Promise<void>;
  readonly afterPrepared?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
  readonly afterCompleted?: () => void | Promise<void>;
  readonly afterCleanup?: () => void | Promise<void>;
}

export interface StoryCreationMutationOptions {
  readonly hooks?: StoryCreationMutationHooks;
  readonly now?: () => Date;
}

export class StoryCreationMutationStore {
  private readonly ledger: MutationLedgerStore;
  private readonly root: string;
  private readonly hooks: StoryCreationMutationHooks;
  private readonly now: () => Date;

  constructor(
    private readonly stories: StoryStore,
    private readonly coordinator: MutationCoordinator,
    dataDir: string,
    options: StoryCreationMutationOptions = {}
  ) {
    this.root = path.join(dataDir, "stories");
    this.ledger = new MutationLedgerStore(dataDir);
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await this.ledger.init();
  }

  async run(
    input: unknown,
    method: CreationMethod,
    build: (storyId: string) => Story | Promise<Story>
  ): Promise<StoryCreationCommit> {
    return await this.coordinator.runStory(input, async (request) => {
      const storyId = storyIdForMutation(request.mutationId);
      if (request.scope !== `story:${storyId}`
        || request.expectedAggregateVersion.kind !== "absent") {
        throw new ServiceError(
          409,
          "Story creation target does not match its deterministic mutation ID.",
          "revision_conflict"
        );
      }
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      if (receipt.started === null && receipt.prepared === null
        && receipt.completed === null && receipt.acknowledged === null) {
        requireFreshUnseenMutationId(
          request.mutationId,
          this.now().getTime()
        );
      }
      if (receipt.started !== null || receipt.acknowledged !== null) {
        throw corruptCreation(request.mutationId);
      }
      if (receipt.prepared !== null) {
        requireMatchingCreationReceipt(receipt.prepared, request, method);
        const recovered = await this.recoverPrepared(
          storyId,
          request,
          receipt.prepared,
          receipt.completed !== null
        );
        if (recovered !== null) return recovered;
      } else if (receipt.completed !== null) {
        throw corruptCreation(request.mutationId);
      } else {
        await this.discardUnpreparedResidue(storyId, request.mutationId);
      }
      return await this.create(storyId, request, method, await build(storyId));
    });
  }

  /** Read paths call this, so a story already claimed by a live mutation
   * skips instead of failing the read that asked for it. */
  async recoverResidue(storyId: string): Promise<boolean> {
    return await this.coordinator.runStoryMaintenanceWhenIdle(storyId, async (scope) => {
      const identity = await this.readCreationIdentity(storyId);
      const residue = path.join(this.root, storyResidueNames(storyId).create);
      if (identity === null) {
        if (await lstatOptional(residue) !== null) {
          throw corruptCreation(storyId);
        }
        return false;
      }
      const receipt = await this.ledger.loadStoryReceipt(
        scope,
        identity.mutationId
      );
      if (receipt.prepared === null) {
        if (receipt.started !== null || receipt.completed !== null
          || receipt.acknowledged !== null) {
          throw corruptCreation(identity.mutationId);
        }
        await this.discardUnpreparedResidue(storyId, identity.mutationId);
        return true;
      }
      const method = receipt.prepared.method;
      if (!isAbsentStoryMutationMethod(method)) {
        throw corruptCreation(identity.mutationId);
      }
      const request: MutationCoordinatorRequest<StoryMutationTarget> = {
        transportOperationId: "catalog-residue-recovery",
        mutationId: identity.mutationId,
        fingerprint: receipt.prepared.fingerprintHash,
        scope,
        expectedAggregateVersion: { kind: "absent" }
      };
      requireMatchingCreationReceipt(receipt.prepared, request, method);
      await this.recoverPrepared(
        storyId,
        request,
        receipt.prepared,
        receipt.completed !== null
      );
      return true;
    }) ?? false;
  }

  private async create(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: CreationMethod,
    story: Story
  ): Promise<StoryCreationCommit> {
    if (story.id !== storyId) throw new Error("Story builder changed deterministic identity");
    await this.requireCreationPathsAbsent(storyId);
    const residueName = storyResidueNames(storyId).create;
    const residue = path.join(this.root, residueName);
    const identityFile = path.join(
      this.root,
      storyResidueIdentityName("create", storyId)
    );
    const identityTemp = path.join(
      this.root,
      storyResidueIdentityTempName("create", storyId)
    );
    const identity = formatStoryResidueIdentity({
      schema: 1,
      kind: "story-create-reservation",
      storyId,
      token: storyResidueToken("create", storyId),
      mutationId: request.mutationId
    });
    await writeDurableFile(identityTemp, identity, 0o600);
    await link(identityTemp, identityFile);
    await syncDirectory(this.root);
    await unlink(identityTemp);
    await syncDirectory(this.root);
    await this.hooks.afterIdentity?.();
    await mkdir(residue, { mode: 0o700 });
    await syncDirectory(this.root);
    await this.hooks.afterResidue?.();
    let published = false;
    try {
      const objects = new StoryObjectStore(residue);
      await objects.init();
      const content = await encodeStoryBundle(story, objects);
      await objects.flush();
      const manifest = reduceStoryV6({ kind: "absent" }, {
        kind: method === "createStory" ? "create-prepared" : "import-prepared",
        mutationId: request.mutationId,
        content,
        summary: storySummaryV6FromContent(content)
      });
      if (manifest === null) throw new Error("Creation reducer returned absence");
      await objects.verifyGraph(liveObjectIds(content));
      await writeDurableFile(
        path.join(residue, "manifest.json"),
        formatV6(manifest),
        0o600
      );
      const prepared = creationPrepared(
        method,
        request,
        manifest,
        this.timestamp()
      );
      await this.ledger.writeStoryRecord(prepared);
      await this.hooks.afterPrepared?.();
      await this.publishNoReplace(residue, storyId);
      published = true;
      await this.hooks.afterPublish?.();
      await this.ledger.writeStoryRecord(
        completedCreationRecord(prepared, this.timestamp())
      );
      await this.hooks.afterCompleted?.();
      await this.cleanupIdentity(identityFile, identityTemp);
      await this.hooks.afterCleanup?.();
      return { story, result: creationStoryResult(manifest) };
    } catch (error) {
      if (error instanceof StoryDurabilityError
        || (published && !(error instanceof InjectedStoryCreationCrash))) {
        throw error instanceof StoryDurabilityError
          ? error
          : new StoryDurabilityError(
            `Story creation ${request.mutationId} committed but its terminal evidence is incomplete`,
            { cause: error }
          );
      }
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      ).catch(() => null);
      if (receipt?.prepared === null
        && !(error instanceof InjectedStoryCreationCrash)) {
        await rm(residue, { recursive: true, force: true }).catch(() => undefined);
        await this.cleanupIdentity(identityFile, identityTemp).catch(() => undefined);
      }
      throw error;
    }
  }

  private async recoverPrepared(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    prepared: PreparedUserMutationRecord,
    completedAlready: boolean
  ): Promise<StoryCreationCommit | null> {
    const slot = await readStoredStorySlot(this.root, storyId);
    if (slot.kind === "v6-live") {
      const snapshot = storyAggregateSnapshot(slot);
      if (snapshot.manifestHash !== prepared.newStateHash
        || snapshot.manifest.lastTransaction?.mutationId !== request.mutationId
        || snapshot.manifest.lastTransaction.phase !== "prepared") {
        throw corruptCreation(request.mutationId);
      }
      try {
        if (!completedAlready) {
          await this.ledger.writeStoryRecord(
            completedCreationRecord(prepared, this.timestamp())
          );
        }
        await this.cleanupIdentity(
          path.join(this.root, storyResidueIdentityName("create", storyId)),
          path.join(this.root, storyResidueIdentityTempName("create", storyId))
        );
        const loaded = await this.stories.loadVersioned(storyId);
        return {
          story: loaded.story,
          result: creationStoryResult(snapshot.manifest)
        };
      } catch (error) {
        throw committedCreationRecoveryError(request.mutationId, error);
      }
    }
    if (slot.kind !== "residue" || slot.residueKind !== "create") {
      throw corruptCreation(request.mutationId);
    }
    const residue = path.join(this.root, storyResidueNames(storyId).create);
    const residueManifest = await readStoredStorySlotFromResidue(residue, storyId);
    if (hashCreationManifest(residueManifest) !== prepared.newStateHash) {
      throw corruptCreation(request.mutationId);
    }
    await this.publishNoReplace(residue, storyId);
    try {
      await this.ledger.writeStoryRecord(
        completedCreationRecord(prepared, this.timestamp())
      );
      await this.cleanupIdentity(
        path.join(this.root, storyResidueIdentityName("create", storyId)),
        path.join(this.root, storyResidueIdentityTempName("create", storyId))
      );
      const loaded = await this.stories.loadVersioned(storyId);
      return {
        story: loaded.story,
        result: creationStoryResult(residueManifest)
      };
    } catch (error) {
      throw committedCreationRecoveryError(request.mutationId, error);
    }
  }

  private async requireCreationPathsAbsent(storyId: string): Promise<void> {
    const slot = await readStoredStorySlot(this.root, storyId);
    if (slot.kind !== "absent") {
      throw new ServiceError(409, "Story already exists.", "revision_conflict");
    }
  }

  private async discardUnpreparedResidue(
    storyId: string,
    mutationId: string
  ): Promise<void> {
    const residue = path.join(this.root, storyResidueNames(storyId).create);
    const canonical = path.join(this.root, storyId);
    const identity = await this.readCreationIdentity(storyId);
    const residueInfo = await lstatOptional(residue);
    if (identity === null && residueInfo === null) return;
    if (identity === null || identity.mutationId !== mutationId
      || await lstatOptional(canonical) !== null) {
      throw corruptCreation(mutationId);
    }
    if (residueInfo !== null && !residueInfo.isDirectory()) {
      throw corruptCreation(mutationId);
    }
    if (residueInfo !== null) {
      await rm(residue, { recursive: true, force: false, maxRetries: 0 });
      await syncDirectory(this.root);
    }
    await this.cleanupIdentity(
      path.join(this.root, storyResidueIdentityName("create", storyId)),
      path.join(this.root, storyResidueIdentityTempName("create", storyId))
    );
  }

  private async readCreationIdentity(storyId: string) {
    const identityFile = path.join(
      this.root,
      storyResidueIdentityName("create", storyId)
    );
    const identityTemp = path.join(
      this.root,
      storyResidueIdentityTempName("create", storyId)
    );
    const [identityInfo, tempInfo] = await Promise.all([
      lstatOptional(identityFile),
      lstatOptional(identityTemp)
    ]);
    if (tempInfo !== null && !tempInfo.isFile()) {
      throw corruptCreation(storyId);
    }
    if (identityInfo === null) {
      if (tempInfo !== null) {
        const residue = path.join(this.root, storyResidueNames(storyId).create);
        if (await lstatOptional(residue) !== null) throw corruptCreation(storyId);
        await unlink(identityTemp);
        await syncDirectory(this.root);
      }
      return null;
    }
    if (!identityInfo.isFile()) throw corruptCreation(storyId);
    const bytes = await readBoundedRegularFile(
      identityFile,
      MAX_STORY_RESIDUE_IDENTITY_BYTES,
      { requirePrivate: true }
    );
    const identity = parseStoryResidueIdentityBytes(bytes, {
      storyId,
      residueKind: "create"
    });
    if (tempInfo !== null) {
      await unlink(identityTemp);
      await syncDirectory(this.root);
    }
    return identity;
  }

  private async publishNoReplace(residue: string, storyId: string): Promise<void> {
    const target = path.join(this.root, storyId);
    if (await lstatOptional(target) !== null) {
      throw new ServiceError(409, "Story already exists.", "revision_conflict");
    }
    await rename(residue, target);
    try {
      await syncDirectory(this.root);
    } catch (error) {
      throw new StoryDurabilityError(
        `Story creation ${storyId} became visible but its durability could not be confirmed`,
        { cause: error }
      );
    }
  }

  private async cleanupIdentity(
    identityFile: string,
    identityTemp: string
  ): Promise<void> {
    await unlink(identityTemp).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
    await unlink(identityFile).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
    await syncDirectory(this.root);
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Story creation clock returned an invalid date");
    }
    return value.toISOString();
  }
}

export class InjectedStoryCreationCrash extends Error {
  constructor(readonly point: string) {
    super(`Injected story creation crash after ${point}`);
    this.name = "InjectedStoryCreationCrash";
  }
}

async function readStoredStorySlotFromResidue(
  residue: string,
  storyId: string
): Promise<StoryManifestV6> {
  const bytes = await readBoundedRegularFile(
    path.join(residue, "manifest.json"),
    MAX_STORY_MANIFEST_BYTES,
    { requirePrivate: true }
  );
  const parsed = parseStoryManifestBytes(bytes, storyId);
  if (parsed.kind !== "v6-live") throw corruptCreation(storyId);
  return parsed.manifest;
}

async function lstatOptional(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function corruptCreation(key: string): ServiceError {
  return new ServiceError(
    500,
    `Story creation receipt is corrupt: ${key}`,
    "internal"
  );
}

function committedCreationRecoveryError(
  mutationId: string,
  error: unknown
): StoryDurabilityError {
  return error instanceof StoryDurabilityError
    ? error
    : new StoryDurabilityError(
      `Story creation ${mutationId} is committed but recovery remains incomplete`,
      { cause: error }
    );
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
