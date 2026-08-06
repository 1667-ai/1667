import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import path from "node:path";

/**
 * In-process FIFO ownership of one reserved pathname.
 *
 * A no-replace publication intentionally holds two hard links to one inode
 * (scratch and final) inside its commit window, and recovery may unlink a
 * scratch. Both are owner-only states: a reader that observes them while a
 * publisher is live fails on transient link counts, and a reader that repairs
 * them unlinks the scratch the live writer is about to publish. This gate
 * serializes every publication-engine operation on one reserved pathname, so
 * inside one process a reader can never overlap a live publication window and
 * recovery can never touch a live writer's scratch.
 *
 * Between processes the ownership boundary is the domain's advisory lock: the
 * data-directory lock for the project tier, or the applicable private file
 * lock for machine-tier stores. The data-directory lock probes its
 * filesystem and refuses one whose locks do not hold. This gate takes no OS
 * lock of its own and assumes no cross-process lock semantics.
 */

const owners = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Run work while this process owns the reserved pathname. FIFO per name. */
export async function withReservedPathOwnership<T>(
  file: string,
  work: () => Promise<T>
): Promise<T> {
  // Resolve identity synchronously. The caller joins the FIFO before its
  // first await, so metadata scheduling cannot reverse invocation order.
  const key = ownershipKey(file);
  const alreadyHeld = held.getStore();
  if (alreadyHeld?.has(key)) {
    throw new Error(`Reserved pathname ownership is not reentrant: ${file}`);
  }
  const predecessor = owners.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  owners.set(key, tail);
  await predecessor;
  try {
    return await held.run(new Set([...(alreadyHeld ?? []), key]), work);
  } finally {
    release();
    if (owners.get(key) === tail) owners.delete(key);
  }
}

/** One key per directory identity and entry name. The identity comes from the
 * directory inode, so a retained `/proc/self/fd/N` authority path and the
 * canonical path it aliases own the same gate. A missing directory keys by
 * resolved pathname; every operation on it fails on the absent parent. */
function ownershipKey(file: string): string {
  try {
    const info = statSync(path.dirname(file), { bigint: true });
    return `inode:${info.dev}:${info.ino}:${path.basename(file)}`;
  } catch {
    return `path:${path.resolve(file)}`;
  }
}
