import { rename } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, decodeCanonicalUtf8 } from "./canonical-json.js";
import {
  PROVIDER_SECRETS_FILE,
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
import { requireSecretId } from "./settings-v2-scalars.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  validateProviderSecretValue
} from "../shared/provider-secret-value.js";

const MAX_PROVIDER_SECRETS_FILE_BYTES = 2 * 1024 * 1024;
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
  const secrets = await readProviderSecrets(dataDir);
  secrets.set(secretId, secret);
  await publishProviderSecrets(dataDir, secrets);
}

export async function deleteProviderSecret(
  dataDir: string,
  secretId: string
): Promise<void> {
  requireSecretId(secretId, "Provider secret ID");
  const secrets = await readProviderSecrets(dataDir);
  if (!secrets.delete(secretId)) return;
  await publishProviderSecrets(dataDir, secrets);
}

export async function pruneProviderSecrets(
  dataDir: string,
  keepIds: Iterable<string>
): Promise<void> {
  const keep = new Set<string>();
  for (const secretId of keepIds) {
    keep.add(requireSecretId(secretId, "Provider secret ID"));
  }
  const secrets = await readProviderSecrets(dataDir);
  let changed = false;
  for (const secretId of secrets.keys()) {
    if (!keep.has(secretId)) {
      secrets.delete(secretId);
      changed = true;
    }
  }
  if (changed) await publishProviderSecrets(dataDir, secrets);
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
