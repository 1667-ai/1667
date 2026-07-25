import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  type FileHandle
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import {
  DATA_DIRECTORY_LEGACY_EXCLUSION_FENCE
} from "./data-directory-layout.js";
import { publishDirectoryNoReplace } from "./directory-no-replace.js";
import { hasDataDirectoryFormatMarker, writeInitialDataDirectoryFormat } from "./data-directory-format.js";
import { ServiceError } from "./errors.js";
import { lockedDataDirectoryError } from "./data-directory-errors.js";
import { lockFile, type OsFileLock } from "./os-file-lock.js";
import { syncDirectory, writeDurableFile } from "./story-lifecycle.js";
import {
  assertNoDarwinExtendedAllow
} from "./storage-privacy-darwin.js";

const TRANSACTION_LOCK = ".1667-init.lock";
const PAYLOAD = "payload";
const LEGACY_EXCLUSION_CONTENT =
  "1667-lock-aware-legacy-exclusion-v1\n";

export type DataDirectoryAdmission =
  | { readonly kind: "absent"; readonly target: string }
  | { readonly kind: "owned-current"; readonly target: string }
  | { readonly kind: "unowned"; readonly target: string };

export interface DataDirectoryPublicationFence {
  readonly guard: Server | null;
  release(): Promise<void>;
}

/** Read-only packaged classifier. Existing empty directories are unowned. */
export async function classifyDataDirectoryAdmission(
  targetInput: string
): Promise<DataDirectoryAdmission> {
  assertHardenedDataDirectoryPlatform();
  const target = path.resolve(targetInput);
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { kind: "absent", target };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refused(target, "target is not a no-follow directory");
  }
  await validateProtectedParent(path.dirname(target));
  await requirePrivateDirectory(target, "data directory");
  return await hasDataDirectoryFormatMarker(target)
    ? { kind: "owned-current", target }
    : { kind: "unowned", target };
}

/**
 * Publish a complete format-2 payload from the deterministic parent
 * transaction. The permanent transaction lock transfers directly to the data
 * lock owner and remains a required fence for every later packaged opener.
 */
