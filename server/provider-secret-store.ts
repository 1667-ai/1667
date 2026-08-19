import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, decodeCanonicalUtf8 } from "./canonical-json.js";
import {
  PROVIDER_SECRETS_FILE,
  PROVIDER_SECRETS_LOCK_FILE,
  PROVIDER_SECRETS_NEXT_FILE,
  SUBSCRIPTION_SECRET_LOCK_FILES
} from "./data-directory-layout.js";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  syncPrivateDirectory,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { isErrorCode } from "./mutation-ledger-store-support.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { requireSecretId } from "./settings-v2-scalars.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  validateProviderSecretValue
} from "../shared/provider-secret-value.js";

const MAX_PROVIDER_SECRETS_FILE_BYTES = 2 * 1024 * 1024;
const SECRETS_LOCK_TIMEOUT_MS = 2_000;
/** Lock budget used by the per-subscription OAuth refresh lock. */
export const SUBSCRIPTION_PROVIDER_SECRET_LOCK_TIMEOUT_MS = 30_000;
const PROVIDER_SECRETS_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Provider secrets file",
  maxBytes: MAX_PROVIDER_SECRETS_FILE_BYTES
});

/** Machine-owned IDs. Their `@`/`/` namespace cannot occur in settings IDs. */
export const SUBSCRIPTION_SECRET_IDS = Object.freeze({
  "openai-codex": "@1667/subscription/openai-codex",
  anthropic: "@1667/subscription/anthropic"
} as const);

const SUBSCRIPTION_SECRET_LOCK_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  [SUBSCRIPTION_SECRET_IDS["openai-codex"]]: SUBSCRIPTION_SECRET_LOCK_FILES[0],
  [SUBSCRIPTION_SECRET_IDS.anthropic]: SUBSCRIPTION_SECRET_LOCK_FILES[1]
});

/** Reads share the writers' lock: a lockless read racing a live publication
 * would observe its transient link counts as corruption, and the read-side
 * recovery could discard a scratch the writer is about to publish. A missing
 * store stays lock-free, so a secretless project directory never grows a
 * lock file just because something looked. */
export async function readProviderSecrets(
  dataDir: string
): Promise<Map<string, string>> {
  if (!await providerSecretsFilePresent(dataDir)) return new Map();
  return await withSecretsLock(
    dataDir,
    async () => await readProviderSecretsUnlocked(dataDir)
  );
}

/** Read machine subscription values before envelope validation.
 *
 * Subscription status must classify one bad envelope without hiding a valid
 * value for the other provider. Ordinary provider values stay strict. */
export async function readSubscriptionProviderSecrets(
  dataDir: string
): Promise<Map<string, string>> {
  if (!await providerSecretsFilePresent(dataDir)) return new Map();
  return await withSecretsLock(
    dataDir,
    async () => await readProviderSecretsUnlocked(dataDir, {
      allowInvalidSubscriptionValues: true
    })
  );
}

