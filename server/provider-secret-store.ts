import { constants } from "node:fs";
import { open, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, decodeCanonicalUtf8 } from "./canonical-json.js";
import {
  PROVIDER_SECRETS_FILE,
  PROVIDER_SECRETS_LOCK_FILE,
  PROVIDER_SECRETS_NEXT_FILE
} from "./data-directory-layout.js";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  syncPrivateDirectory,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { isLockContention, lockFile, type OsFileLock } from "./os-file-lock.js";
import { requireSecretId } from "./settings-v2-scalars.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  validateProviderSecretValue
} from "../shared/provider-secret-value.js";

const MAX_PROVIDER_SECRETS_FILE_BYTES = 2 * 1024 * 1024;
const SECRETS_LOCK_TIMEOUT_MS = 2_000;
const PROVIDER_SECRETS_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Provider secrets file",
  maxBytes: MAX_PROVIDER_SECRETS_FILE_BYTES
});

export async function readProviderSecrets(
  dataDir: string
): Promise<Map<string, string>> {
  const bytes = await readOptionalPrivateFile(
    path.join(dataDir, PROVIDER_SECRETS_FILE),
    PROVIDER_SECRETS_POLICY
  );
  if (bytes === null) return new Map();
  const value = parseJsonRejectingDuplicateKeys(
    decodeCanonicalUtf8(bytes, "Provider secrets file"),
    "Provider secrets file"
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider secrets file must contain a JSON object");
  }
  const result = new Map<string, string>();
  for (const [secretId, secret] of Object.entries(value as Record<string, unknown>)) {
    requireSecretId(secretId, "Provider secret ID");
    result.set(secretId, validateProviderSecretValue(secret));
  }
  return result;
}

export async function writeProviderSecret(
  dataDir: string,
  secretId: string,
  value: string
): Promise<void> {
  requireSecretId(secretId, "Provider secret ID");
  const secret = validateProviderSecretValue(value);
  await withSecretsLock(dataDir, async () => {
    const secrets = await readProviderSecrets(dataDir);
    secrets.set(secretId, secret);
    await publishProviderSecrets(dataDir, secrets);
  });
}

export async function deleteProviderSecret(
  dataDir: string,
  secretId: string
): Promise<void> {
  requireSecretId(secretId, "Provider secret ID");
  await withSecretsLock(dataDir, async () => {
    const secrets = await readProviderSecrets(dataDir);
    if (!secrets.delete(secretId)) return;
    await publishProviderSecrets(dataDir, secrets);
  });
}

export async function pruneProviderSecrets(
  dataDir: string,
  keepIds: Iterable<string>
): Promise<void> {
  const keep = new Set<string>();
  for (const secretId of keepIds) {
    keep.add(requireSecretId(secretId, "Provider secret ID"));
  }
  // Reading first keeps the common case — nothing to collect — from creating a
  // lock file in a directory that holds no secrets at all.
  const current = await readProviderSecrets(dataDir);
  if ([...current.keys()].every((secretId) => keep.has(secretId))) return;
  await withSecretsLock(dataDir, async () => {
    const secrets = await readProviderSecrets(dataDir);
    let changed = false;
    for (const secretId of secrets.keys()) {
      if (!keep.has(secretId)) {
        secrets.delete(secretId);
        changed = true;
      }
    }
    if (changed) await publishProviderSecrets(dataDir, secrets);
  });
}

/**
 * This store is machine-wide, so two projects can publish into it at
 * once. Each publication is a read-modify-write through one reserved `.next`
 * name, which a concurrent writer would either lose or collide with. The lock
 * is on a separate file so the secrets file itself keeps its atomic
 * no-replace publication, and it blocks rather than refusing: a key that is
 * being written is worth waiting a moment for.
 */
async function withSecretsLock<T>(
  dataDir: string,
  work: () => Promise<T>
): Promise<T> {
  const lockPath = path.join(dataDir, PROVIDER_SECRETS_LOCK_FILE);
  let handle: FileHandle | undefined;
  let lock: OsFileLock | undefined;
  try {
    handle = await open(lockPath, lockOpenFlags(), 0o600);
    lock = await acquireWithBackoff(handle.fd, lockPath);
    return await work();
  } finally {
    await lock?.unlock().catch(() => undefined);
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The kernel primitive is non-blocking by design everywhere else in 1667, where
 * contention means "another writer owns this project" and refusing is correct.
 * Here contention means "another project is mid-publication", which resolves in
 * milliseconds, so this waits — briefly, and then refuses rather than hanging.
 */
async function acquireWithBackoff(
  fd: number,
  lockPath: string
): Promise<OsFileLock> {
  const deadline = Date.now() + SECRETS_LOCK_TIMEOUT_MS;
  for (let delayMs = 5; ; delayMs = Math.min(delayMs * 2, 80)) {
    try {
      return await lockFile(fd, lockPath);
    } catch (error) {
      if (!isLockContention(error) || Date.now() >= deadline) {
        if (!isLockContention(error)) throw error;
        throw new Error(
          `Provider secrets file is locked by another 1667 process: ${lockPath}`
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}


function lockOpenFlags(): number | string {
  if (process.platform === "win32") return "a+";
  const closeOnExec = (constants as typeof constants & {
    O_CLOEXEC?: number;
  }).O_CLOEXEC ?? 0;
  return constants.O_RDWR | constants.O_CREAT
    | (constants.O_NOFOLLOW ?? 0) | closeOnExec;
}

export async function removeProviderSecretsScratch(
  dataDir: string
): Promise<void> {
  await removePrivateFile(
    path.join(dataDir, PROVIDER_SECRETS_NEXT_FILE),
    PROVIDER_SECRETS_POLICY
  );
}

async function publishProviderSecrets(
  dataDir: string,
  secrets: ReadonlyMap<string, string>
): Promise<void> {
  await inspectPrivateDirectory(dataDir, PROVIDER_SECRETS_POLICY.label);
  const record: Record<string, string> = {};
  for (const [secretId, value] of secrets) record[secretId] = value;
  const bytes = Buffer.from(canonicalJson(record), "utf8");
  const next = path.join(dataDir, PROVIDER_SECRETS_NEXT_FILE);
  const final = path.join(dataDir, PROVIDER_SECRETS_FILE);
  await removePrivateFile(next, PROVIDER_SECRETS_POLICY);
  await publishPrivateFileNoReplace(next, bytes, PROVIDER_SECRETS_POLICY);
  await rename(next, final);
  await syncPrivateDirectory(dataDir, PROVIDER_SECRETS_POLICY.label);
}
