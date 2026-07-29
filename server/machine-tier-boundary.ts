import {
  open,
  readFile,
  realpath,
  statfs,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { PublicRuntimeError } from "./errors.js";
import { readBtrfsIdentity } from "./http-btrfs-identity.js";
import {
  retainedDirectoryOpenFlags
} from "./retained-directory-authority.js";

const BTRFS_SUPER_MAGIC = 0x9123_683en;

export function assertMachineTierPathOutsideDirectory(
  directoryInput: string,
  machineDirectoryInput: string,
  message: string
): void {
  const directory = path.resolve(directoryInput);
  const machineDirectory = path.resolve(machineDirectoryInput);
  if (pathIsInside(directory, machineDirectory)) {
    throw new PublicRuntimeError(message);
  }
}

export async function assertPathInsideDirectory(
  directoryInput: string,
  candidateInput: string,
  message: string
): Promise<void> {
  const [directory, candidate] = await Promise.all([
    resolveProspectiveCanonicalPath(directoryInput),
    resolveProspectiveCanonicalPath(candidateInput)
  ]);
  if (!pathIsInside(directory, candidate)) {
    throw new PublicRuntimeError(message);
  }
}

export async function assertMachineTierOutsideDirectory(
  directoryInput: string,
  machineDirectoryInput: string,
  message: string
): Promise<void> {
  assertMachineTierPathOutsideDirectory(
    directoryInput,
    machineDirectoryInput,
    message
  );
  const [canonicalDirectory, prospectiveMachineDirectory] = await Promise.all([
    resolveProspectiveCanonicalPath(directoryInput),
    resolveProspectiveCanonicalPath(machineDirectoryInput)
  ]);
  assertMachineTierPathOutsideDirectory(
    canonicalDirectory,
    prospectiveMachineDirectory,
    message
  );
  if (process.platform !== "linux") return;
  let directoryHandle: FileHandle;
  try {
    directoryHandle = await open(
      directoryInput,
      retainedDirectoryOpenFlags()
    );
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  try {
    const reference = await directoryIdentity(
      directoryHandle,
      directoryInput
    );
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    let candidate = prospectiveMachineDirectory;
    while (true) {
      if (await sameDirectoryAtPath(reference, candidate, mountInfo)) {
        throw new PublicRuntimeError(message);
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  } finally {
    await directoryHandle.close();
  }
}

interface DirectoryIdentity {
  readonly handle: FileHandle;
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: string;
}

export async function resolveProspectiveCanonicalPath(
  input: string
): Promise<string> {
  let existing = path.resolve(input);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...suffix);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`1667 cannot resolve prospective path ${input}`);
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
}

function pathIsInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

async function directoryIdentity(
  handle: FileHandle,
  inputPath: string
): Promise<DirectoryIdentity> {
  const info = await handle.stat({ bigint: true });
  if (!info.isDirectory()) {
    throw new PublicRuntimeError(
      `1667 requires a directory: ${inputPath}`
    );
  }
  const descriptorInfo = await readFile(
    `/proc/self/fdinfo/${handle.fd}`,
    "utf8"
  );
  const mountId = /^mnt_id:\s+([0-9]+)$/m.exec(descriptorInfo)?.[1];
  if (mountId === undefined) {
    throw new Error(`1667 cannot identify the mount for ${inputPath}`);
  }
  return {
    handle,
    canonicalPath: await realpath(`/proc/self/fd/${handle.fd}`),
    device: info.dev,
    inode: info.ino,
    mountId
  };
}

async function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
  mountInfo: string
): Promise<boolean> {
  if (linuxMountPathIsInsideDirectory({
    directoryPath: left.canonicalPath,
    candidatePath: right.canonicalPath,
    directoryMountId: left.mountId,
    candidateMountId: right.mountId,
    mountInfo
  })) {
    return true;
  }
  if (left.device !== right.device || left.inode !== right.inode) {
    return false;
  }
  const [leftFileSystem, rightFileSystem] = await Promise.all([
    statfs(`/proc/self/fd/${left.handle.fd}`, { bigint: true }),
    statfs(`/proc/self/fd/${right.handle.fd}`, { bigint: true })
  ]);
  if (leftFileSystem.type !== BTRFS_SUPER_MAGIC
    || rightFileSystem.type !== BTRFS_SUPER_MAGIC) {
    return true;
  }
  const [leftBtrfs, rightBtrfs] = await Promise.all([
    readBtrfsIdentity(left.handle.fd, left.canonicalPath),
    readBtrfsIdentity(right.handle.fd, right.canonicalPath)
  ]);
  return leftBtrfs.fileSystemId === rightBtrfs.fileSystemId
    && leftBtrfs.rootId === rightBtrfs.rootId;
}

async function sameDirectoryAtPath(
  reference: DirectoryIdentity,
  candidatePath: string,
  mountInfo: string
): Promise<boolean> {
  let candidate: FileHandle;
  try {
    candidate = await open(candidatePath, retainedDirectoryOpenFlags());
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    return await sameDirectoryIdentity(
      reference,
      await directoryIdentity(candidate, candidatePath),
      mountInfo
    );
  } finally {
    await candidate.close();
  }
}

interface LinuxMountBoundaryInput {
  readonly directoryPath: string;
  readonly candidatePath: string;
  readonly directoryMountId: string;
  readonly candidateMountId: string;
  readonly mountInfo: string;
}

interface LinuxMountEntry {
  readonly device: string;
  readonly root: string;
  readonly mountPoint: string;
}

/** Test whether a visible candidate mount resolves inside a directory mount. */
export function linuxMountPathIsInsideDirectory(
  input: LinuxMountBoundaryInput
): boolean {
  const directoryMount = selectMountEntry(
    input.mountInfo,
    input.directoryMountId
  );
  const candidateMount = selectMountEntry(
    input.mountInfo,
    input.candidateMountId
  );
  if (directoryMount === null
    || candidateMount === null
    || directoryMount.device !== candidateMount.device) {
    return false;
  }
  const directoryFileSystemPath = fileSystemPath(
    directoryMount,
    input.directoryPath
  );
  const candidateFileSystemPath = fileSystemPath(
    candidateMount,
    input.candidatePath
  );
  return pathIsInside(directoryFileSystemPath, candidateFileSystemPath);
}

function selectMountEntry(
  mountInfo: string,
  mountId: string
): LinuxMountEntry | null {
  for (const line of mountInfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6 || fields[0] !== mountId) continue;
    return {
      device: fields[2]!,
      root: decodeMountInfoPath(fields[3]!),
      mountPoint: decodeMountInfoPath(fields[4]!)
    };
  }
  return null;
}

function fileSystemPath(
  mount: LinuxMountEntry,
  visiblePath: string
): string {
  if (!pathIsInside(mount.mountPoint, visiblePath)) {
    throw new Error(
      `1667 visible filesystem mount does not contain ${visiblePath}`
    );
  }
  return path.join(
    mount.root,
    path.relative(mount.mountPoint, visiblePath)
  );
}

function decodeMountInfoPath(value: string): string {
  return value.replace(
    /\\(011|012|040|134)/g,
    (_match, octal: string) => String.fromCharCode(
      Number.parseInt(octal, 8)
    )
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
