import { randomBytes } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import {
  lstat,
  open,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile
} from "./private-file-publication.js";
import { DATA_DIRECTORY_ID_FILE } from "./data-directory-layout.js";
import {
  DATA_DIRECTORY_ID_GITIGNORE_BLOCK,
  PROJECT_GITIGNORE_FILE,
  projectGitignoreContent
} from "./project-layout.js";
import {
  noFollowFlag,
  requireSameFileIdentity,
  sameFileSnapshot
} from "./data-directory-file-read.js";
import {
  syncDirectory,
  writeDurableFile
} from "./story-lifecycle.js";
import { isHttpDataDirectoryId } from "../shared/http-data-directory-id.js";
import {
  acquireHttpDataDirectoryClaimAuthority,
  claimIdForAuthority
} from "./http-data-directory-claim.js";
import {
  managedProjectIgnoreStatesAreEffective
} from "./project-gitignore-rules.js";

const POLICY = Object.freeze({
  label: "1667 data-directory ID",
  maxBytes: 66,
  allowLegacyReadMode: true
});
const MAX_IGNORE_SUFFIX_BYTES = 256 * 1024;

export interface HttpDataDirectoryIdentity {
  readonly dataDirectoryId: string;
  readonly dataDirectoryClaimId: string;
}

/**
 * Read one durable lineage ID and one live filesystem claim.
 * A copy keeps the lineage ID and gets a different claim ID.
 */
export async function readHttpDataDirectoryIdentity(
  dataDirectory: string,
  machineDirectory: string
): Promise<HttpDataDirectoryIdentity> {
  const authority = await acquireHttpDataDirectoryClaimAuthority({
    machineDirectory,
    dataDirectory
  });
  try {
    const authorityPath = authority.authorityPath;
    const file = path.join(authorityPath, DATA_DIRECTORY_ID_FILE);
    await ensureDataDirectoryId(authorityPath, file);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await lstat(file, { bigint: true });
      const bytes = await readOptionalPrivateFile(file, POLICY);
      const after = await lstat(file, { bigint: true });
      if (bytes !== null && sameDataIdSnapshot(before, after)) {
        const dataDirectoryId = decodeDataDirectoryId(bytes);
        const identity = {
          dataDirectoryId,
          dataDirectoryClaimId: claimIdForAuthority(
            authority,
            dataDirectoryId
          )
        };
        const final = await lstat(file, { bigint: true });
        if (sameDataIdSnapshot(after, final)) return identity;
      }
    }
    throw new Error("1667 data-directory ID changed while it was read");
  } finally {
    await authority.release();
  }
}

async function ensureDataDirectoryId(
  dataDirectory: string,
  file: string
): Promise<void> {
  await ensureIdentityGitRules(dataDirectory);
  if (await readOptionalPrivateFile(file, POLICY) !== null) return;
  const candidate = Buffer.from(
    `${randomBytes(32).toString("hex")}\n`,
    "utf8"
  );
  try {
    await publishPrivateFileNoReplace(file, candidate, POLICY);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    if (await readOptionalPrivateFile(file, POLICY) === null) {
      throw new Error("1667 data-directory ID disappeared during creation");
    }
  }
}

function decodeDataDirectoryId(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const seed = text.length === 65 && text.endsWith("\n")
    ? text.slice(0, -1)
    : text.length === 66 && text.endsWith("\r\n")
      ? text.slice(0, -2)
      : "";
  if (!isHttpDataDirectoryId(seed)) {
    throw new Error("1667 data-directory ID is malformed");
  }
  return seed;
}

