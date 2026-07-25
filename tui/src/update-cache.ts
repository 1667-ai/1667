import { createHash } from "node:crypto";
import { isSemVer } from "../../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";

export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_CHECK_INITIAL_DELAY_MS = 1_000;

export interface UpdateCacheKey {
  metadataKind: "npm";
  metadataOrigin: string;
  packageName: string;
  installIdentity: string;
  currentVersion: string;
  artifactTarget: string;
  channel: "stable" | "beta";
  prereleasePolicy: "stable-only" | "allow-prerelease";
}

export interface UpdateCacheEntry {
  schemaVersion: 1;
  fingerprint: string;
  checkedAt: number;
  latest: string;
}

const CACHE_FIELDS = new Set([
  "schemaVersion",
  "fingerprint",
  "checkedAt",
  "latest"
]);
const CACHE_MAX_BYTES = 8 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export function updateCacheFingerprint(key: UpdateCacheKey): string {
  validateCacheKey(key);
  const serialized = JSON.stringify([
    "1667-update-cache-v1",
    key.metadataKind,
    key.metadataOrigin,
    key.packageName,
    key.installIdentity,
    key.currentVersion,
    key.artifactTarget,
    key.channel,
    key.prereleasePolicy
  ]);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function createUpdateCacheEntry(
  key: UpdateCacheKey,
  latest: string,
  checkedAt = Date.now()
): UpdateCacheEntry {
  if (!isSemVer(latest)) throw new TypeError("Update cache latest version must be strict SemVer");
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    throw new TypeError("Update cache timestamp must be a non-negative integer");
  }
  return {
    schemaVersion: 1,
    fingerprint: updateCacheFingerprint(key),
    checkedAt,
    latest
  };
}

/**
 * Cache bytes are only a notification hint. Any ambiguity is a miss; callers
 * must never derive installer authority or a command from this result.
 */
export function readUpdateCacheHint(
  bytes: Uint8Array,
  key: UpdateCacheKey,
  now = Date.now()
): UpdateCacheEntry | null {
  if (bytes.byteLength > CACHE_MAX_BYTES || !Number.isSafeInteger(now) || now < 0) return null;
  let value: unknown;
  try {
    value = parseJsonRejectingDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CACHE_FIELDS.size || keys.some((field) => !CACHE_FIELDS.has(field))) return null;
  if (record.schemaVersion !== 1
    || typeof record.fingerprint !== "string"
    || !SHA256.test(record.fingerprint)
    || typeof record.checkedAt !== "number"
    || !Number.isSafeInteger(record.checkedAt)
    || record.checkedAt < 0
    || !isSemVer(record.latest)) {
    return null;
  }
  if (record.fingerprint !== updateCacheFingerprint(key)) return null;
  const age = now - record.checkedAt;
  if (age < 0 || age > UPDATE_CACHE_TTL_MS) return null;
  return {
    schemaVersion: 1,
    fingerprint: record.fingerprint,
    checkedAt: record.checkedAt,
    latest: record.latest
  };
}

export function encodeUpdateCache(entry: UpdateCacheEntry): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(entry)}\n`);
}

export function updateFailureDelayMs(attempt: number, randomUnit: number): number {
  const boundedAttempt = Math.max(0, Math.min(8, Math.trunc(attempt)));
  const boundedRandom = Math.max(0, Math.min(1, randomUnit));
  const base = Math.min(60 * 60 * 1_000, 5_000 * (2 ** boundedAttempt));
  return Math.round(base * (0.75 + boundedRandom * 0.5));
}

function validateCacheKey(key: UpdateCacheKey): void {
  if (!isSemVer(key.currentVersion)) throw new TypeError("Update cache current version must be strict SemVer");
  for (const [name, value] of Object.entries(key)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || hasControl(value)) {
      throw new TypeError(`Update cache ${name} is invalid`);
    }
  }
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}
