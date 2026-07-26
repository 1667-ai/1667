import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import path from "node:path";
import { DataDirectoryLock, hasLockAwareDataMarker } from "./data-directory-lock.js";
import {
  DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES
} from "./data-directory-layout.js";
import { publishDirectoryNoReplace } from "./directory-no-replace.js";
import { LegacyMigrationLock } from "./legacy-migration-lock.js";
import { mkdirDurable, syncDirectory, writeDurableFile } from "./story-lifecycle.js";

const INTERNAL_NAMES = new Set<string>(DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES);

export interface DataMigrationHooks {
  /** Test-only synchronization point after the copy, before verification. */
  afterCopy?(): void | Promise<void>;
}

/** Copy a stopped legacy store into a current-format directory. Three matching
 * source snapshots plus the copied snapshot reject movement and mixed-version
 * copies before publication. */
export async function migrateDataDirectory(
  source: string,
  destination: string,
  hooks: DataMigrationHooks = {}
): Promise<string> {
  const sourceDir = await realpath(path.resolve(source));
  const destinationInput = path.resolve(destination);
  const destinationParent = await realpath(path.dirname(destinationInput));
  const destinationDir = path.join(destinationParent, path.basename(destinationInput));
  if (sourceDir === destinationDir || isWithin(sourceDir, destinationDir)) {
    throw new Error("Migration destination must be outside the legacy source directory");
  }
  const sourceInfo = await lstat(sourceDir);
  if (!sourceInfo.isDirectory()) throw new Error(`Migration source is not a directory: ${sourceDir}`);
  await requireMissing(destinationDir);
  if (await hasLockAwareDataMarker(sourceDir)) {
    throw new Error("Migration source is already lock-aware; use it directly");
  }
  const sourceLock = await LegacyMigrationLock.acquire(sourceDir);
  try {
    const initial = await snapshot(sourceDir);
    if (initial.length === 0) throw new Error("Migration source is empty; use the destination directly");
    await mkdirDurable(path.dirname(destinationDir));
    const staging = await mkdtemp(path.join(path.dirname(destinationDir), ".1667-migration-"));
    const lock = new DataDirectoryLock(staging, { initializeDataFormat: 1 });
    try {
      await lock.acquire();
      await copyTree(sourceDir, staging);
      await hooks.afterCopy?.();
      const sourceAfterCopy = await snapshot(sourceDir);
      const copied = await snapshot(staging);
      if (!sameSnapshot(initial, sourceAfterCopy)
        || !sameSnapshot(sourceAfterCopy, copied)) {
        throw new Error("Legacy data changed during migration; stop every 1667 process and retry");
      }
      await lock.migrateSettingsFormat();
      const sourceBeforePublish = await snapshot(sourceDir);
      if (await hasLockAwareDataMarker(sourceDir)) {
        throw new Error("Migration source became lock-aware during migration; retry using that directory directly");
      }
      if (!sameSnapshot(initial, sourceAfterCopy)
        || !sameSnapshot(sourceAfterCopy, sourceBeforePublish)) {
        throw new Error("Legacy data changed during migration; stop every 1667 process and retry");
      }
      await sourceLock.assertHeld();
      await lock.release();
      await publishDirectoryNoReplace(staging, destinationDir).catch(
        (error: unknown) => {
          throw new Error(
            `Migration destination appeared during publication: ${destinationDir}`,
            { cause: error }
          );
        }
      );
      await syncDirectory(path.dirname(destinationDir));
      return destinationDir;
    } catch (error) {
      await lock.release().catch(() => undefined);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await sourceLock.release();
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function copyTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (INTERNAL_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdirDurable(to);
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await writeDurableFile(to, await readFile(from), 0o600);
    } else {
      throw new Error(`Migration source contains an unsupported entry: ${from}`);
    }
  }
}

async function snapshot(root: string): Promise<Array<readonly [string, string]>> {
  const values: Array<readonly [string, string]> = [];
  await visit(root, "", values);
  return values;
}

async function visit(
  root: string,
  relative: string,
  values: Array<readonly [string, string]>
): Promise<void> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relative.length === 0 && INTERNAL_NAMES.has(entry.name)) continue;
    const child = relative.length === 0 ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) {
      values.push([`${child}/`, "directory"]);
      await visit(root, child, values);
    } else if (entry.isFile()) {
      values.push([child, createHash("sha256").update(await readFile(path.join(root, child))).digest("hex")]);
    } else {
      throw new Error(`Migration source contains an unsupported entry: ${path.join(root, child)}`);
    }
  }
}

function sameSnapshot(
  left: Array<readonly [string, string]>,
  right: Array<readonly [string, string]>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireMissing(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Migration destination already exists: ${target}`);
}
