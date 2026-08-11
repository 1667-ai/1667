/**
 * The Draft Lease: the durable record that keeps one staged Image Object
 * alive between the moment a writer stages it and the moment a generation
 * consumes it, a release removes it, or its lifetime expires.
 *
 * A Draft Lease is bundle content, not a story mutation: it lives at
 * `stories/<storyId>/image-leases/<leaseId>.json`, four path segments deep,
 * so the Vault seals it exactly the way it seals every other story object
 * (server/vault-key-registry.ts's control-path check only ever matches a
 * root-level name or the depth-3 cleanup marker). Every read and write goes
 * through `server/private-file-publication.ts`, the same crash-safe,
 * no-replace, owner-only primitive `manifest.json.next` uses, so a lease can
 * never appear half written.
 *
 * The record format mirrors `shared/reasoning.ts` and `server/story-residue.ts`:
 * a closed key set, bounded bytes, and canonical-round-trip validation, so a
 * hand-edited or truncated file is refused rather than silently accepted.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  decodeCanonicalUtf8,
  encodeUtf8Strict
} from "./canonical-json.js";
import { StoryFormatError } from "./story-format-facts.js";
import { HASH_PATTERN } from "./story-format.js";
import {
  createStoryImageAttachment,
  isDraftImageLeaseId,
  type StoredImageMediaType,
  type StoryImageAttachment
} from "../shared/image-attachment.js";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { syncDirectory } from "./story-lifecycle.js";

export const IMAGE_LEASE_DIRECTORY_NAME = "image-leases";
export const IMAGE_LEASE_FORMAT = "1667-image-lease";
export const IMAGE_LEASE_SCHEMA_VERSION = 1;
/** Generous relative to the handful of short fields a lease actually holds;
 *  bounded all the same, because every reserved file this codebase reads
 *  bounds its byte count before it parses a single character. */
export const MAX_IMAGE_LEASE_BYTES = 1_024;

const IMAGE_LEASE_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Draft Lease",
  maxBytes: MAX_IMAGE_LEASE_BYTES
});
const LEASE_FILE_NAME_PATTERN = /^([a-f0-9]{64})\.json$/u;
const LEASE_KEYS = [
  "format",
  "schemaVersion",
  "leaseId",
  "objectId",
  "mediaType",
  "width",
  "height",
  "byteLength",
  "createdAt",
  "expiresAt"
] as const;

