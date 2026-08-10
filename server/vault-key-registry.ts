import path from "node:path";
import {
  VAULT_SEAL_OVERHEAD,
  isSealed,
  sealVaultBytes,
  unsealVaultBytes
} from "../shared/vault-cipher.js";
import { isStoryId } from "./story-v5-strict.js";
import { isVaultUnsealProgressPath } from "./vault-unseal-progress-layout.js";

const keys = new Map<string, VaultKeyRegistrationImpl>();
const PRIVATE_PUBLICATION_SCRATCH_SUFFIX = ".1667-publish-v1.tmp";
const PRIVATE_REPLACEMENT_SUFFIX = ".1667-replace-v1.next";
const ROOT_CONTROL_NAMES = new Set([
  "lock",
  "data-id",
  "owner.json",
  "owner.json.next",
  "run.json",
  ".gitignore",
  "vault.json",
  ".1667-data-owner.json",
  ".1667-data-owner.json.next",
  ".1667.lock",
  ".1667.owner-v1",
  ".1667-data.lock",
  ".1667-data-v1.json"
]);
const CLEANUP_MARKER = ".1667-cleanup-needed";
const CLEANUP_MARKER_ATOMIC_TEMP = /^\.1667-cleanup-needed\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;

export interface VaultKeyRegistration {
  /** Register another lexical path to the same retained vault directory. */
  addAlias(dataDirectory: string): void;
  /** Remove every path alias and zero this registration's in-memory key. */
  clear(): void;
}

/** Register the in-memory Vault Key for one project directory and return its scope. */
export function registerVaultKey(dataDirectory: string, key: Uint8Array): VaultKeyRegistration {
  if (key.byteLength !== 32) throw new Error("Vault Key must be 32 bytes");
  const registration = new VaultKeyRegistrationImpl(Buffer.from(key));
  registration.addAlias(dataDirectory);
  return registration;
}

export function vaultKeyForPath(file: string): Buffer | null {
  // The ordinary project path must stay a no-op. Most process starts have no
  // Vault Key, and avoiding path normalization here preserves the bounded
  // read/write hot path for an unsealed project.
  if (keys.size === 0) return null;
  const resolved = path.resolve(file);
  for (const [root, registration] of keys) {
    const relative = path.relative(root, resolved);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    if (!isVaultControlPath(root, resolved)) return registration.key;
  }
  return null;
}

class VaultKeyRegistrationImpl implements VaultKeyRegistration {
  private readonly aliases = new Set<string>();
  private cleared = false;

  constructor(readonly key: Buffer) {}

  addAlias(dataDirectory: string): void {
    if (this.cleared) throw new Error("Vault Key registration is already cleared");
    const alias = path.resolve(dataDirectory);
    const existing = keys.get(alias);
    if (existing !== undefined && existing !== this) {
      throw new Error(`Vault Key path alias is already registered: ${alias}`);
    }
    keys.set(alias, this);
    this.aliases.add(alias);
  }

  clear(): void {
    if (this.cleared) return;
    this.cleared = true;
    for (const alias of this.aliases) {
      if (keys.get(alias) === this) keys.delete(alias);
    }
    this.aliases.clear();
    this.key.fill(0);
  }
}

export function hasVaultKeyForPath(file: string): boolean {
  return vaultKeyForPath(file) !== null;
}

export function sealVaultFileForPath<T extends Uint8Array | string>(
  file: string,
  bytes: T
): T | Buffer {
  const key = vaultKeyForPath(file);
  if (key !== null) return sealVaultBytes(key, Buffer.from(bytes));
  return bytes;
}

export function unsealVaultFileForPath(file: string, bytes: Uint8Array): Buffer {
  const key = vaultKeyForPath(file);
  if (key === null) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!isSealed(bytes)) throw new Error(`Vault file is not sealed: ${file}`);
  return unsealVaultBytes(key, bytes, file);
}

/** The on-disk cap has the same plaintext meaning in sealed and plain vaults. */
export function vaultStoredByteLimit(file: string, plaintextLimit: number): number {
  return vaultKeyForPath(file) === null ? plaintextLimit : plaintextLimit + VAULT_SEAL_OVERHEAD;
}

/** Return true when a path stays plaintext while its containing vault is sealed. */
export function isVaultControlPath(root: string, fileOrRelative: string): boolean {
  const relative = path.isAbsolute(fileOrRelative)
    ? path.relative(path.resolve(root), path.resolve(fileOrRelative))
    : fileOrRelative;
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(path.sep);
  if (isVaultUnsealProgressPath(root, relative)) return true;
  if (isStoryCleanupControlPath(parts)) return true;
  if (parts.length !== 1) return false;
  return isRootControlName(parts[0]!);
}

function isStoryCleanupControlPath(parts: readonly string[]): boolean {
  if (parts.length !== 3 || parts[0] !== "stories" || !isStoryId(parts[1]!)) return false;
  const name = parts[2]!;
  return name === CLEANUP_MARKER || CLEANUP_MARKER_ATOMIC_TEMP.test(name);
}

function isRootControlName(name: string): boolean {
  if (ROOT_CONTROL_NAMES.has(name)) return true;
  if (name.endsWith(PRIVATE_REPLACEMENT_SUFFIX)) {
    return ROOT_CONTROL_NAMES.has(name.slice(0, -PRIVATE_REPLACEMENT_SUFFIX.length));
  }
  if (!name.endsWith(PRIVATE_PUBLICATION_SCRATCH_SUFFIX)) return false;
  const publicationTarget = name.slice(0, -PRIVATE_PUBLICATION_SCRATCH_SUFFIX.length);
  if (ROOT_CONTROL_NAMES.has(publicationTarget)) return true;
  if (!publicationTarget.endsWith(PRIVATE_REPLACEMENT_SUFFIX)) return false;
  return ROOT_CONTROL_NAMES.has(
    publicationTarget.slice(0, -PRIVATE_REPLACEMENT_SUFFIX.length)
  );
}
