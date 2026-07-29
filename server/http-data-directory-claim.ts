import { createHash, randomBytes } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  stat
} from "node:fs/promises";
import path from "node:path";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile
} from "./private-file-publication.js";
import { isHttpDataDirectoryId } from "../shared/http-data-directory-id.js";
import {
  retainedDirectoryAuthorityPath,
  retainedDirectoryOpenFlags
} from "./retained-directory-authority.js";
import {
  readBtrfsIdentity,
  type BtrfsIdentity
} from "./http-btrfs-identity.js";
import { readLinuxUniqueMountId } from "./linux-mount-id.js";
import { readLinuxFileHandle } from "./linux-file-handle.js";
import { PublicRuntimeError } from "./errors.js";
import {
  HTTP_DATA_DIRECTORY_CLAIM_KEY_FILE,
  HTTP_DATA_DIRECTORY_CLAIM_KEY_LOCK_FILE
} from "./data-directory-layout.js";
import { withPrivateFileLock } from "./private-file-lock.js";

const MACHINE_CLAIM_KEY_LOCK_TIMEOUT_MS = 5_000;
const POLICY = Object.freeze({
  label: "1667 HTTP data-directory claim key",
  maxBytes: 65
});

export interface HttpDataDirectoryClaimInput {
  readonly machineDirectory: string;
  readonly dataDirectoryId: string;
  readonly dataDirectory: string;
}

export interface HttpDataDirectoryClaimAuthority {
  readonly authorityPath: string;
  readonly machineKey: string;
  readonly ownershipNamespace: string;
  release(): Promise<void>;
}

export async function readHttpDataDirectoryClaimId(
  input: HttpDataDirectoryClaimInput
): Promise<string> {
  const authority = await acquireHttpDataDirectoryClaimAuthority(input);
  try {
    return claimIdForAuthority(authority, input.dataDirectoryId);
  } finally {
    await authority.release();
  }
}

export async function readMachineLocalHttpDataDirectoryIdentity(
  input: {
    readonly machineDirectory: string;
    readonly dataDirectory: string;
  }
): Promise<{
  readonly dataDirectoryId: string;
  readonly dataDirectoryClaimId: string;
}> {
  const authority = await acquireHttpDataDirectoryClaimAuthority(input);
  try {
    const dataDirectoryId = createHash("sha256")
      .update("1667-machine-local-data-directory-id-v1", "utf8")
      .update("\0", "utf8")
      .update(Buffer.from(authority.machineKey, "hex"))
      .update("\0", "utf8")
      .update(authority.ownershipNamespace, "utf8")
      .digest("hex");
    return {
      dataDirectoryId,
      dataDirectoryClaimId: claimIdForAuthority(
        authority,
        dataDirectoryId
      )
    };
  } finally {
    await authority.release();
  }
}

