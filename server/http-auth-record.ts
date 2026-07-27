import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  decodeHttpAuthRecord,
  encodeHttpAuthRecord,
  MAX_HTTP_AUTH_RECORD_BYTES,
  type HttpAuthRecord
} from "../shared/http-auth.js";
import { parseCanonicalLoopbackOrigin } from "../shared/http-loopback-origin.js";
import {
  noFollowFlag,
  readBoundedRegularFile,
  readBoundedMutableAuthorityFile,
  requireBoundedRegularFile,
  requireSameFileIdentity
} from "./data-directory-file-read.js";
import {
  inspectPrivateDirectory,
  syncPrivateDirectory
} from "./private-file-publication.js";
import {
  resolvePrivatePlatformStateRoot,
  type PlatformStateRootOptions
} from "./platform-state-root.js";
import { resolveMachineTierRoot } from "./machine-tier.js";

const AUTH_DIRECTORY_NAME = "http";

export interface HttpAuthRecordPaths {
  readonly directory: string;
  readonly final: string;
  readonly next: string;
}

export interface HttpAuthRecordLease {
  readonly record: HttpAuthRecord;
  readonly paths: HttpAuthRecordPaths;
  removeOwnRecord(): Promise<void>;
}

export interface HttpAuthRecordStoreOptions {
  readonly stateRoot?: string;
  readonly platformState?: PlatformStateRootOptions;
  readonly publicationHooks?: {
    readonly afterRename?: () => void | Promise<void>;
  };
}

export async function createHttpAuthRecord(
  originInput: string,
  options: HttpAuthRecordStoreOptions = {}
): Promise<HttpAuthRecordLease> {
  const origin = parseCanonicalLoopbackOrigin(originInput).origin;
  const record: HttpAuthRecord = {
    schema: 1,
    origin,
    instanceId: randomUUID(),
    capabilities: {
      story: randomBytes(32).toString("hex"),
      admin: randomBytes(32).toString("hex")
    }
  };
  const paths = await resolveHttpAuthRecordPaths(origin, options);
  await publishRecord(paths, record, options);
  return {
    record,
    paths,
    removeOwnRecord: async () => await removeOwnRecord(paths, record)
  };
}

export async function readHttpAuthRecord(
  originInput: string,
  options: HttpAuthRecordStoreOptions = {}
): Promise<{ readonly record: HttpAuthRecord; readonly paths: HttpAuthRecordPaths }> {
  const origin = parseCanonicalLoopbackOrigin(originInput).origin;
  const paths = await resolveHttpAuthRecordPaths(origin, options);
  const record = decodeHttpAuthRecord(await readBoundedMutableAuthorityFile(
    paths.final,
    MAX_HTTP_AUTH_RECORD_BYTES,
    { requirePrivate: true }
  ));
  if (record.origin !== origin) {
    throw new Error("1667 HTTP auth record origin does not match its filename");
  }
  return { record, paths };
}

export async function readHttpAuthRecordFile(
  file: string,
  options: HttpAuthRecordStoreOptions = {}
): Promise<{ readonly record: HttpAuthRecord; readonly paths: HttpAuthRecordPaths }> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || path.resolve(file) !== file) {
    throw new Error("--auth-file must be an absolute canonical path");
  }
  const candidate = decodeHttpAuthRecord(await readBoundedMutableAuthorityFile(
    file,
    MAX_HTTP_AUTH_RECORD_BYTES,
    { requirePrivate: true }
  ));
  const paths = await resolveHttpAuthRecordPaths(candidate.origin, options);
  if (file !== paths.final) {
    throw new Error("--auth-file must be inside the canonical 1667 auth root");
  }
  return await readHttpAuthRecord(candidate.origin, options);
}

