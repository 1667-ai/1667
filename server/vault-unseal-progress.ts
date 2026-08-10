import { createHash, createHmac } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { recoverPrivateFileReplacement } from "./private-file-replacement.js";
import { syncDirectory } from "./story-lifecycle.js";
import {
  canonicalVaultUnsealProgressName,
  VAULT_UNSEAL_PROGRESS_DIRECTORY
} from "./vault-unseal-progress-layout.js";

export {
  isVaultUnsealProgressPath,
  VAULT_UNSEAL_PROGRESS_DIRECTORY
} from "./vault-unseal-progress-layout.js";

const PROGRESS_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Vault unseal progress",
  maxBytes: 16 * 1024
});

interface ProgressRecord {
  readonly format: 1;
  readonly path: string;
  readonly plaintextTag: string;
}

interface ProgressEntry {
  readonly file: string;
  readonly plaintextTag: string;
}

/** @internal Test seam for the root directory durability barrier. */
export interface VaultUnsealProgressOptions {
  readonly syncRoot?: (directory: string) => Promise<void>;
}

/** Durable witnesses for files already unsealed during one in-progress pass. */
export class VaultUnsealProgress {
  private readonly entries = new Map<string, ProgressEntry>();
  private directoryReady = false;

  private constructor(
    private readonly root: string,
    private readonly key: Uint8Array | null,
    private readonly syncRoot: (directory: string) => Promise<void>
  ) {}

  /** Encryption cannot start while an earlier unseal control path exists. */
  static async assertAbsent(root: string): Promise<void> {
    const directory = path.join(root, VAULT_UNSEAL_PROGRESS_DIRECTORY);
    try {
      await lstat(directory);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    throw new Error(`Vault unseal progress already exists: ${directory}`);
  }

  static async load(
    root: string,
    key: Uint8Array | null = null,
    options: VaultUnsealProgressOptions = {}
  ): Promise<VaultUnsealProgress> {
    const progress = new VaultUnsealProgress(root, key, options.syncRoot ?? syncDirectory);
    const directory = progress.directory;
    const files = new Set<string>();
    let entries: Dirent<string>[];
    try {
      await inspectPrivateDirectory(directory, PROGRESS_POLICY.label);
      await progress.syncRoot(root);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return progress;
      throw error;
    }
    progress.directoryReady = true;
    for (const entry of entries) {
      const name = canonicalVaultUnsealProgressName(entry.name);
      if (!entry.isFile() || name === null) {
        throw new Error(`Vault unseal progress has an unknown entry: ${path.join(directory, entry.name)}`);
      }
      files.add(path.join(directory, name));
    }
    for (const file of files) {
      await recoverPrivateFileReplacement(file, PROGRESS_POLICY);
      const bytes = await readOptionalPrivateFile(file, PROGRESS_POLICY);
      if (bytes === null) continue;
      const record = parseRecord(bytes, file);
      if (path.basename(file) !== recordFileName(record.path)) {
        throw new Error(`Vault unseal progress has a non-canonical file name: ${file}`);
      }
      if (progress.entries.has(record.path)) {
        throw new Error(`Vault unseal progress has duplicate path: ${record.path}`);
      }
      progress.entries.set(record.path, { file, plaintextTag: record.plaintextTag });
    }
    return progress;
  }

  /** True only when a durable witness names these exact bytes as plaintext. */
  matches(file: string, bytes: Uint8Array): boolean {
    const relative = relativePath(this.root, file);
    const entry = this.entries.get(relative);
    return entry !== undefined && entry.plaintextTag === plaintextTag(this.requireKey(), relative, bytes);
  }

  has(file: string): boolean {
    return this.entries.has(relativePath(this.root, file));
  }

  /** Publish every alias witness before their shared inode is replaced. */
  async record(files: readonly string[], plaintext: Uint8Array): Promise<void> {
    for (const file of files) {
      const relative = relativePath(this.root, file);
      const tag = plaintextTag(this.requireKey(), relative, plaintext);
      const existing = this.entries.get(relative);
      if (existing !== undefined) {
        if (existing.plaintextTag !== tag) {
          throw new Error(`Vault unseal progress disagrees with ${file}`);
        }
        continue;
      }
      const record: ProgressRecord = { format: 1, path: relative, plaintextTag: tag };
      await this.ensureDirectory();
      const progressFile = path.join(this.directory, recordFileName(relative));
      const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      const published = await readOptionalPrivateFile(progressFile, PROGRESS_POLICY);
      if (published === null) {
        await publishPrivateFileNoReplace(progressFile, encoded, PROGRESS_POLICY);
      } else {
        const publishedRecord = parseRecord(published, progressFile);
        if (publishedRecord.path !== relative || publishedRecord.plaintextTag !== tag) {
          throw new Error(`Vault unseal progress disagrees with ${file}`);
        }
      }
      this.entries.set(relative, { file: progressFile, plaintextTag: tag });
    }
  }

  /** Clear witnesses only after the format-4 fence makes cipher reads impossible. */
  async clear(): Promise<void> {
    for (const entry of this.entries.values()) {
      await removePrivateFile(entry.file, PROGRESS_POLICY);
    }
    this.entries.clear();
    try {
      await rmdir(this.directory);
      await syncDirectory(this.root);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    this.directoryReady = false;
  }

  private get directory(): string {
    return path.join(this.root, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    try {
      await mkdir(this.directory, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    await this.syncRoot(this.root);
    if (process.platform !== "win32") {
      const before = await lstat(this.directory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error(`Vault unseal progress is not a private directory: ${this.directory}`);
      }
      if ((before.mode & 0o777) !== 0o700) await chmod(this.directory, 0o700);
      const after = await lstat(this.directory);
      if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o700) {
        throw new Error(`Vault unseal progress is not a private directory: ${this.directory}`);
      }
    }
    await inspectPrivateDirectory(this.directory, PROGRESS_POLICY.label);
    this.directoryReady = true;
  }

  private requireKey(): Uint8Array {
    if (this.key === null) throw new Error("Vault unseal progress needs the Vault Key to verify a record");
    return this.key;
  }
}

function parseRecord(bytes: Uint8Array, file: string): ProgressRecord {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`Vault unseal progress is invalid: ${file}`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Vault unseal progress is invalid: ${file}`);
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["format", "path", "plaintextTag"])
    || record.format !== 1 || typeof record.path !== "string"
    || typeof record.plaintextTag !== "string" || !/^[a-f0-9]{64}$/.test(record.plaintextTag)
    || !isSafeRelativePath(record.path)) {
    throw new Error(`Vault unseal progress is invalid: ${file}`);
  }
  return { format: 1, path: record.path, plaintextTag: record.plaintextTag };
}

function relativePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!isSafeRelativePath(relative)) throw new Error(`Vault path is outside its data directory: ${file}`);
  return relative;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized === value
    && normalized !== "."
    && normalized !== ".."
    && !normalized.startsWith(`..${path.sep}`)
    && !path.isAbsolute(normalized);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordFileName(relative: string): string {
  return `${digest(Buffer.from(relative, "utf8"))}.json`;
}

function plaintextTag(key: Uint8Array, relative: string, plaintext: Uint8Array): string {
  return createHmac("sha256", key)
    .update("1667-vault-unseal-progress-v1\0", "utf8")
    .update(relative, "utf8")
    .update("\0", "utf8")
    .update(plaintext)
    .digest("hex");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
