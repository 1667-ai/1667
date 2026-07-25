import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  requireDurableCommit,
  unlinkDurable,
  writeDurableAtomic
} from "./story-lifecycle.js";
import { isStoryId } from "./story-v5-strict.js";

export const CLEANUP_MARKER_FILENAME = ".1667-cleanup-needed";
export const STORY_CLEANUP_IO_CONCURRENCY = 2;
const MARKER_BODY = "1667 object cleanup pending\n";

interface ActiveCleanup {
  promise: Promise<void>;
  rerun: boolean;
  abort: AbortController;
}

/** Library-wide scheduler: per-story I/O queues prevent object races, while
 * this ceiling prevents restart recovery from sweeping every bundle at once. */
export class BoundedCleanupQueue {
  private readonly active = new Map<string, ActiveCleanup>();
  private readonly queuedIds = new Set<string>();
  private readonly queued: string[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly run: (storyId: string, signal: AbortSignal) => Promise<void>
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Cleanup concurrency must be a positive integer");
    }
  }

  schedule(storyId: string): void {
    const active = this.active.get(storyId);
    if (active !== undefined) {
      active.rerun = true;
      return;
    }
    if (this.queuedIds.has(storyId)) return;
    this.queuedIds.add(storyId);
    this.queued.push(storyId);
    this.drain();
  }

  interrupt(storyId: string): void {
    const active = this.active.get(storyId);
    if (active === undefined) return;
    active.rerun = true;
    active.abort.abort();
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0 || this.queued.length > 0) {
      this.drain();
      const running = [...this.active.values()].map(({ promise }) => promise);
      if (running.length === 0) await Promise.resolve();
      else await Promise.allSettled(running);
    }
  }

  private drain(): void {
    while (this.active.size < this.concurrency && this.queued.length > 0) {
      const storyId = this.queued.shift()!;
      this.queuedIds.delete(storyId);
      const abort = new AbortController();
      const promise = Promise.resolve().then(() => this.run(storyId, abort.signal));
      const job: ActiveCleanup = { promise, rerun: false, abort };
      this.active.set(storyId, job);
      void promise.then(
        () => this.finish(storyId, job),
        () => this.finish(storyId, job)
      );
    }
  }

  private finish(storyId: string, job: ActiveCleanup): void {
    if (this.active.get(storyId) !== job) return;
    this.active.delete(storyId);
    if (job.rerun && !this.queuedIds.has(storyId)) {
      this.queuedIds.add(storyId);
      this.queued.push(storyId);
    }
    this.drain();
  }
}

export async function cleanupPending(bundleDir: string): Promise<boolean> {
  try {
    await readFile(path.join(bundleDir, CLEANUP_MARKER_FILENAME));
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Publish before a manifest drops object references. A crash can then lose
 * only the in-memory job, never the durable evidence that a sweep is owed. */
export async function markCleanupPending(bundleDir: string, storyId: string): Promise<void> {
  requireDurableCommit(
    await writeDurableAtomic(path.join(bundleDir, CLEANUP_MARKER_FILENAME), MARKER_BODY),
    `Marking object cleanup pending for story ${storyId}`
  );
}

export async function clearCleanupPending(bundleDir: string, storyId: string): Promise<void> {
  try {
    requireDurableCommit(
      await unlinkDurable(path.join(bundleDir, CLEANUP_MARKER_FILENAME)),
      `Clearing object cleanup marker for story ${storyId}`
    );
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

export async function pendingCleanupStoryIds(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const ids: string[] = [];
  // Sequential marker probes bound startup descriptors regardless of library size.
  for (const entry of entries) {
    if (!entry.isDirectory() || !isStoryId(entry.name)) continue;
    if (await cleanupPending(path.join(root, entry.name))) ids.push(entry.name);
  }
  return ids;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
