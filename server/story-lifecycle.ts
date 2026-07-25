import { mkdir, open, readdir, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isStoryId, STORY_ID_PATTERN_SOURCE } from "./story-v5-strict.js";
import { exactStringPattern } from "./story-wire-patterns.js";

type EphemeralBundleKind = "staging" | "deleted";
type DirectoryHandle = Pick<FileHandle, "sync" | "close">;
type DirectoryOpenFlag = "r" | "a+";
type OpenDirectory = (directory: string, flag: DirectoryOpenFlag) => Promise<DirectoryHandle>;
type SyncParent = (directory: string) => Promise<void>;

interface DirectorySyncOptions {
  platform?: NodeJS.Platform;
  openDirectory?: OpenDirectory;
}

export type CommitResult =
  | { status: "durable" }
  | { status: "visible-not-durable"; error: unknown };

export class StoryDurabilityError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "StoryDurabilityError";
  }
}

const UUID_SOURCE = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const PORTABLE_COMPONENT_BYTES = 255;
const EPHEMERAL_BUNDLE_PATTERN = exactStringPattern(
  `\\.1667-(?:staging|deleted)-${STORY_ID_PATTERN_SOURCE}-${UUID_SOURCE}\\.tmp`
);

/** Sibling directories have two phases: staging is unpublished work; deleted
 * is an atomically unpublished tombstone waiting for best-effort reaping. */
export function stagingBundlePath(root: string, storyId: string): string {
  return ephemeralBundlePath(root, "staging", storyId);
}

export async function publishBundle(stagingPath: string, root: string, storyId: string): Promise<CommitResult> {
  assertStoryId(storyId);
  await rename(stagingPath, path.join(root, storyId));
  return await commitBarrier(`published story ${storyId}`, root);
}

/** Rename is the deletion commit. Recursive removal happens only after the
 * authoritative story path has disappeared, so an interrupted reap cannot
 * strand a half-deleted story at its live path. */
export async function unpublishBundle(root: string, storyId: string): Promise<CommitResult> {
  assertStoryId(storyId);
  const tombstone = ephemeralBundlePath(root, "deleted", storyId);
  await rename(path.join(root, storyId), tombstone);
  const commit = await commitBarrier(`deleted story ${storyId}`, root);
  if (commit.status === "durable") {
    await afterCommit(`reaping deleted story ${storyId}`, async () => {
      await rm(tombstone, { recursive: true, force: true });
      await syncDirectory(root);
    });
  }
  return commit;
}

/** Startup recovery for crashes between staging/publication or unpublish/reap.
 * The exact app-owned pattern prevents cleanup from touching unknown folders. */
export async function reapEphemeralBundles(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !isEphemeralBundleName(entry.name)) continue;
    await reapEphemeralBundle(root, entry.name);
  }
}

export function isEphemeralBundleName(name: string): boolean {
  return EPHEMERAL_BUNDLE_PATTERN.test(name);
}

export async function reapEphemeralBundle(
  root: string,
  name: string
): Promise<void> {
  if (!isEphemeralBundleName(name)) {
    throw new Error(`Refusing to reap an unknown story bundle: ${name}`);
  }
  await afterCommit(
    `reaping abandoned story bundle ${name}`,
    async () => {
      await rm(path.join(root, name), { recursive: true, force: true });
      await syncDirectory(root);
    }
  );
}

/** Write and flush file data without publishing a directory entry. Callers that
 * rename or link it must sync the containing directory at their commit barrier. */
export async function writeSyncedFile(
  file: string,
  data: string | Uint8Array,
  flag: string = "w",
  mode: number = 0o666
): Promise<void> {
  const handle = await open(file, flag, mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeDurableFile(
  file: string,
  data: string | Uint8Array,
  mode: number = 0o666
): Promise<void> {
  await writeSyncedFile(file, data, "wx", mode);
  await syncDirectory(path.dirname(file));
}

export async function writeDurableAtomic(file: string, data: string | Uint8Array): Promise<CommitResult> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeSyncedFile(temporary, data, "wx");
    await rename(temporary, file);
    return await commitBarrier(path.basename(file), path.dirname(file));
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

export async function unlinkDurable(file: string): Promise<CommitResult> {
  await unlink(file);
  return await commitBarrier(`removal of ${path.basename(file)}`, path.dirname(file));
}

/** Directory fsync establishes rename/mkdir/unlink ordering. Unsupported
 * filesystems fail explicitly: callers must not classify an unflushed rename
 * or unlink as durable. */
export async function syncDirectory(
  directory: string,
  options: DirectorySyncOptions = {}
): Promise<void> {
  const openDirectory = options.openDirectory ?? openDirectoryHandle;
  let handle: DirectoryHandle | undefined;
  try {
    handle = await openDirectory(directory, directorySyncOpenFlag(options.platform));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/** Node can open Windows directories with `a+`, yielding a writable handle for
 * FlushFileBuffers; POSIX directory fsync uses a read-only handle. */
export function directorySyncOpenFlag(platform: NodeJS.Platform = process.platform): DirectoryOpenFlag {
  return platform === "win32" ? "a+" : "r";
}

async function openDirectoryHandle(directory: string, flag: DirectoryOpenFlag): Promise<FileHandle> {
  return await open(directory, flag);
}

/** Create each missing path component and durably publish that entry in its
 * parent before creating the next level. */
export async function mkdirDurable(directory: string, syncParent: SyncParent = syncDirectory): Promise<void> {
  const missing: string[] = [];
  let cursor = path.resolve(directory);
  for (;;) {
    try {
      const info = await stat(cursor);
      if (!info.isDirectory()) throw new Error(`Storage path is not a directory: ${cursor}`);
      break;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const next of missing.reverse()) {
    try {
      await mkdir(next);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      const info = await stat(next);
      if (!info.isDirectory()) throw error;
    }
    await syncParent(path.dirname(next));
  }
}

/** A visible filesystem change with an unconfirmed directory barrier must be
 * surfaced. Retrying blindly is unsafe, so the error tells callers to reload. */
export function requireDurableCommit(commit: CommitResult, operation: string): void {
  if (commit.status === "durable") return;
  throw new StoryDurabilityError(
    `${operation} is visible, but durability could not be confirmed; reload before retrying`,
    { cause: commit.error }
  );
}

/** Publication already succeeded. Cleanup failure must stay observable without
 * making callers retry a mutation that is durably committed. */
export async function afterCommit(label: string, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn(`Story storage committed; ${label} will be retried later: ${errorMessage(error)}`);
  }
}

async function commitBarrier(label: string, directory: string): Promise<CommitResult> {
  try {
    await syncDirectory(directory);
    return { status: "durable" };
  } catch (error) {
    console.warn(`Story storage change is visible but not durably synced (${label}): ${errorMessage(error)}`);
    return { status: "visible-not-durable", error };
  }
}

function ephemeralBundlePath(root: string, kind: EphemeralBundleKind, storyId: string): string {
  assertStoryId(storyId);
  const uuid = randomUUID();
  const direct = `.1667-${kind}-${storyId}-${uuid}.tmp`;
  if (Buffer.byteLength(direct) <= PORTABLE_COMPONENT_BYTES) return path.join(root, direct);
  const token = `sid-${createHash("sha256").update(storyId).digest("hex")}`;
  return path.join(root, `.1667-${kind}-${token}-${uuid}.tmp`);
}

function assertStoryId(storyId: string): void {
  if (!isStoryId(storyId)) throw new Error("Invalid story id for bundle lifecycle");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