async function providerSecretsFilePresent(dataDir: string): Promise<boolean> {
  try {
    await lstat(path.join(dataDir, PROVIDER_SECRETS_FILE));
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function readProviderSecretsUnlocked(
  dataDir: string,
  options: {
    readonly allowInvalidSubscriptionValues?: boolean;
  } = {}
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
    requireStoredProviderSecretId(secretId, "Provider secret ID");
    if (options.allowInvalidSubscriptionValues === true && isSubscriptionSecretId(secretId)) {
      result.set(secretId, typeof secret === "string" ? secret : "");
      continue;
    }
    result.set(secretId, validateProviderSecretValue(secret));
  }
  return result;
}

export async function writeProviderSecret(
  dataDir: string,
  secretId: string,
  value: string
): Promise<void> {
  await modifyProviderSecret(dataDir, secretId, () => value);
}

export async function deleteProviderSecret(
  dataDir: string,
  secretId: string
): Promise<void> {
  await modifyProviderSecret(dataDir, secretId, () => null);
}

/**
 * Run one ordinary provider-secret read-modify-write while the global lock is
 * held. A string publishes a replacement value, `null` removes the value, and
 * `undefined` leaves the value unchanged. Subscription refreshes use the
 * per-provider primitive below so this lock stays brief during OAuth calls.
 */
export async function modifyProviderSecret(
  dataDir: string,
  secretId: string,
  modify: (current: string | undefined) => string | null | undefined,
  options: {
    readonly lockTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {}
): Promise<string | undefined> {
  const id = requireSecretId(secretId, "Provider secret ID");
  return await withSecretsLock(dataDir, async () => {
    const secrets = await readProviderSecretsUnlocked(dataDir);
    const next = modify(secrets.get(id));
    if (next === undefined) return secrets.get(id);
    if (next === null) {
      if (secrets.delete(id)) await publishProviderSecrets(dataDir, secrets);
      return undefined;
    }
    const value = validateProviderSecretValue(next);
    if (secrets.get(id) !== value) {
      secrets.set(id, value);
      await publishProviderSecrets(dataDir, secrets);
    }
    return value;
  }, options);
}

/**
 * Serialize one subscription credential without holding the global secrets
 * lock while `modify` awaits an OAuth network operation. The final write
 * merges with the latest global snapshot and refuses to overwrite a value
 * changed by another writer during the callback.
 */
export async function modifySubscriptionProviderSecret(
  dataDir: string,
  secretId: string,
  modify: (current: string | undefined) => Promise<string | null | undefined> | string | null | undefined,
  options: {
    readonly lockTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {}
): Promise<string | undefined> {
  const id = requireSubscriptionSecretId(secretId, "Provider secret ID");
  const lockFile = SUBSCRIPTION_SECRET_LOCK_BY_ID[id]!;
  return await withPrivateFileLock({
    directory: dataDir,
    fileName: lockFile,
    directoryLabel: PROVIDER_SECRETS_POLICY.label,
    timeoutMs: options.lockTimeoutMs ?? SUBSCRIPTION_PROVIDER_SECRET_LOCK_TIMEOUT_MS,
    signal: options.signal,
    contentionMessage: (lockPath) =>
      `Subscription credential is locked by another 1667 process: ${lockPath}`
  }, async () => {
    checkSecretOperationAbort(options.signal);
    const current = await readSubscriptionSecret(dataDir, id, options.signal);
    const next = await modify(current);
    // A successful callback is the refresh commit boundary. Publish its
    // returned credential even if cancellation arrived during the callback.
    const published = await publishSubscriptionSecret(dataDir, id, current, next);
    checkSecretOperationAbort(options.signal);
    return published;
  });
}

export async function pruneProviderSecrets(
  dataDir: string,
  keepIds: Iterable<string>
): Promise<void> {
  const keep = new Set<string>();
  for (const secretId of keepIds) {
    keep.add(requireStoredProviderSecretId(secretId, "Provider secret ID"));
  }
  // Reading first keeps the common case — nothing to collect — from creating a
  // lock file in a directory that holds no secrets at all.
  const current = await readProviderSecrets(dataDir);
  if ([...current.keys()].every((secretId) => keep.has(secretId))) return;
  await withSecretsLock(dataDir, async () => {
    const secrets = await readProviderSecretsUnlocked(dataDir);
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
  work: () => Promise<T>,
  options: {
    readonly lockTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {}
): Promise<T> {
  return await withPrivateFileLock({
    directory: dataDir,
    fileName: PROVIDER_SECRETS_LOCK_FILE,
    directoryLabel: PROVIDER_SECRETS_POLICY.label,
    timeoutMs: options.lockTimeoutMs ?? SECRETS_LOCK_TIMEOUT_MS,
    signal: options.signal,
    contentionMessage: (lockPath) =>
      `Provider secrets file is locked by another 1667 process: ${lockPath}`
  }, work);
}

async function readSubscriptionSecret(
  dataDir: string,
  secretId: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  if (!await providerSecretsFilePresent(dataDir)) return undefined;
  return await withSecretsLock(
    dataDir,
    async () => {
      checkSecretOperationAbort(signal);
      return (await readProviderSecretsUnlocked(dataDir, {
        allowInvalidSubscriptionValues: true
      })).get(secretId);
    },
    { signal }
  );
}

async function publishSubscriptionSecret(
  dataDir: string,
  secretId: string,
  expected: string | undefined,
  next: string | null | undefined
): Promise<string | undefined> {
  return await withSecretsLock(
    dataDir,
    async () => {
      const secrets = await readProviderSecretsUnlocked(dataDir, {
        allowInvalidSubscriptionValues: true
      });
      const latest = secrets.get(secretId);
      if (next === undefined || latest !== expected) return latest;
      if (next === null) {
        if (secrets.delete(secretId)) await publishProviderSecrets(dataDir, secrets);
        return undefined;
      }
      const value = validateProviderSecretValue(next);
      if (latest !== value) {
        secrets.set(secretId, value);
        await publishProviderSecrets(dataDir, secrets);
      }
      return value;
    }
  );
}

function requireStoredProviderSecretId(value: unknown, label: string): string {
  if (typeof value === "string" && isSubscriptionSecretId(value)) return value;
  return requireSecretId(value, label);
}

function requireSubscriptionSecretId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isSubscriptionSecretId(value)) {
    throw new Error(`${label} is not a subscription credential ID`);
  }
  return value;
}

function isSubscriptionSecretId(value: string): boolean {
  return (Object.values(SUBSCRIPTION_SECRET_IDS) as readonly string[]).includes(value);
}

function checkSecretOperationAbort(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Provider secret operation cancelled");
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
