import { constants } from "node:fs";
import { link, lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  createKeyslot,
  encodeKeyslot,
  isSealed,
  keyslotWithState,
  parseKeyslot,
  sealVaultBytes,
  unsealKeyslot,
  unsealVaultBytes
} from "../shared/vault-cipher.js";
import {
  VAULT_KEYSLOT_FILE
} from "./data-directory-layout.js";
import { publishDataDirectoryOwnerMarker } from "./data-directory-format.js";
import { DataDirectoryLock } from "./data-directory-lock.js";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { replacePrivateFile } from "./private-file-replacement.js";
import { syncDirectory } from "./story-lifecycle.js";
import { isVaultControlPath } from "./vault-key-registry.js";
import {
  isVaultUnsealProgressPath,
  VaultUnsealProgress
} from "./vault-unseal-progress.js";

export { VAULT_KEYSLOT_FILE } from "./data-directory-layout.js";

const VAULT_KEYSLOT_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Vault Keyslot",
  maxBytes: 16 * 1024
});
const VAULT_REPLACE_RESIDUE = /^\.1667-vault-replace-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const RUN_RECORD_ATOMIC_RESIDUE = /^run\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

interface VaultFileEntry {
  readonly file: string;
  readonly group: string;
  readonly isControl: boolean;
}

interface VaultInodeGroup {
  readonly group: string;
  readonly representative: string;
  readonly controls: string[];
  readonly payloads: string[];
}

export interface VaultLifecycleOptions {
  readonly dataDirectory: string;
  readonly password: VaultPassword;
}

export interface VaultDecryptLifecycleOptions {
  readonly dataDirectory: string;
  readonly password?: VaultPassword;
  /** @internal Test seam for a crash after one durable unseal replacement. */
  readonly afterUnsealReplacement?: (files: readonly string[]) => Promise<void>;
}

export type VaultPassword = string | VaultPasswordProvider;

/** The lifecycle calls this only after it owns the data-directory lock. */
export type VaultPasswordProvider = (
  request: VaultPasswordRequest
) => Promise<string>;

export interface VaultPasswordRequest {
  readonly command: "encrypt" | "decrypt";
  readonly resume: boolean;
}

/** Seal one stopped vault. A second call resumes an interrupted seal pass. */
export async function encryptVault(options: VaultLifecycleOptions): Promise<void> {
  const lock = new DataDirectoryLock(options.dataDirectory);
  await lock.acquire();
  try {
    const root = lock.authorityPath;
    const keyslotPath = path.join(root, VAULT_KEYSLOT_FILE);
    const bytes = await readOptionalPrivateFile(keyslotPath, VAULT_KEYSLOT_POLICY);
    if (bytes === null) {
      if (lock.dataFormat !== 4) throw new Error("encrypt requires data format 4 and no Vault Keyslot");
      await VaultUnsealProgress.assertAbsent(root);
      await assertVaultTraversalSafe(root);
      const password = await resolveVaultPassword(options.password, {
        command: "encrypt",
        resume: false
      });
      const key = randomBytes(32);
      const keyslot = await createKeyslot(password, key);
      await publishPrivateFileNoReplace(
        keyslotPath,
        encodeKeyslot(keyslotWithState(keyslot, "sealing")),
        VAULT_KEYSLOT_POLICY
      );
      await publishDataDirectoryOwnerMarker(root, 5);
      await sealFiles(root, key);
      await replaceKeyslotState(keyslotPath, keyslot, "sealed");
      return;
    }
    const keyslot = parseKeyslot(bytes);
    if (keyslot.state !== "sealing") {
      throw new Error("vault is not ready to encrypt; run 1667 decrypt first if it is sealed");
    }
    if (lock.dataFormat !== 4 && lock.dataFormat !== 5) {
      throw new Error("encrypt resume requires data format 4 or 5");
    }
    await VaultUnsealProgress.assertAbsent(root);
    await assertVaultTraversalSafe(root);
    const password = await resolveVaultPassword(options.password, {
      command: "encrypt",
      resume: true
    });
    const key = await unsealKeyslot(password, keyslot);
    if (lock.dataFormat === 4) await publishDataDirectoryOwnerMarker(root, 5);
    await sealFiles(root, key);
    await replaceKeyslotState(keyslotPath, keyslot, "sealed");
  } finally {
    await lock.release();
  }
}

