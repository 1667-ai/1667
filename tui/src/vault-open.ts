import path from "node:path";
import { readBoundedRegularFile } from "../../server/data-directory-file-read.js";
import {
  MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
  parseDataDirectoryOwnerMarkerBytes
} from "../../server/data-directory-format.js";
import { parseKeyslot, unsealKeyslot } from "../../shared/vault-cipher.js";
import {
  canPromptForProject,
  promptVaultPassword,
  type ProjectPromptStreams
} from "./project-prompt.js";

const KEYSLOT_FILE = "vault.json";
const MAX_KEYSLOT_BYTES = 16 * 1024;

export interface OpenedVault {
  readonly key: Buffer;
  readonly keyslotBytes: Buffer;
}

/** The owner marker is the authority on whether this project is sealed. */
export async function isSealedVault(dataDirectory: string): Promise<boolean> {
  return (await inspectVault(dataDirectory))?.dataFormat === 5;
}

/**
 * Open a sealed vault before its process lock is acquired. The caller must
 * revalidate the returned Keyslot after it owns the lock.
 */
export async function openSealedVault(
  dataDirectory: string,
  streams: ProjectPromptStreams = { input: process.stdin, output: process.stdout }
): Promise<OpenedVault | null> {
  const sealed = await inspectVault(dataDirectory);
  if (sealed === null) return null;
  const { keyslotBytes, keyslot } = sealed;
  if (!canPromptForProject(streams)) {
    throw new Error("a sealed vault requires a TTY Vault Password prompt");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = await promptVaultPassword(streams);
    try {
      return { key: await unsealKeyslot(password, keyslot), keyslotBytes };
    } catch {
      if (attempt < 2) streams.output.write("Incorrect Vault Password. Try again.\n");
    }
  }
  throw new Error("Vault Password failed three times");
}

/** Open a sealed vault with a password supplied by a non-interactive command. */
export async function openSealedVaultWithPassword(
  dataDirectory: string,
  password: string
): Promise<OpenedVault | null> {
  const sealed = await inspectVault(dataDirectory);
  if (sealed === null) return null;
  try {
    return {
      key: await unsealKeyslot(password, sealed.keyslot),
      keyslotBytes: sealed.keyslotBytes
    };
  } catch {
    throw new Error("Vault Password is incorrect");
  }
}

/** Recheck the sealing fence and Keyslot while the caller owns the lock. */
export async function revalidateSealedVault(
  dataDirectory: string,
  expectedKeyslotBytes: Uint8Array
): Promise<void> {
  if (await readOwnerFormat(dataDirectory) !== 5) {
    throw new Error("vault changed during the Vault Password prompt; start again");
  }
  const actual = await readKeyslotBytes(dataDirectory);
  if (!Buffer.from(actual).equals(Buffer.from(expectedKeyslotBytes))) {
    throw new Error("vault changed during the Vault Password prompt; start again");
  }
  const keyslot = parseKeyslot(actual);
  if (keyslot.state === "sealing") {
    throw new Error("vault sealing is incomplete; run '1667 encrypt' again");
  }
  if (keyslot.state === "unsealing") {
    throw new Error("vault unsealing is incomplete; run '1667 decrypt' again");
  }
  if (keyslot.state !== "sealed") {
    throw new Error("vault changed during the Vault Password prompt; start again");
  }
}

/** Refuse a plain open when another process sealed the vault before its lock. */
export async function revalidateUnsealedVault(dataDirectory: string): Promise<void> {
  if (await inspectVault(dataDirectory) !== null) {
    throw new Error("vault became sealed while it was opening; start again with its Vault Password");
  }
}

async function readOwnerFormat(dataDirectory: string): Promise<number> {
  const marker = path.join(dataDirectory, "owner.json");
  const bytes = await readBoundedRegularFile(marker, MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES, {
    requirePrivate: true
  });
  return parseDataDirectoryOwnerMarkerBytes(bytes, marker).dataFormat;
}

async function inspectVault(dataDirectory: string): Promise<{
  readonly dataFormat: number;
  readonly keyslotBytes: Buffer;
  readonly keyslot: ReturnType<typeof parseKeyslot>;
} | null> {
  let dataFormat: number;
  try {
    dataFormat = await readOwnerFormat(dataDirectory);
  } catch (error) {
    // Unmarked and legacy-preview projects take the normal initialization
    // path. Only the format-5 owner marker is sealing authority.
    if (isMissing(error)) return null;
    throw error;
  }
  let keyslotBytes: Buffer | null;
  try {
    keyslotBytes = await readBoundedRegularFile(
      path.join(dataDirectory, KEYSLOT_FILE),
      MAX_KEYSLOT_BYTES,
      { requirePrivate: true }
    );
  } catch (error) {
    if (dataFormat !== 5 && isMissing(error)) return null;
    throw new Error("sealed vault Keyslot is unavailable; restore .1667/vault.json from a backup");
  }
  let keyslot: ReturnType<typeof parseKeyslot>;
  try {
    keyslot = parseKeyslot(keyslotBytes);
  } catch (error) {
    if (dataFormat === 5) {
      throw new Error("sealed vault Keyslot is unavailable; restore .1667/vault.json from a backup");
    }
    throw error;
  }
  if (keyslot.state === "sealing") {
    throw new Error("vault sealing is incomplete; run '1667 encrypt' again");
  }
  if (keyslot.state === "unsealing") {
    throw new Error("vault unsealing is incomplete; run '1667 decrypt' again");
  }
  if (dataFormat !== 5) {
    throw new Error("Vault Keyslot does not match the owner marker; run '1667 decrypt' again");
  }
  return { dataFormat, keyslotBytes, keyslot };
}

async function readKeyslotBytes(dataDirectory: string): Promise<Buffer> {
  const keyslot = path.join(dataDirectory, KEYSLOT_FILE);
  try {
    return await readBoundedRegularFile(keyslot, MAX_KEYSLOT_BYTES, { requirePrivate: true });
  } catch {
    throw new Error("sealed vault Keyslot is unavailable; restore .1667/vault.json from a backup");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