export async function initializeAbsentDataDirectory(
  targetInput: string,
  options: { readonly offlineGuardHeld?: boolean } = {}
): Promise<DataDirectoryPublicationFence> {
  assertHardenedDataDirectoryPlatform();
  const target = path.resolve(targetInput);
  const guard = options.offlineGuardHeld === true
    ? null
    : await bindOfflineGuard();
  let fence: ParentFenceLease | null = null;
  try {
    const parent = path.dirname(target);
    await createProtectedParent(parent);
    await requirePrivateWritableParent(parent);
    const admission = await classifyDataDirectoryAdmission(target);
    if (admission.kind !== "absent") {
      throw refused(
        target,
        admission.kind === "owned-current"
          ? "target was initialized concurrently"
          : "existing unmarked directories are never initialized in place",
        admission.kind === "unowned"
      );
    }
    fence = await acquireParentFence(target, true);
    const payload = path.join(fence.transactionDir, PAYLOAD);
    await validateTransactionContents(fence.transactionDir, true);
    await mkdir(payload, { mode: 0o700 }).catch((error: unknown) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
    await requirePrivateDirectory(payload, "initialization payload");
    await ensureLegacyExclusionFence(payload);
    await writeInitialDataDirectoryFormat(payload, 2);
    await syncDirectory(payload);
    if ((await classifyDataDirectoryAdmission(target)).kind !== "absent") {
      throw refused(target, "target appeared during initialization");
    }
    await publishDirectoryNoReplace(payload, target).catch(() => {
      throw refused(target, "native no-replace publication failed");
    });
    await syncDirectory(fence.transactionDir);
    await syncDirectory(parent);
    const published = await realpath(target);
    if (published !== target
      || !(await lstat(target)).isDirectory()
      || !await hasDataDirectoryFormatMarker(target)) {
      throw refused(target, "published target identity or marker is invalid");
    }
    await validateTransactionContents(fence.transactionDir, false);
    const retained = fence;
    fence = null;
    return {
      guard,
      release: async () => await retained.release()
    };
  } catch (error) {
    await fence?.release().catch(() => undefined);
    if (guard !== null) await closeServer(guard).catch(() => undefined);
    throw error;
  }
}

/** Acquire the permanent publication fence for an already-owned target. */
export async function acquireOwnedDataDirectoryFence(
  targetInput: string
): Promise<DataDirectoryPublicationFence> {
  assertHardenedDataDirectoryPlatform();
  const target = path.resolve(targetInput);
  const admission = await classifyDataDirectoryAdmission(target);
  if (admission.kind !== "owned-current") {
    throw refused(
      target,
      admission.kind === "absent"
        ? "new directories require explicit publication"
        : "existing unmarked directories are unsupported and were left untouched",
      true
    );
  }
  const fence = await acquireParentFence(target, false);
  try {
    await validateTransactionContents(fence.transactionDir, false);
    await syncDirectory(path.dirname(target));
    return { guard: null, release: async () => await fence.release() };
  } catch (error) {
    await fence.release().catch(() => undefined);
    throw error;
  }
}

export async function closeDataDirectoryGuard(
  guard: Server | null
): Promise<void> {
  if (guard !== null) await closeServer(guard);
}

interface ParentFenceLease {
  readonly transactionDir: string;
  release(): Promise<void>;
}

async function acquireParentFence(
  target: string,
  create: boolean
): Promise<ParentFenceLease> {
  const transactionDir = transactionDirectory(target);
  if (create) {
    await mkdir(transactionDir, { mode: 0o700 }).catch((error: unknown) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
  }
  await requirePrivateDirectory(transactionDir, "initialization transaction");
  const lockPath = path.join(transactionDir, TRANSACTION_LOCK);
  let handle: FileHandle | undefined;
  let lock: OsFileLock | undefined;
  try {
    const flags = create
      ? constants.O_RDWR | constants.O_CREAT | noFollowFlag()
      : constants.O_RDWR | noFollowFlag();
    handle = await open(lockPath, flags, 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
    const info = await handle.stat();
    await requirePrivateRegularFile(info, lockPath);
    lock = await lockFile(handle.fd);
    const ownedHandle = handle;
    const ownedLock = lock;
    let released = false;
    handle = undefined;
    lock = undefined;
    return {
      transactionDir,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await ownedLock.unlock();
        } finally {
          await ownedHandle.close();
        }
      }
    };
  } catch (error) {
    if (isLockContention(error)) {
      throw lockedDataDirectoryError();
    }
    throw error;
  } finally {
    await lock?.unlock().catch(() => undefined);
    await handle?.close();
  }
}

async function validateTransactionContents(
  transactionDir: string,
  allowPayload: boolean
): Promise<void> {
  const allowed = new Set([
    TRANSACTION_LOCK,
    ...(allowPayload ? [PAYLOAD] : [])
  ]);
  const entries = await readdir(transactionDir);
  if (!entries.includes(TRANSACTION_LOCK)
    || entries.some((entry) => !allowed.has(entry))) {
    throw refused(transactionDir, "initialization transaction has unknown residue");
  }
  if (!allowPayload && entries.includes(PAYLOAD)) {
    throw refused(transactionDir, "initialization publication is incomplete");
  }
}

async function ensureLegacyExclusionFence(payload: string): Promise<void> {
  const file = path.join(payload, DATA_DIRECTORY_LEGACY_EXCLUSION_FENCE);
  try {
    await writeDurableFile(file, LEGACY_EXCLUSION_CONTENT);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    if (await readFile(file, "utf8") !== LEGACY_EXCLUSION_CONTENT) {
      throw refused(file, "legacy exclusion fence residue is invalid");
    }
  }
}

async function createProtectedParent(parent: string): Promise<void> {
  await walkProtectedParent(parent, true);
}

async function validateProtectedParent(parent: string): Promise<void> {
  await walkProtectedParent(parent, false);
}

async function walkProtectedParent(
  parent: string,
  createMissing: boolean
): Promise<void> {
  if (process.platform === "win32") {
    assertHardenedDataDirectoryPlatform();
  }
  const absolute = path.resolve(parent);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  await requireSafePosixAncestor(cursor);
  for (const component of absolute.slice(parsed.root.length).split(path.sep)) {
    if (component.length === 0) continue;
    const next = path.join(cursor, component);
    try {
      await requireSafePosixAncestor(next);
    } catch (error) {
      if (!createMissing
        || !(error instanceof Error && "code" in error
        && error.code === "ENOENT")) throw error;
      await mkdir(next, { mode: 0o700 });
      await syncDirectory(cursor);
      await requireSafePosixAncestor(next);
    }
    cursor = next;
  }
}

/** Recheck hardened root privacy immediately before handle acquisition. */
export async function requirePrivateDataDirectory(
  directory: string
): Promise<void> {
  assertHardenedDataDirectoryPlatform();
  await requirePrivateDirectory(directory, "data directory");
}

export function assertHardenedDataDirectoryPlatform(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== "win32") return;
  throw new ServiceError(
    501,
    "Hardened local data directories are unavailable on Windows until "
      + "a DACL and reparse-safe retained-handle adapter is installed.",
    "data_directory_unowned"
  );
}

