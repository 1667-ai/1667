import {
  link,
  lstat,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import type { MutationCoordinator } from "./mutation-coordinator.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { ServiceError } from "./errors.js";
import {
  syncDirectory,
  writeDurableFile
} from "./story-lifecycle.js";
import {
  formatStoryResidueIdentity,
  MAX_STORY_RESIDUE_IDENTITY_BYTES,
  parseStoryResidueIdentityBytes,
  storyResidueIdentityName,
  storyResidueIdentityTempName,
  storyResidueNames,
  storyResidueToken
} from "./story-residue.js";
import {
  MAX_DELETED_STORY_MANIFEST_BYTES,
  parseStoryManifestBytes
} from "./story-v6-codec.js";
import type { DeletedStoryEnvelopeManifest } from "./story-v6-types.js";

export const STORY_REAP_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

type Clock = () => Date;

export interface StoryReaperHooks {
  readonly afterIdentity?: () => void | Promise<void>;
  readonly afterRename?: () => void | Promise<void>;
  readonly afterResidueRemove?: () => void | Promise<void>;
  readonly afterCleanup?: () => void | Promise<void>;
}

export interface StoryReaperOptions {
  readonly now?: Clock;
  readonly hooks?: StoryReaperHooks;
}

/** Successor-Q physical cleanup. Every recovery decision is direct-scoped by
 * the immutable reaping identity; no startup or whole-catalog sweep is used. */
export class StoryReaper {
  private readonly root: string;
  private readonly now: Clock;
  private readonly hooks: StoryReaperHooks;

  constructor(
    dataDir: string,
    private readonly coordinator: MutationCoordinator,
    options: StoryReaperOptions = {}
  ) {
    this.root = path.join(dataDir, "stories");
    this.now = options.now ?? (() => new Date());
    this.hooks = options.hooks ?? {};
  }

  async reapIfEligible(storyId: string): Promise<boolean> {
    return await this.coordinator.runStoryMaintenance(
      storyId,
      async () => await this.sweep(storyId, false)
    );
  }

  /** Read paths call this, so a story already claimed by a live mutation
   * skips instead of failing the read that asked for it. */
  async recoverResidue(storyId: string): Promise<boolean> {
    return await this.coordinator.runStoryMaintenanceWhenIdle(
      storyId,
      async () => await this.sweep(storyId, true)
    ) ?? false;
  }

  private async sweep(
    storyId: string,
    residueOnly: boolean
  ): Promise<boolean> {
    const paths = this.paths(storyId);
    await this.recoverIdentityTemp(paths);
    const [canonical, residue, identity] = await Promise.all([
      lstatOptional(paths.canonical),
      lstatOptional(paths.residue),
      lstatOptional(paths.identity)
    ]);
    if (canonical !== null && !canonical.isDirectory()) {
      throw corruptReap(storyId, "canonical story is not a directory");
    }
    if (residue !== null && !residue.isDirectory()) {
      throw corruptReap(storyId, "reaping residue is not a directory");
    }
    if (identity !== null && !identity.isFile()) {
      throw corruptReap(storyId, "reaping identity is not a regular file");
    }
    if (residue !== null) {
      if (canonical !== null || identity === null) {
        throw corruptReap(storyId, "reaping residue has conflicting authority");
      }
      await this.readIdentity(paths);
      await this.requireDeletedBundle(paths.residue, storyId, false);
      await this.removeResidue(paths);
      return true;
    }
    if (residueOnly && identity === null) return false;
    if (canonical === null) {
      if (identity !== null) {
        await this.readIdentity(paths);
        await this.cleanupIdentity(paths);
        await this.hooks.afterCleanup?.();
      }
      return false;
    }

    const manifest = await this.requireDeletedBundle(
      paths.canonical,
      storyId,
      true
    );
    if (manifest.unresolvedProvider !== null) return false;
    if (!this.isEligible(manifest)) return false;
    const mutationId = manifest.lastTransaction?.mutationId;
    if (mutationId === undefined) {
      throw corruptReap(storyId, "deleted story lacks a transaction identity");
    }
    if (identity === null) {
      await this.publishIdentity(paths, storyId, mutationId);
      await this.hooks.afterIdentity?.();
    } else {
      const existing = await this.readIdentity(paths);
      if (existing.mutationId !== mutationId) {
        throw corruptReap(storyId, "reaping identity names a different transaction");
      }
    }
    if (await lstatOptional(paths.residue) !== null) {
      throw corruptReap(storyId, "reaping target already exists");
    }
    await rename(paths.canonical, paths.residue);
    await syncDirectory(this.root);
    await this.hooks.afterRename?.();
    await this.removeResidue(paths);
    return true;
  }

  private async requireDeletedBundle(
    directory: string,
    storyId: string,
    allowUnresolvedProvider: boolean
  ): Promise<DeletedStoryEnvelopeManifest> {
    const bytes = await readBoundedRegularFile(
      path.join(directory, "manifest.json"),
      MAX_DELETED_STORY_MANIFEST_BYTES,
      { requirePrivate: true }
    );
    const parsed = parseStoryManifestBytes(bytes, storyId);
    // Either envelope version reaps. A story the writer deleted after it
    // reached version 8 is still a deleted aggregate, and refusing it here
    // would strand its bundle on disk for good.
    if (parsed.kind !== "v6-deleted" && parsed.kind !== "v8-deleted") {
      throw new ServiceError(
        409,
        `Story ${storyId} is not a deleted aggregate.`,
        "conflict"
      );
    }
    if (!allowUnresolvedProvider
      && parsed.manifest.unresolvedProvider !== null) {
      throw new ServiceError(
        409,
        `Story ${storyId} still has an unknown provider outcome.`,
        "generation_outcome_unknown"
      );
    }
    return parsed.manifest;
  }

  private isEligible(manifest: DeletedStoryEnvelopeManifest): boolean {
    const deletedAt = Date.parse(manifest.deletedAt);
    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw new Error("Story reaper clock returned an invalid date");
    return Number.isFinite(deletedAt)
      && deletedAt <= now - STORY_REAP_RETENTION_MS;
  }

  private async publishIdentity(
    paths: ReapPaths,
    storyId: string,
    mutationId: string
  ): Promise<void> {
    const bytes = formatStoryResidueIdentity({
      schema: 1,
      kind: "story-reap-reservation",
      storyId,
      token: storyResidueToken("reap", storyId),
      mutationId
    });
    await writeDurableFile(paths.identityTemp, bytes, 0o600);
    await link(paths.identityTemp, paths.identity);
    await syncDirectory(this.root);
    await unlink(paths.identityTemp);
    await syncDirectory(this.root);
  }

  private async readIdentity(paths: ReapPaths) {
    const bytes = await readBoundedRegularFile(
      paths.identity,
      MAX_STORY_RESIDUE_IDENTITY_BYTES,
      { requirePrivate: true }
    );
    return parseStoryResidueIdentityBytes(bytes, {
      storyId: paths.storyId,
      residueKind: "reap"
    });
  }

  private async recoverIdentityTemp(paths: ReapPaths): Promise<void> {
    const temp = await lstatOptional(paths.identityTemp);
    if (temp === null) return;
    if (!temp.isFile()) {
      throw corruptReap(paths.storyId, "reaping identity temp is not a regular file");
    }
    const identity = await lstatOptional(paths.identity);
    const residue = await lstatOptional(paths.residue);
    if (identity === null && residue !== null) {
      throw corruptReap(paths.storyId, "reaping residue lost its final identity");
    }
    if (identity !== null) await this.readIdentity(paths);
    await unlink(paths.identityTemp);
    await syncDirectory(this.root);
  }

  private async removeResidue(paths: ReapPaths): Promise<void> {
    await rm(paths.residue, { recursive: true, force: false, maxRetries: 0 });
    await syncDirectory(this.root);
    await this.hooks.afterResidueRemove?.();
    await this.cleanupIdentity(paths);
    await this.hooks.afterCleanup?.();
  }

  private async cleanupIdentity(paths: ReapPaths): Promise<void> {
    await unlinkIfPresent(paths.identityTemp);
    await unlinkIfPresent(paths.identity);
    await syncDirectory(this.root);
  }

  private paths(storyId: string): ReapPaths {
    return {
      storyId,
      canonical: path.join(this.root, storyId),
      residue: path.join(this.root, storyResidueNames(storyId).reap),
      identity: path.join(
        this.root,
        storyResidueIdentityName("reap", storyId)
      ),
      identityTemp: path.join(
        this.root,
        storyResidueIdentityTempName("reap", storyId)
      )
    };
  }
}

interface ReapPaths {
  readonly storyId: string;
  readonly canonical: string;
  readonly residue: string;
  readonly identity: string;
  readonly identityTemp: string;
}

async function lstatOptional(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function unlinkIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function corruptReap(storyId: string, detail: string): Error {
  return new Error(`Story reap state is corrupt for ${storyId}: ${detail}`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