export async function resolveHttpAuthRecordPaths(
  originInput: string,
  options: HttpAuthRecordStoreOptions = {}
): Promise<HttpAuthRecordPaths> {
  const origin = parseCanonicalLoopbackOrigin(originInput).origin;
  const stateRoot = options.stateRoot
    ?? await (options.platformState === undefined
      ? resolveMachineTierRoot()
      : resolvePrivatePlatformStateRoot(options.platformState));
  const directory = path.join(stateRoot, AUTH_DIRECTORY_NAME);
  await ensurePrivateDirectory(directory);
  const digest = createHash("sha256").update(origin, "utf8").digest("hex");
  const final = path.join(directory, `${digest}.json`);
  return { directory, final, next: `${final}.next` };
}

async function publishRecord(
  paths: HttpAuthRecordPaths,
  record: HttpAuthRecord,
  options: HttpAuthRecordStoreOptions
): Promise<void> {
  await inspectPrivateDirectory(paths.directory, "1667 HTTP auth directory");
  await removeStaleNext(paths.next);
  await validateOptionalFinal(paths.final, record.origin);
  const bytes = Buffer.from(encodeHttpAuthRecord(record), "utf8");
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      paths.next,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    if (process.platform !== "win32") await handle.chmod(0o600);
    const created = await handle.stat();
    requirePrivateRecord(created, paths.next);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    requirePrivateRecord(written, paths.next);
    if (written.size !== bytes.byteLength) {
      throw new Error("1667 HTTP auth record write was incomplete");
    }
    const linked = await lstat(paths.next);
    requirePrivateRecord(linked, paths.next);
    requireSameFileIdentity(written, linked, paths.next);
  } finally {
    await handle?.close();
  }
  const staged = await readBoundedRegularFile(
    paths.next,
    MAX_HTTP_AUTH_RECORD_BYTES,
    { requirePrivate: true }
  );
  const decoded = decodeHttpAuthRecord(staged);
  if (decoded.origin !== record.origin || decoded.instanceId !== record.instanceId) {
    throw new Error("1667 HTTP auth staging record changed before publication");
  }
  await rename(paths.next, paths.final);
  try {
    await options.publicationHooks?.afterRename?.();
    await syncPrivateDirectory(paths.directory, "1667 HTTP auth directory");
    const published = decodeHttpAuthRecord(await readBoundedRegularFile(
      paths.final,
      MAX_HTTP_AUTH_RECORD_BYTES,
      { requirePrivate: true }
    ));
    if (published.origin !== record.origin || published.instanceId !== record.instanceId) {
      throw new Error("1667 HTTP auth record changed during publication");
    }
  } catch (publicationError) {
    try {
      await removeOwnRecord(paths, record);
    } catch (rollbackError) {
      throw new AggregateError(
        [publicationError, rollbackError],
        "1667 HTTP auth publication and rollback both failed",
        { cause: publicationError }
      );
    }
    throw publicationError;
  }
}

async function removeOwnRecord(
  paths: HttpAuthRecordPaths,
  record: HttpAuthRecord
): Promise<void> {
  try {
    const current = decodeHttpAuthRecord(await readBoundedRegularFile(
      paths.final,
      MAX_HTTP_AUTH_RECORD_BYTES,
      { requirePrivate: true }
    ));
    if (current.origin !== record.origin || current.instanceId !== record.instanceId) return;
    await unlink(paths.final);
    await syncPrivateDirectory(paths.directory, "1667 HTTP auth directory");
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function validateOptionalFinal(file: string, origin: string): Promise<void> {
  try {
    const record = decodeHttpAuthRecord(await readBoundedRegularFile(
      file,
      MAX_HTTP_AUTH_RECORD_BYTES,
      { requirePrivate: true }
    ));
    if (record.origin !== origin) {
      throw new Error("1667 stale HTTP auth record has the wrong origin");
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function removeStaleNext(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    requirePrivateRecord(info, file);
    await unlink(file);
    await syncPrivateDirectory(path.dirname(file), "1667 HTTP auth directory");
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  await inspectPrivateDirectory(directory, "1667 HTTP auth directory");
}

function requirePrivateRecord(info: Stats, file: string): void {
  requireBoundedRegularFile(info, file, MAX_HTTP_AUTH_RECORD_BYTES, {
    requirePrivate: true,
    allowedLinkCounts: [1]
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