async function ensureIdentityGitRules(dataDirectory: string): Promise<void> {
  const file = path.join(dataDirectory, PROJECT_GITIGNORE_FILE);
  for (;;) {
    try {
      await ensureIdentityGitBlock(file);
      return;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    try {
      await writeDurableFile(file, projectGitignoreContent());
      return;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
  }
}

async function ensureIdentityGitBlock(file: string): Promise<void> {
  const block = Buffer.from(DATA_DIRECTORY_ID_GITIGNORE_BLOCK, "utf8");
  const checkoutBlock = Buffer.from(
    DATA_DIRECTORY_ID_GITIGNORE_BLOCK.replace(/\n/g, "\r\n"),
    "utf8"
  );
  const readable = await openValidatedIgnoreFile(file, constants.O_RDONLY);
  let needsManagedBlock: boolean;
  try {
    ({ needsManagedBlock } = await scanStableIgnoreFile(
      readable.handle,
      readable.info,
      file,
      [block, checkoutBlock]
    ));
  } finally {
    await readable.handle.close();
  }
  if (!needsManagedBlock) return;

  const writable = await openValidatedIgnoreFile(
    file,
    constants.O_RDWR | constants.O_APPEND
  );
  try {
    const before = writable.info;
    const latest = await scanStableIgnoreFile(
      writable.handle,
      before,
      file,
      [block, checkoutBlock]
    );
    if (!latest.needsManagedBlock) return;
    const separator = latest.lastByte === undefined
      || latest.lastByte === 0x0a
      ? Buffer.alloc(0)
      : Buffer.from("\n", "utf8");
    const addition = Buffer.concat([separator, block]);
    await writable.handle.writeFile(addition);
    await writable.handle.sync();
    const after = await writable.handle.stat();
    requireRegularIgnoreFile(after, file);
    requireSameFileIdentity(before, after, file);
    if (after.size !== before.size + addition.byteLength) {
      throw new Error(`1667 project ignore file changed: ${file}`);
    }
    const finalPathInfo = await lstat(file);
    requireRegularIgnoreFile(finalPathInfo, file);
    requireSameFileIdentity(after, finalPathInfo, file);
  } finally {
    await writable.handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function openValidatedIgnoreFile(
  file: string,
  flags: number
): Promise<{ readonly handle: FileHandle; readonly info: Stats }> {
  const pathInfo = await lstat(file);
  requireRegularIgnoreFile(pathInfo, file);
  const handle = await open(file, flags | noFollowFlag());
  try {
    const info = await handle.stat();
    requireRegularIgnoreFile(info, file);
    requireSameFileIdentity(pathInfo, info, file);
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function scanStableIgnoreFile(
  handle: FileHandle,
  before: Stats,
  file: string,
  blocks: readonly Buffer[]
): Promise<{
  readonly needsManagedBlock: boolean;
  readonly lastByte: number | undefined;
}> {
  const longestBlockBytes = Math.max(
    ...blocks.map((block) => block.byteLength)
  );
  const tailOffset = Math.max(
    0,
    before.size - MAX_IGNORE_SUFFIX_BYTES - longestBlockBytes
  );
  const tail = await readIgnoreRange(
    handle,
    tailOffset,
    before.size,
    file
  );
  let lastBlockEnd = -1;
  for (const block of blocks) {
    for (
      let index = tail.indexOf(block);
      index >= 0;
      index = tail.indexOf(block, index + 1)
    ) {
      lastBlockEnd = Math.max(
        lastBlockEnd,
        tailOffset + index + block.byteLength
      );
    }
  }
  const needsManagedBlock = lastBlockEnd < 0
    || before.size - lastBlockEnd > MAX_IGNORE_SUFFIX_BYTES
    || !managedProjectIgnoreStatesAreEffective(
      tail.subarray(lastBlockEnd - tailOffset)
    );
  const after = await handle.stat();
  requireRegularIgnoreFile(after, file);
  if (!sameFileSnapshot(before, after)) {
    throw new Error(`1667 project ignore file changed: ${file}`);
  }
  const pathInfo = await lstat(file);
  requireRegularIgnoreFile(pathInfo, file);
  if (!sameFileSnapshot(after, pathInfo)) {
    throw new Error(`1667 project ignore file changed: ${file}`);
  }
  return {
    needsManagedBlock,
    lastByte: tail[tail.byteLength - 1]
  };
}

async function readIgnoreRange(
  handle: FileHandle,
  offset: number,
  fileSize: number,
  file: string
): Promise<Buffer> {
  const bytes = Buffer.alloc(fileSize - offset);
  let position = 0;
  while (position < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      position,
      bytes.byteLength - position,
      offset + position
    );
    if (bytesRead <= 0) {
      throw new Error(`1667 project ignore file changed: ${file}`);
    }
    position += bytesRead;
  }
  return bytes;
}

function requireRegularIgnoreFile(
  info: Awaited<ReturnType<typeof lstat>>,
  file: string
): void {
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error(`1667 project ignore file is not a regular file: ${file}`);
  }
}

function sameFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDataIdSnapshot(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