export interface DraftImageLeaseRecord {
  readonly format: typeof IMAGE_LEASE_FORMAT;
  readonly schemaVersion: typeof IMAGE_LEASE_SCHEMA_VERSION;
  readonly leaseId: string;
  readonly objectId: string;
  readonly mediaType: StoredImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A random 256-bit id written as exactly 64 lowercase hexadecimal
 *  characters, the exact grammar `isDraftImageLeaseId` checks. */
export function createDraftImageLeaseId(): string {
  return randomBytes(32).toString("hex");
}

export function imageLeaseDirectoryPath(bundleDir: string): string {
  return path.join(bundleDir, IMAGE_LEASE_DIRECTORY_NAME);
}

/** Validate the id grammar, then resolve the lease's path and confirm its
 *  parent is exactly the lease directory. Called before every filesystem
 *  operation on a lease, so a malformed or crafted id can never walk out of
 *  `image-leases/`. */
export function imageLeasePath(bundleDir: string, leaseId: string): string {
  if (!isDraftImageLeaseId(leaseId)) {
    throw new StoryFormatError(`Invalid Draft Lease id: ${leaseId}`);
  }
  const directory = imageLeaseDirectoryPath(bundleDir);
  const file = path.join(directory, `${leaseId}.json`);
  if (path.dirname(file) !== directory) {
    throw new StoryFormatError(`Draft Lease path escaped its directory: ${leaseId}`);
  }
  return file;
}

/** Build a record from already-decoded parts, enforcing every bound. Both
 *  `parseDraftImageLeaseBytes` and the staging writer go through here, so a
 *  bound can never be enforced on one path and forgotten on the other. */
export function createDraftImageLeaseRecord(input: {
  readonly leaseId: string;
  readonly attachment: StoryImageAttachment;
  readonly createdAt: number;
  readonly expiresAt: number;
}): DraftImageLeaseRecord {
  const { leaseId, attachment, createdAt, expiresAt } = input;
  if (!isDraftImageLeaseId(leaseId)) {
    throw new StoryFormatError(`Invalid Draft Lease id: ${leaseId}`);
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new StoryFormatError("Draft Lease createdAt must be a non-negative integer");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) {
    throw new StoryFormatError("Draft Lease expiresAt must be later than createdAt");
  }
  return {
    format: IMAGE_LEASE_FORMAT,
    schemaVersion: IMAGE_LEASE_SCHEMA_VERSION,
    leaseId,
    objectId: attachment.objectId,
    mediaType: attachment.mediaType,
    width: attachment.width,
    height: attachment.height,
    byteLength: attachment.byteLength,
    createdAt,
    expiresAt
  };
}

export function serializeDraftImageLease(record: DraftImageLeaseRecord): string {
  return canonicalJson(record);
}

export function parseDraftImageLeaseBytes(
  bytes: Uint8Array,
  expectedLeaseId?: string
): DraftImageLeaseRecord {
  if (bytes.byteLength > MAX_IMAGE_LEASE_BYTES) {
    throw new StoryFormatError(
      `Draft Lease exceeds its ${MAX_IMAGE_LEASE_BYTES}-byte size limit`
    );
  }
  const text = decodeCanonicalUtf8(bytes, "Draft Lease");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new StoryFormatError("Invalid Draft Lease JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryFormatError("Draft Lease must be an object");
  }
  const record = value as Record<string, unknown>;
  requireClosedKeys(record);
  if (record.format !== IMAGE_LEASE_FORMAT) {
    throw new StoryFormatError("Unsupported Draft Lease format");
  }
  if (record.schemaVersion !== IMAGE_LEASE_SCHEMA_VERSION) {
    throw new StoryFormatError("Unsupported Draft Lease schema version");
  }
  if (typeof record.objectId !== "string" || !HASH_PATTERN.test(record.objectId)) {
    throw new StoryFormatError("Draft Lease objectId must be a SHA-256 hexadecimal digest");
  }
  const attachment = createStoryImageAttachment({
    objectId: record.objectId,
    mediaType: record.mediaType,
    width: record.width,
    height: record.height,
    byteLength: record.byteLength
  });
  if (typeof record.leaseId !== "string") {
    throw new StoryFormatError("Draft Lease leaseId must be a string");
  }
  const result = createDraftImageLeaseRecord({
    leaseId: record.leaseId,
    attachment,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number
  });
  if (expectedLeaseId !== undefined && result.leaseId !== expectedLeaseId) {
    throw new StoryFormatError("Draft Lease id does not match its file name");
  }
  if (serializeDraftImageLease(result) !== text) {
    throw new StoryFormatError("Draft Lease is not canonically serialized");
  }
  return result;
}

function requireClosedKeys(record: Record<string, unknown>): void {
  const allowed = new Set<string>(LEASE_KEYS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new StoryFormatError(`Draft Lease contains unknown key: ${key}`);
  }
  for (const key of LEASE_KEYS) {
    if (!Object.hasOwn(record, key)) throw new StoryFormatError(`Draft Lease is missing required key: ${key}`);
  }
}

/** Create `image-leases/` with mode `0o700` if it is not already there, and
 *  make its creation durable. Idempotent: a concurrent creator's `EEXIST`
 *  is not an error.
 *
 * Only `image-leases/` itself is held to the private-directory (owner-only
 * `0o700`) invariant: it is the directory this module creates and owns. The
 * story bundle directory that contains it is created by
 * `server/story-object-directory.ts` with the platform default mode, so its
 * durability sync uses the plain `syncDirectory` primitive rather than
 * `syncPrivateDirectory`, which would wrongly demand `0o700` on a directory
 * this module does not own. */
async function ensureImageLeaseDirectory(bundleDir: string): Promise<void> {
  const directory = imageLeaseDirectoryPath(bundleDir);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    await inspectPrivateDirectory(directory, "Draft Lease directory");
    return;
  }
  await inspectPrivateDirectory(directory, "Draft Lease directory");
  await syncDirectory(bundleDir);
}

/** Publish one Draft Lease, sealed, with no replacement of an existing file
 *  of the same id. `record.leaseId` names the file. */
export async function publishDraftImageLease(
  bundleDir: string,
  record: DraftImageLeaseRecord
): Promise<void> {
  await ensureImageLeaseDirectory(bundleDir);
  const file = imageLeasePath(bundleDir, record.leaseId);
  const bytes = encodeUtf8Strict(serializeDraftImageLease(record), "Draft Lease");
  await publishPrivateFileNoReplace(file, bytes, IMAGE_LEASE_POLICY);
}

/** Read one Draft Lease through the bounded, Vault-aware reader. Returns
 *  `null` when the lease is absent, so a release of an already-gone lease
 *  and a read of an expired-and-reaped lease both read as "not here"
 *  rather than as an error. */
export async function readDraftImageLease(
  bundleDir: string,
  leaseId: string
): Promise<DraftImageLeaseRecord | null> {
  const file = imageLeasePath(bundleDir, leaseId);
  const bytes = await readOptionalPrivateFile(file, IMAGE_LEASE_POLICY);
  if (bytes === null) return null;
  return parseDraftImageLeaseBytes(bytes, leaseId);
}

/** Idempotent removal: an absent lease is success, not an error, matching
 *  `releaseStoryImage`'s idempotent contract. */
export async function removeDraftImageLease(bundleDir: string, leaseId: string): Promise<void> {
  const file = imageLeasePath(bundleDir, leaseId);
  await removePrivateFile(file, IMAGE_LEASE_POLICY);
}

/** Every Draft Lease currently published for one story, in no particular
 *  order. An absent `image-leases/` directory reads as no leases. Scratch
 *  and non-matching names (publication residue, foreign files) are ignored
 *  rather than treated as corruption: only files whose name is the exact
 *  `<64 lowercase hex>.json` grammar are read as leases. */
export async function listDraftImageLeases(
  bundleDir: string
): Promise<readonly DraftImageLeaseRecord[]> {
  const directory = imageLeaseDirectoryPath(bundleDir);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const leases: DraftImageLeaseRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LEASE_FILE_NAME_PATTERN.exec(entry.name);
    if (match === null) continue;
    const lease = await readDraftImageLease(bundleDir, match[1]!);
    if (lease !== null) leases.push(lease);
  }
  return leases;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
