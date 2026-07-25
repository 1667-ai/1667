import type { Server } from "node:net";
import { AI_1667_BUILD_IDENTITY } from "../shared/build-identity.js";
import {
  acquireOwnedDataDirectoryFence,
  classifyDataDirectoryAdmission,
  closeDataDirectoryGuard,
  initializeAbsentDataDirectory
} from "./data-directory-admission.js";
import { DataDirectoryLock } from "./data-directory-lock.js";
import type { DataDirectoryFormat } from "./data-directory-layout.js";

export interface RuntimeDataDirectoryLockOptions {
  readonly hardened?: boolean;
  readonly initializeNew?: boolean;
  readonly offlineExclusive?: boolean;
  readonly offlineGuardHeld?: boolean;
}

/**
 * Runtime-only data-directory lease. Acquisition cannot succeed until every
 * required settings migration has completed under the retained process lock.
 */
export class RuntimeDataDirectoryLock {
  private readonly lock: DataDirectoryLock;
  private readonly hardened: boolean;
  private guard: Server | null = null;
  private publishedNewDirectory = false;

  constructor(
    private readonly dataDir: string,
    private readonly options: RuntimeDataDirectoryLockOptions = {}
  ) {
    this.hardened = options.hardened
      ?? AI_1667_BUILD_IDENTITY.artifactTarget !== "source";
    this.lock = new DataDirectoryLock(dataDir, this.hardened
      ? { initializeIfMissing: false, hardenedLock: true }
      : {});
  }

  get dataFormat(): DataDirectoryFormat {
    return this.lock.dataFormat;
  }

  get authorityPath(): string {
    return this.lock.authorityPath;
  }

  /** True when this acquisition created the data directory. Hardened builds
   * publish a fresh payload; source builds mkdir in place. Either way it is a
   * first run, and never an emptied library. */
  get initializedNewDirectory(): boolean {
    return this.publishedNewDirectory || this.lock.initializedNewDirectory;
  }

  async acquire(): Promise<string> {
    const publication = this.hardened
      ? await this.acquirePublicationFence()
      : null;
    try {
      const canonicalDir = await this.lock.acquire();
      await this.lock.migrateSettingsFormat();
      if (publication !== null) {
        this.guard = publication.guard;
        await publication.release();
      }
      return canonicalDir;
    } catch (error) {
      try {
        await this.lock.release();
        await publication?.release();
        await closeDataDirectoryGuard(publication?.guard ?? null);
      } catch (releaseError) {
        throw attachReleaseFailure(error, releaseError);
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    try {
      await this.lock.release();
    } finally {
      const guard = this.guard;
      this.guard = null;
      await closeDataDirectoryGuard(guard);
    }
  }

  private async acquirePublicationFence() {
    if (this.options.initializeNew !== this.options.offlineExclusive) {
      throw new Error(
        "--initialize-new and --offline-exclusive must be supplied together"
      );
    }
    const admission = await classifyDataDirectoryAdmission(this.dataDir);
    if (admission.kind === "absent") {
      if (this.options.initializeNew !== true) {
        return await acquireOwnedDataDirectoryFence(this.dataDir);
      }
      const published = await initializeAbsentDataDirectory(this.dataDir, {
        offlineGuardHeld: this.options.offlineGuardHeld
      });
      this.publishedNewDirectory = true;
      return published;
    }
    return await acquireOwnedDataDirectoryFence(this.dataDir);
  }
}

function attachReleaseFailure(primary: unknown, releaseFailure: unknown): unknown {
  if ((typeof primary === "object" && primary !== null) || typeof primary === "function") {
    try {
      Object.defineProperty(primary, "releaseFailure", {
        configurable: true,
        value: releaseFailure
      });
      return primary;
    } catch {
      // Non-extensible failures are preserved as the aggregate's first error.
    }
  }
  const message = primary instanceof Error ? primary.message : String(primary);
  return new AggregateError(
    [primary, releaseFailure],
    `${message} (releasing the data-directory lock also failed)`,
    { cause: primary }
  );
}
