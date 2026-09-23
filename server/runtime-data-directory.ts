import { DataDirectoryLock } from "./data-directory-lock.js";
import type { DataDirectoryFormat } from "./data-directory-layout.js";
import {
  publishProjectRunRecord,
  removeProjectRunRecord
} from "./project-run-record.js";

/**
 * Runtime-only data-directory lease. Acquisition cannot succeed until every
 * required settings migration has completed under the retained process lock.
 *
 * The project tier carries a `.git`-equivalent threat model, so every
 * build — packaged included — opens it the same way: create it when missing,
 * take one advisory lock, and refuse a format this build cannot read.
 */
export class RuntimeDataDirectoryLock {
  private readonly lock: DataDirectoryLock;
  private runRecordQueue: Promise<void> = Promise.resolve();
  private acquired = false;
  private canonicalDir: string | null = null;
  private startedAt: string | null = null;

  constructor(dataDir: string) {
    this.lock = new DataDirectoryLock(dataDir);
  }

  get dataFormat(): DataDirectoryFormat {
    return this.lock.dataFormat;
  }

  get authorityPath(): string {
    return this.lock.authorityPath;
  }

  /** True when this acquisition created the data directory. It is then a first
   * run, and never an emptied library.
   *
   * Throws before acquisition rather than answering `false`, which would be
   * indistinguishable from "not fresh" and would silently skip the seed. */
  get initializedNewDirectory(): boolean {
    if (!this.acquired) {
      throw new Error("Data-directory freshness is unavailable before acquisition");
    }
    return this.lock.initializedNewDirectory;
  }

  async acquire(
    options: { readonly beforeMigration?: (lockedDataDirectory: string) => Promise<void> } = {}
  ): Promise<string> {
    return await this.serializeRunRecord(async () => {
      try {
        const canonicalDir = await this.lock.acquire();
        await options.beforeMigration?.(canonicalDir);
        await this.lock.migrateSettingsFormat();
        this.acquired = true;
        this.canonicalDir = canonicalDir;
        this.startedAt = new Date().toISOString();
        // Advisory: it lets the next start name this process instead of guessing.
        // A record nobody could write is not a reason to refuse the project.
        await publishProjectRunRecord(canonicalDir, {
          pid: process.pid,
          port: null,
          url: null,
          startedAt: this.startedAt
        }).catch(() => undefined);
        return canonicalDir;
      } catch (error) {
        try {
          await this.lock.release();
        } catch (releaseError) {
          throw attachReleaseFailure(error, releaseError);
        }
        throw error;
      }
    });
  }

  /** Publish server discovery only while this instance retains project
   * authority. Release runs through the same queue before it unlocks. */
  async announceProjectServer(
    server: { readonly port: number; readonly url: string },
    signal?: AbortSignal
  ): Promise<void> {
    await this.serializeRunRecord(async () => {
      if (signal?.aborted === true
        || !this.acquired
        || this.canonicalDir === null
        || this.startedAt === null) {
        return;
      }
      await publishProjectRunRecord(this.canonicalDir, {
        pid: process.pid,
        port: server.port,
        url: server.url,
        startedAt: this.startedAt
      }).catch(() => undefined);
    });
  }

  async release(): Promise<void> {
    await this.serializeRunRecord(async () => {
      const canonicalDir = this.canonicalDir;
      this.acquired = false;
      this.canonicalDir = null;
      this.startedAt = null;
      try {
        if (canonicalDir !== null) await removeProjectRunRecord(canonicalDir);
      } finally {
        await this.lock.release();
      }
    });
  }

  private async serializeRunRecord<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.runRecordQueue.then(operation, operation);
    this.runRecordQueue = running.then(
      () => undefined,
      () => undefined
    );
    return await running;
  }
}

function attachReleaseFailure(primary: unknown, releaseFailure: unknown): unknown {
  const message = primary instanceof Error ? primary.message : String(primary);
  return new AggregateError(
    [primary, releaseFailure],
    `${message} (releasing the data-directory lock also failed)`,
    { cause: primary }
  );
}