/** Unseal one stopped vault. A second call resumes an interrupted unseal pass. */
export async function decryptVault(options: VaultDecryptLifecycleOptions): Promise<void> {
  const lock = new DataDirectoryLock(options.dataDirectory);
  await lock.acquire();
  try {
    const root = lock.authorityPath;
    const keyslotPath = path.join(root, VAULT_KEYSLOT_FILE);
    const bytes = await readOptionalPrivateFile(keyslotPath, VAULT_KEYSLOT_POLICY);
    if (bytes === null) throw new Error("decrypt requires a Vault Keyslot");
    const keyslot = parseKeyslot(bytes);
    if (keyslot.state === "unsealing" && lock.dataFormat === 4) {
      await (await VaultUnsealProgress.load(root)).clear();
      await removePrivateFile(keyslotPath, VAULT_KEYSLOT_POLICY);
      return;
    }
    if (keyslot.state !== "sealed" && keyslot.state !== "unsealing") {
      throw new Error("vault is still sealing; run 1667 encrypt again");
    }
    if (lock.dataFormat !== 5) throw new Error("decrypt requires data format 5");
    await assertVaultTraversalSafe(root);
    if (options.password === undefined) {
      throw new Error("Vault Password is required to decrypt this vault");
    }
    const password = await resolveVaultPassword(options.password, {
      command: "decrypt",
      resume: keyslot.state === "unsealing"
    });
    const key = await unsealKeyslot(password, keyslot);
    if (keyslot.state === "sealed") {
      await replaceKeyslotState(keyslotPath, keyslot, "unsealing");
    }
    const progress = await unsealFiles(root, key, options.afterUnsealReplacement);
    await publishDataDirectoryOwnerMarker(root, 4);
    await progress.clear();
    await removePrivateFile(keyslotPath, VAULT_KEYSLOT_POLICY);
  } finally {
    await lock.release();
  }
}

async function resolveVaultPassword(
  password: VaultPassword,
  request: VaultPasswordRequest
): Promise<string> {
  return typeof password === "string" ? password : await password(request);
}

async function replaceKeyslotState(
  keyslotPath: string,
  keyslot: ReturnType<typeof parseKeyslot>,
  state: "sealing" | "sealed" | "unsealing"
): Promise<void> {
  await replacePrivateFile(
    keyslotPath,
    encodeKeyslot(keyslotWithState(keyslot, state)),
    VAULT_KEYSLOT_POLICY
  );
}

async function sealFiles(root: string, key: Uint8Array): Promise<void> {
  await transformFiles(root, async (_files, file, bytes) => {
    if (!isSealed(bytes)) return sealVaultBytes(key, bytes);
    try {
      // A sealed file must authenticate with this vault key before a resumed
      // pass can classify it as complete. A non-authentic magic prefix is
      // ordinary plaintext and gets one normal seal.
      unsealVaultBytes(key, bytes, file);
      return null;
    } catch {
      return sealVaultBytes(key, bytes);
    }
  });
}

async function unsealFiles(
  root: string,
  key: Uint8Array,
  afterReplacement: ((files: readonly string[]) => Promise<void>) | undefined
): Promise<VaultUnsealProgress> {
  const progress = await VaultUnsealProgress.load(root, key);
  await transformFiles(root, async (files, file, bytes) => {
    const matching = files.map((path) => progress.matches(path, bytes));
    if (matching.every(Boolean)) return null;
    if (matching.some(Boolean)) {
      throw new Error(`Vault unseal progress disagrees with hard-link group: ${file}`);
    }
    if (!isSealed(bytes)) {
      if (files.some((path) => progress.has(path))) {
        throw new Error(`Vault unseal progress does not match plaintext: ${file}`);
      }
      throw new Error(`cannot unseal ${file}: sealed vault file is plaintext without a progress witness`);
    }
    let plaintext: Buffer;
    try {
      plaintext = unsealVaultBytes(key, bytes, file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `cannot unseal ${file}: ${message}. Delete this file if its plaintext is unrecoverable, then run 1667 decrypt again.`,
        { cause: error }
      );
    }
    await progress.record(files, plaintext);
    return plaintext;
  }, afterReplacement);
  return progress;
}