export async function acquireHttpDataDirectoryClaimAuthority(input: {
  readonly machineDirectory: string;
  readonly dataDirectory: string;
}): Promise<HttpDataDirectoryClaimAuthority> {
  const handle = await open(input.dataDirectory, retainedDirectoryOpenFlags());
  try {
    const info = await handle.stat({ bigint: true });
    const authorityPath = retainedDirectoryAuthorityPath(
      input.dataDirectory,
      handle.fd
    );
    const [machineKey, canonicalFile] = await Promise.all([
      readMachineClaimKey(input.machineDirectory),
      realpath(authorityPath)
    ]);
    if (process.platform !== "linux") {
      const pathInfo = await stat(canonicalFile, { bigint: true });
      if (!pathInfo.isDirectory()
        || pathInfo.dev !== info.dev
        || pathInfo.ino !== info.ino) {
        throw new Error(
          "1667 HTTP data directory changed while its claim was read"
        );
      }
    }
    const ownershipNamespace = process.platform === "linux"
      ? await readLinuxOwnershipNamespace(
          canonicalFile,
          handle.fd,
          info.dev,
          info.ino
        )
      : [
          process.platform,
          canonicalFile,
          `device:${info.dev}`,
          `inode:${info.ino}`
        ].join("\0");
    let released = false;
    return {
      authorityPath,
      machineKey,
      ownershipNamespace,
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
      }
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function claimIdForAuthority(
  authority: Pick<
    HttpDataDirectoryClaimAuthority,
    "machineKey" | "ownershipNamespace"
  >,
  dataDirectoryId: string
): string {
  return deriveHttpDataDirectoryClaimId({
    machineKey: authority.machineKey,
    ownershipNamespace: authority.ownershipNamespace,
    dataDirectoryId
  });
}

export function deriveHttpDataDirectoryClaimId(input: {
  readonly machineKey: string;
  readonly dataDirectoryId: string;
  readonly ownershipNamespace: string;
}): string {
  if (!isHttpDataDirectoryId(input.machineKey)
    || !isHttpDataDirectoryId(input.dataDirectoryId)) {
    throw new Error("1667 HTTP data-directory claim input is invalid");
  }
  return createHash("sha256")
    .update("1667-data-directory-claim-v3", "utf8")
    .update("\0", "utf8")
    .update(Buffer.from(input.machineKey, "hex"))
    .update("\0", "utf8")
    .update(input.dataDirectoryId, "utf8")
    .update("\0", "utf8")
    .update(input.ownershipNamespace, "utf8")
    .digest("hex");
}

export function linuxMountOwnershipNamespace(
  input: {
    readonly canonicalPath: string;
    readonly mountInfo: string;
    readonly visibleMountId: string;
    readonly uniqueMountId: string;
    readonly fileHandle: string;
    readonly bootId: string;
    readonly device: bigint;
    readonly inode: bigint;
    readonly btrfsIdentity?: BtrfsIdentity;
  }
): string {
  return formatLinuxOwnershipNamespace(
    input.canonicalPath,
    selectLinuxMount(
      input.canonicalPath,
      input.mountInfo,
      input.visibleMountId
    ),
    input.device,
    input.inode,
    input.btrfsIdentity,
    input.bootId,
    input.uniqueMountId,
    input.fileHandle
  );
}

async function readLinuxOwnershipNamespace(
  canonicalPath: string,
  fileDescriptor: number,
  device: bigint,
  inode: bigint
): Promise<string> {
  const [
    mountInfo,
    descriptorInfo,
    bootIdFile,
    uniqueMountId,
    durableFileHandle
  ] = await Promise.all([
    readFile("/proc/self/mountinfo", "utf8"),
    readFile(`/proc/self/fdinfo/${fileDescriptor}`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readLinuxUniqueMountId(fileDescriptor, canonicalPath),
    readLinuxFileHandle(fileDescriptor, canonicalPath)
  ]);
  const visibleMountId = /^mnt_id:\s+([0-9]+)$/m.exec(descriptorInfo)?.[1];
  if (visibleMountId === undefined) {
    throw new Error(
      `1667 cannot identify the visible filesystem mount for ${canonicalPath}`
    );
  }
  const mount = selectLinuxMount(
    canonicalPath,
    mountInfo,
    visibleMountId
  );
  const btrfsIdentity = mount.fileSystemType === "btrfs"
    ? await readBtrfsIdentity(
        fileDescriptor,
        canonicalPath
      )
    : undefined;
  if (durableFileHandle === null) {
    throw new PublicRuntimeError(
      `HTTP server mode requires durable Linux file handles for ${canonicalPath}`
    );
  }
  return formatLinuxOwnershipNamespace(
    canonicalPath,
    mount,
    device,
    inode,
    btrfsIdentity,
    bootIdFile.trim(),
    uniqueMountId,
    durableFileHandle
  );
}

interface LinuxMountIdentity {
  readonly fileSystemType: string;
  readonly root: string;
  readonly mountPoint: string;
}

function selectLinuxMount(
  canonicalPath: string,
  mountInfo: string,
  visibleMountId: string
): LinuxMountIdentity {
  for (const line of mountInfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(" ");
    const fileSystemFields = line.slice(separator + 3).split(" ");
    if (fields.length < 6
      || fileSystemFields.length < 3
      || fields[0] !== visibleMountId) {
      continue;
    }
    const root = decodeMountInfoPath(fields[3] ?? "");
    const mountPoint = decodeMountInfoPath(fields[4] ?? "");
    if (!pathContains(mountPoint, canonicalPath)) {
      throw new Error(
        `1667 visible filesystem mount does not contain ${canonicalPath}`
      );
    }
    return {
      fileSystemType: fileSystemFields[0]!,
      root,
      mountPoint
    };
  }
  throw new Error(
    `1667 cannot find visible filesystem mount ${visibleMountId} for ${
      canonicalPath
    }`
  );
}

function formatLinuxOwnershipNamespace(
  canonicalPath: string,
  mount: LinuxMountIdentity,
  device: bigint,
  inode: bigint,
  btrfsIdentity: BtrfsIdentity | undefined,
  bootId: string,
  uniqueMountId: string,
  fileHandle: string
): string {
  const isBtrfs = mount.fileSystemType === "btrfs";
  if (isBtrfs !== (btrfsIdentity !== undefined)
    || !isLinuxBootId(bootId)
    || !/^[1-9][0-9]*$/.test(uniqueMountId)
    || !/^[1-9][0-9]*:[0-9a-f]{2,256}$/.test(fileHandle)
    || (btrfsIdentity !== undefined
      && (!/^[0-9a-f]{32}$/.test(btrfsIdentity.fileSystemId)
        || /^0{32}$/.test(btrfsIdentity.fileSystemId)
        || !/^[0-9]+$/.test(btrfsIdentity.rootId)
        || btrfsIdentity.rootId === "0"))) {
    throw new Error(
      `1667 cannot identify the filesystem for ${canonicalPath}`
    );
  }
  const mountLifetimeIdentity = [
    `boot:${bootId}`,
    `mount:${uniqueMountId}`,
    `file-handle:${fileHandle}`
  ];
  const storageIdentity = btrfsIdentity === undefined
    ? [
        ...mountLifetimeIdentity,
        `device:${device}`,
        `inode:${inode}`
      ]
    : [
        ...mountLifetimeIdentity,
        `btrfs-filesystem:${btrfsIdentity.fileSystemId}`,
        `btrfs-root:${btrfsIdentity.rootId}`,
        `inode:${inode}`
      ];
  return [
    "linux-filesystem-v4",
    mount.fileSystemType,
    mount.root,
    mount.mountPoint,
    canonicalPath,
    ...storageIdentity
  ].join("\0");
}

function isLinuxBootId(value: string): boolean {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

async function readMachineClaimKey(machineDirectory: string): Promise<string> {
  const file = path.join(
    machineDirectory,
    HTTP_DATA_DIRECTORY_CLAIM_KEY_FILE
  );
  return await withMachineClaimKeyLock(machineDirectory, async () => {
    const bytes = await readOptionalPrivateFile(file, POLICY);
    if (bytes !== null) {
      const key = decodeMachineClaimKey(bytes);
      if (key === null) {
        throw new Error("1667 HTTP data-directory claim key is malformed");
      }
      return key;
    }
    const candidateKey = randomBytes(32).toString("hex");
    await publishPrivateFileNoReplace(
      file,
      Buffer.from(`${candidateKey}\n`, "utf8"),
      POLICY
    );
    return candidateKey;
  });
}

function decodeMachineClaimKey(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const key = text.endsWith("\n") ? text.slice(0, -1) : "";
  return text.length === 65 && isHttpDataDirectoryId(key) ? key : null;
}

async function withMachineClaimKeyLock<T>(
  machineDirectory: string,
  work: () => Promise<T>
): Promise<T> {
  return await withPrivateFileLock({
    directory: machineDirectory,
    fileName: HTTP_DATA_DIRECTORY_CLAIM_KEY_LOCK_FILE,
    directoryLabel: POLICY.label,
    timeoutMs: MACHINE_CLAIM_KEY_LOCK_TIMEOUT_MS,
    contentionMessage: (lockPath) =>
      `1667 HTTP data-directory claim key is locked by another process: ${
        lockPath
      }`
  }, work);
}

function decodeMountInfoPath(value: string): string {
  return value.replace(
    /\\(011|012|040|134)/g,
    (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function pathContains(parent: string, candidate: string): boolean {
  return parent === "/"
    ? candidate.startsWith("/")
    : candidate === parent || candidate.startsWith(`${parent}/`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