async function requirePrivateWritableParent(parent: string): Promise<void> {
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refused(parent, "target parent is not a no-follow directory");
  }
  if (process.platform !== "win32") {
    if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
      throw refused(parent, "target parent is owned by another user");
    }
    if ((info.mode & 0o022) !== 0) {
      throw refused(parent, "target parent grants untrusted mutation authority");
    }
  }
}

async function requireSafePosixAncestor(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refused(directory, "ancestor is not a no-follow directory");
  }
  const user = typeof process.geteuid === "function"
    ? process.geteuid()
    : info.uid;
  if (info.uid !== 0 && info.uid !== user) {
    throw refused(directory, "ancestor is owned by an untrusted user");
  }
  if ((info.mode & 0o022) !== 0) {
    throw refused(directory, "ancestor grants untrusted rename/create authority");
  }
  await assertNoDarwinExtendedAllow(directory, "data ancestor");
}

async function requirePrivateDirectory(
  directory: string,
  label: string
): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refused(directory, `${label} is not a no-follow directory`);
  }
  if (process.platform !== "win32") {
    if ((info.mode & 0o777) !== 0o700
      || (typeof process.geteuid === "function" && info.uid !== process.geteuid())) {
      throw refused(directory, `${label} is not private to the current user`);
    }
    await assertNoDarwinExtendedAllow(directory, label);
  }
}

async function requirePrivateRegularFile(
  info: Stats,
  file: string
): Promise<void> {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw refused(file, "initialization lock is not a regular file");
  }
  if (process.platform !== "win32"
    && ((info.mode & 0o777) !== 0o600
      || (typeof process.geteuid === "function" && info.uid !== process.geteuid()))) {
      throw refused(file, "initialization lock is not private to the current user");
  }
  await assertNoDarwinExtendedAllow(file, "initialization lock");
}

async function bindOfflineGuard(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", ready);
      const failure = new ServiceError(
        409,
        "Offline initialization requires exclusive 127.0.0.1:7373 ownership",
        "resource_busy"
      );
      failure.cause = error;
      reject(failure);
    };
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen({ host: "127.0.0.1", port: 7373, exclusive: true });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)));
}

function transactionDirectory(target: string): string {
  const basename = path.basename(target).normalize("NFC");
  const canonicalBasename = process.platform === "win32"
    ? basename.toLocaleLowerCase("en-US")
    : basename;
  const digest = createHash("sha256")
    .update(canonicalBasename, "utf8")
    .digest("hex");
  return path.join(path.dirname(target), `.1667-init-${digest}`);
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

function isLockContention(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["EACCES", "EAGAIN", "EBUSY", "EWOULDBLOCK", "ELOCKED"]
      .includes(String(error.code));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function refused(
  target: string,
  detail: string,
  includeRecoveryChoices = false
): ServiceError {
  const recovery = includeRecoveryChoices
    ? " Choose one: attach to a running backend with "
      + "1667 --url <owning-server-url> using that backend's printed URL; "
      + "initialize a different absent target with "
      + "1667 --data <absolute-absent-path> --initialize-new --offline-exclusive; "
      + "or, for known nonempty legacy v1 data only, open it offline with "
      + "1667 serve --legacy-v1 --offline-exclusive --data <absolute-legacy-path>. "
      + "No in-place migration was attempted."
    : "";
  return new ServiceError(
    409,
    `1667 data directory was left untouched: ${target} (${detail}).${recovery}`,
    "data_directory_unowned"
  );
}