async function transformFiles(
  root: string,
  transform: (
    files: readonly string[],
    file: string,
    bytes: Buffer
  ) => Promise<Uint8Array | null>,
  afterReplacement?: (files: readonly string[]) => Promise<void>
): Promise<void> {
  const groups = await collectVaultInodeGroups(root);
  for (const group of groups.values()) {
    if (group.payloads.length === 0) continue;
    if (group.controls.length !== 0) throw mixedVaultInodeGroup(group);
    const files = group.payloads;
    const first = files[0]!;
    const bytes = await readFile(first);
    const replacement = await transform(files, first, bytes);
    if (replacement === null) continue;
    await replaceInodeGroup(files, replacement);
    await afterReplacement?.(files);
  }
}

async function assertVaultTraversalSafe(root: string): Promise<void> {
  const groups = await collectVaultInodeGroups(root);
  for (const group of groups.values()) {
    if (group.controls.length !== 0 && group.payloads.length !== 0) {
      throw mixedVaultInodeGroup(group);
    }
  }
}

async function collectVaultInodeGroups(root: string): Promise<Map<string, VaultInodeGroup>> {
  const groups = new Map<string, VaultInodeGroup>();
  for await (const entry of vaultFiles(root)) {
    const group = groups.get(entry.group);
    if (group === undefined) {
      groups.set(entry.group, {
        group: entry.group,
        representative: entry.file,
        controls: entry.isControl ? [entry.file] : [],
        payloads: entry.isControl ? [] : [entry.file]
      });
    } else if (entry.isControl) {
      group.controls.push(entry.file);
    } else {
      group.payloads.push(entry.file);
    }
  }
  for (const group of groups.values()) {
    const info = await lstat(group.representative, { bigint: true });
    if (!info.isFile() || `${info.dev}:${info.ino}` !== group.group) {
      throw new Error(`Vault hard-link group changed during traversal: ${group.representative}`);
    }
    const aliases = BigInt(group.controls.length + group.payloads.length);
    if (info.nlink !== aliases) {
      throw new Error(`Vault hard-link group has aliases outside the data directory: ${group.representative}`);
    }
  }
  return groups;
}

function mixedVaultInodeGroup(group: VaultInodeGroup): Error {
  return new Error(
    `Vault hard-link group mixes control and payload paths: ${group.controls[0]!} and ${group.payloads[0]!}`
  );
}

async function* vaultFiles(root: string, relative = ""): AsyncGenerator<VaultFileEntry> {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const nextRelative = relative === "" ? entry.name : path.join(relative, entry.name);
    const file = path.join(root, nextRelative);
    if (isVaultUnsealProgressPath(root, nextRelative)) continue;
    const info = await lstat(file, { bigint: true });
    if (info.isDirectory()) {
      yield* vaultFiles(root, nextRelative);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Vault contains an unsupported filesystem entry: ${file}`);
    }
    if (relative === "" && RUN_RECORD_ATOMIC_RESIDUE.test(entry.name)) {
      await unlink(file);
      await syncDirectory(directory);
      continue;
    }
    if (VAULT_REPLACE_RESIDUE.test(entry.name)) {
      await unlink(file);
      await syncDirectory(directory);
      continue;
    }
    yield {
      file,
      group: `${info.dev}:${info.ino}`,
      isControl: isVaultControlPath(root, nextRelative)
    };
  }
}

async function replaceInodeGroup(files: readonly string[], bytes: Uint8Array): Promise<void> {
  const first = files[0]!;
  const info = await lstat(first);
  const temporary = path.join(path.dirname(first), `.1667-vault-replace-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    info.mode & 0o777
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, first);
  await syncDirectory(path.dirname(first));
  for (const alias of files.slice(1)) {
    const aliasTemporary = path.join(path.dirname(alias), `.1667-vault-replace-${randomUUID()}.tmp`);
    await link(first, aliasTemporary);
    await rename(aliasTemporary, alias);
    await syncDirectory(path.dirname(alias));
  }
}
