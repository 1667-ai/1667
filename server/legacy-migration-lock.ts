import type { Stats } from "node:fs";
import { lstat, mkdir, rmdir, utimes } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./story-lifecycle.js";

const HEARTBEAT_MS = 2_000;

/** A lease compatible with the directory locks used by older 1667
 * releases. The heartbeat stays comfortably inside their 10-second stale
 * window; inode checks prevent cleanup from removing a replacement owner. */
export class LegacyMigrationLock {
  private heartbeatError: unknown = null;
  private heartbeatTask: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private constructor(
    private readonly sourceDir: string,
    private readonly lockPath: string,
    private readonly identity: LockIdentity
  ) {}

  static async acquire(sourceDir: string): Promise<LegacyMigrationLock> {
    const lockPath = path.join(sourceDir, ".1667.lock");
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        throw new Error(
          "Legacy data lock is present; stop every 1667 server/import, "
            + "move the stale .1667.lock to Trash, and retry"
        );
      }
      throw error;
    }

    try {
      const lock = new LegacyMigrationLock(sourceDir, lockPath, identityOf(await lstat(lockPath)));
      await syncDirectory(sourceDir);
      await lock.assertHeld();
      lock.startHeartbeat();
      return lock;
    } catch (error) {
      await rmdir(lockPath).catch(() => undefined);
      throw error;
    }
  }

  async assertHeld(): Promise<void> {
    await this.queueHeartbeat();
    if (this.heartbeatError !== null) throw lockLostError(this.heartbeatError);
  }

  async release(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.heartbeatTask;

    let current: Stats;
    try {
      current = await lstat(this.lockPath);
    } catch (error) {
      throw lockLostError(error);
    }
    if (!sameIdentity(this.identity, identityOf(current))) throw lockLostError();

    await rmdir(this.lockPath);
    await syncDirectory(this.sourceDir);
    if (this.heartbeatError !== null) throw lockLostError(this.heartbeatError);
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => {
      void this.queueHeartbeat();
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  private queueHeartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatError !== null) return this.heartbeatTask;
    this.heartbeatTask = this.heartbeatTask.then(async () => {
      if (this.stopped || this.heartbeatError !== null) return;
      try {
        await this.refresh();
      } catch (error) {
        this.heartbeatError = error;
      }
    });
    return this.heartbeatTask;
  }

  private async refresh(): Promise<void> {
    if (!sameIdentity(this.identity, identityOf(await lstat(this.lockPath)))) throw lockLostError();
    const now = new Date();
    await utimes(this.lockPath, now, now);
    if (!sameIdentity(this.identity, identityOf(await lstat(this.lockPath)))) throw lockLostError();
  }
}

interface LockIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function identityOf(stats: Stats): LockIdentity {
  return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function lockLostError(cause?: unknown): Error {
  return new Error(
    "Legacy migration lock ownership was lost; refusing to remove another process's lock",
    cause === undefined ? undefined : { cause }
  );
}
