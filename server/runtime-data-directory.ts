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
 * ADR007 gives the project tier a `.git`-equivalent threat model, so every
 * build — packaged included — opens it the same way: create it when missing,
 * take one advisory lock, and refuse a format this build cannot read.
 */
export class RuntimeDataDirectoryLock {
  private readonly lock: DataDirectoryLock;
  private acquired = false;
  private canonicalDir: string | null = null;

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

  async acquire(): Promise<string> {
    try {
      const canonicalDir = await this.lock.acquire();
      await this.lock.migrateSettingsFormat();
      this.acquired = true;
      this.canonicalDir = canonicalDir;
      // Advisory: it lets the next start name this process instead of guessing.
      // A record nobody could write is not a reason to refuse the project.
      await publishProjectRunRecord(canonicalDir, {
        pid: process.pid,
        port: null,
        url: null,
        startedAt: new Date().toISOString()
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
  }

  async release(): Promise<void> {
    const canonicalDir = this.canonicalDir;
    this.canonicalDir = null;
    try {
      if (canonicalDir !== null) await removeProjectRunRecord(canonicalDir);
    } finally {
      await this.lock.release();
    }
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
