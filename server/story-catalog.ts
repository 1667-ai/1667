import { randomBytes } from "node:crypto";
import type { Dir, Dirent } from "node:fs";
import {
  lstat,
  opendir
} from "node:fs/promises";
import path from "node:path";
import type {
  ListStoriesPageInput,
  StoryCatalogPage
} from "../shared/story-catalog.js";
import type { StorySummary } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { hashStoryV5ManifestBytes } from "./story-manifest-hash.js";
import {
  classifyStoryEntry,
  isStoryId,
  MAX_STORY_RESIDUE_IDENTITY_BYTES,
  parseStoryResidueIdentityBytes
} from "./story-residue.js";
import {
  readStoredStorySlot,
  type StoredStorySlot
} from "./story-storage-reader.js";
import { buildStoryCatalogSummary } from "./story-summary.js";
import { storySummaryFromLiveEnvelope } from "./story-v6-codec.js";
import {
  isEphemeralBundleName,
  reapEphemeralBundle
} from "./story-lifecycle.js";

export const MAX_CATALOG_SCANS = 8;
export const MAX_CATALOG_PAGE_ENTRIES = 64;
export const MAX_CATALOG_PAGE_MANIFEST_BYTES = 32 * 1024 * 1024;
export const CATALOG_CURSOR_IDLE_TTL_MS = 60_000;

type Clock = () => number;

interface CatalogScan {
  readonly scanId: string;
  readonly cursor: string;
  readonly directory: Dir;
  pending: ResolvedCatalogEntry | null;
  lastUsedAt: number;
  inFlight: boolean;
}

export interface StoryCatalogOptions {
  readonly now?: Clock;
  readonly recoverResidue?: (
    kind: "create" | "reap",
    storyId: string
  ) => Promise<void>;
  readonly reapDeleted?: (storyId: string) => Promise<boolean>;
  readonly maintainStory?: (storyId: string) => Promise<void>;
}

/** Bounded process-local directory cursors. They are capabilities, not epochs:
 * concurrent catalog changes may duplicate or omit entries between pages. */
export class StoryCatalog {
  private readonly root: string;
  private readonly scans = new Map<string, CatalogScan>();
  private scanReservations = 0;

  constructor(
    dataDir: string,
    options: StoryCatalogOptions = {}
  ) {
    this.root = path.join(dataDir, "stories");
    this.now = options.now ?? (() => Date.now());
    this.recoverResidue = options.recoverResidue;
    this.reapDeleted = options.reapDeleted;
    this.maintainStory = options.maintainStory;
  }

  private readonly now: Clock;
  private readonly recoverResidue:
    | StoryCatalogOptions["recoverResidue"];
  private readonly reapDeleted: StoryCatalogOptions["reapDeleted"];
  private readonly maintainStory: StoryCatalogOptions["maintainStory"];

  async listPage(input: unknown): Promise<StoryCatalogPage> {
    const request = parsePageInput(input);
    const now = this.timestamp();
    await this.expire(now);
    const scan = request.cursor === null
      ? await this.openScan(now)
      : this.requireScan(request.cursor, now);
    if (scan.inFlight) {
      throw new ServiceError(
        409,
        "Catalog cursor already has a page in flight.",
        "resource_busy"
      );
    }
    scan.inFlight = true;
    try {
      return await this.readPage(scan, request.maxEntries, now);
    } catch (error) {
      await this.closeScan(scan);
      throw error;
    } finally {
      scan.inFlight = false;
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.scans.values()].map(async (scan) => await this.closeScan(scan))
    );
  }

  private async openScan(now: number): Promise<CatalogScan> {
    if (this.scans.size + this.scanReservations >= MAX_CATALOG_SCANS) {
      throw new ServiceError(
        409,
        "Catalog scan capacity is busy; retry later.",
        "resource_busy"
      );
    }
    this.scanReservations += 1;
    let directory: Dir | null = null;
    try {
      directory = await opendir(this.root);
      const scan: CatalogScan = {
        scanId: randomBytes(16).toString("hex"),
        cursor: randomBytes(32).toString("hex"),
        directory,
        pending: null,
        lastUsedAt: now,
        inFlight: false
      };
      this.scans.set(scan.cursor, scan);
      return scan;
    } catch (error) {
      await directory?.close().catch(() => undefined);
      throw error;
    } finally {
      this.scanReservations -= 1;
    }
  }

  private requireScan(cursor: string, now: number): CatalogScan {
    const scan = this.scans.get(cursor);
    if (scan === undefined || now - scan.lastUsedAt >= CATALOG_CURSOR_IDLE_TTL_MS) {
      throw new ServiceError(
        409,
        "Catalog cursor expired; start a fresh scan.",
        "catalog_cursor_expired"
      );
    }
    return scan;
  }

  private async readPage(
    scan: CatalogScan,
    maxEntries: number,
    now: number
  ): Promise<StoryCatalogPage> {
    const items: StorySummary[] = [];
    let entriesRead = 0;
    let manifestBytes = 0;
    let done = false;
    while (entriesRead < MAX_CATALOG_PAGE_ENTRIES
      && items.length < maxEntries) {
      const entry = scan.pending ?? await this.nextEntry(scan);
      scan.pending = null;
      if (entry === null) {
        done = true;
        break;
      }
      entriesRead += 1;
      manifestBytes += entry.metadataBytes;
      if (manifestBytes > MAX_CATALOG_PAGE_MANIFEST_BYTES) {
        throw new Error("Catalog page exceeded its residue byte budget");
      }
      if (entry.storyId === null) continue;
      const size = await this.manifestSize(entry.storyId);
      if (size === null) continue;
      if (manifestBytes > 0
        && manifestBytes + size > MAX_CATALOG_PAGE_MANIFEST_BYTES) {
        scan.pending = entry;
        manifestBytes -= entry.metadataBytes;
        break;
      }
      const slot = await readStoredStorySlot(this.root, entry.storyId);
      manifestBytes += bytesRead(slot);
      if (manifestBytes > MAX_CATALOG_PAGE_MANIFEST_BYTES) {
        throw new Error("Catalog page exceeded its manifest byte budget");
      }
      if (
        slot.kind === "v6-deleted"
        || slot.kind === "v8-deleted"
        || slot.kind === "v10-deleted"
      ) {
        await this.reapDeleted?.(entry.storyId);
        continue;
      }
      await this.maintainStory?.(entry.storyId);
      const summary = summaryFromSlot(slot);
      if (summary !== null) items.push(summary);
    }
    scan.lastUsedAt = Math.max(scan.lastUsedAt, now);
    if (done) await this.closeScan(scan);
    return {
      scanId: scan.scanId,
      items,
      cursor: done ? null : scan.cursor,
      done
    };
  }

  private async nextEntry(scan: CatalogScan): Promise<ResolvedCatalogEntry | null> {
    const entry = await scan.directory.read();
    if (entry === null) return null;
    if (entry.isDirectory() && isEphemeralBundleName(entry.name)) {
      await reapEphemeralBundle(this.root, entry.name);
      return { entry, storyId: null, metadataBytes: 0 };
    }
    if (!entry.isDirectory() && entry.isFile() && entry.name.endsWith(".json")) {
      const storyId = entry.name.slice(0, -".json".length);
      return {
        entry,
        storyId: isStoryId(storyId) ? storyId : null,
        metadataBytes: 0
      };
    }
    const classified = classifyStoryEntry(entry);
    if (classified.kind === "canonical-story") {
      return { entry, storyId: classified.storyId, metadataBytes: 0 };
    }
    if (classified.kind === "story-residue-identity"
      && classified.phase === "final") {
      const file = path.join(this.root, entry.name);
      let bytes: Buffer;
      try {
        bytes = await readBoundedRegularFile(
          file,
          MAX_STORY_RESIDUE_IDENTITY_BYTES,
          { requirePrivate: true }
        );
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
          return { entry, storyId: null, metadataBytes: 0 };
        }
        throw error;
      }
      const identity = parseStoryResidueIdentityBytes(bytes);
      if (identity.token !== classified.token
        || identity.kind !== (classified.residueKind === "create"
          ? "story-create-reservation"
          : "story-reap-reservation")) {
        throw new Error(`Story residue identity token mismatch: ${entry.name}`);
      }
      await this.recoverResidue?.(classified.residueKind, identity.storyId);
      return {
        entry,
        storyId: identity.storyId,
        metadataBytes: bytes.byteLength
      };
    }
    if (classified.kind === "hashed-story-residue") {
      const identityFile = path.join(this.root, `${entry.name}.identity`);
      let bytes: Buffer;
      try {
        bytes = await readBoundedRegularFile(
          identityFile,
          MAX_STORY_RESIDUE_IDENTITY_BYTES,
          { requirePrivate: true }
        );
      } catch (error) {
        if (isErrorCode(error, "ENOENT")
          && await lstatOptional(path.join(this.root, entry.name)) === null) {
          return { entry, storyId: null, metadataBytes: 0 };
        }
        throw error;
      }
      const identity = parseStoryResidueIdentityBytes(bytes);
      if (identity.token !== classified.token
        || identity.kind !== (classified.residueKind === "create"
          ? "story-create-reservation"
          : "story-reap-reservation")) {
        throw new Error(`Story residue directory token mismatch: ${entry.name}`);
      }
      await this.recoverResidue?.(classified.residueKind, identity.storyId);
      return {
        entry,
        storyId: identity.storyId,
        metadataBytes: bytes.byteLength
      };
    }
    return { entry, storyId: null, metadataBytes: 0 };
  }

  private async manifestSize(storyId: string): Promise<number | null> {
    const canonical = path.join(this.root, storyId);
    const canonicalInfo = await lstatOptional(canonical);
    const file = canonicalInfo?.isDirectory()
      ? path.join(canonical, "manifest.json")
      : path.join(this.root, `${storyId}.json`);
    const info = await lstatOptional(file);
    if (info === null) return null;
    if (!info.isFile()) throw new Error(`Catalog manifest is not a file: ${storyId}`);
    return info.size;
  }

  private async expire(now: number): Promise<void> {
    const expired = [...this.scans.values()].filter(
      (scan) => !scan.inFlight
        && now - scan.lastUsedAt >= CATALOG_CURSOR_IDLE_TTL_MS
    );
    await Promise.allSettled(expired.map(async (scan) => await this.closeScan(scan)));
  }

  private async closeScan(scan: CatalogScan): Promise<void> {
    if (this.scans.get(scan.cursor) !== scan) return;
    this.scans.delete(scan.cursor);
    try {
      await scan.directory.close();
    } catch (error) {
      if (!isErrorCode(error, "ERR_DIR_CLOSED")) throw error;
    }
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error("Story catalog clock returned an invalid time");
    return value;
  }
}

interface ResolvedCatalogEntry {
  readonly entry: Dirent;
  readonly storyId: string | null;
  readonly metadataBytes: number;
}

function parsePageInput(value: unknown): ListStoriesPageInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPage();
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 2 || !keys.includes("cursor") || !keys.includes("maxEntries")) {
    throw invalidPage();
  }
  if (record.cursor !== null
    && (typeof record.cursor !== "string"
      || !/^[a-f0-9]{64}$/u.test(record.cursor))) {
    throw invalidPage();
  }
  if (!Number.isInteger(record.maxEntries)
    || (record.maxEntries as number) < 1
    || (record.maxEntries as number) > MAX_CATALOG_PAGE_ENTRIES) {
    throw invalidPage();
  }
  return {
    cursor: record.cursor as string | null,
    maxEntries: record.maxEntries as number
  };
}

function bytesRead(slot: StoredStorySlot): number {
  if (slot.kind === "legacy") return slot.raw.byteLength;
  if (slot.kind === "v5" || slot.kind === "v6-live" || slot.kind === "v6-deleted"
    || slot.kind === "v8-live" || slot.kind === "v8-deleted"
    || slot.kind === "v10-live" || slot.kind === "v10-deleted") {
    return slot.manifestBytes.byteLength;
  }
  return 0;
}

function summaryFromSlot(slot: StoredStorySlot): StorySummary | null {
  if (slot.kind === "legacy") return buildStoryCatalogSummary(slot.story);
  if (slot.kind === "v5") {
    return {
      ...buildStoryCatalogSummary(slot.manifest),
      aggregateVersion: {
        kind: "v5",
        manifestHash: hashStoryV5ManifestBytes(slot.manifestBytes)
      }
    };
  }
  // "v6" here names the concurrency-token shape (a revision counter), not
  // the schema version, a V8 envelope is revision-tracked exactly like a V6
  // one (see the matching comment on `aggregateVersionFromSlot` in
  // server/stories.ts). `storySummaryFromLiveEnvelope` already accepts
  // either envelope.
  if (slot.kind === "v6-live" || slot.kind === "v8-live" || slot.kind === "v10-live") {
    return {
      ...storySummaryFromLiveEnvelope(slot.manifest),
      aggregateVersion: {
        kind: "v6",
        revision: slot.manifest.revision
      }
    };
  }
  return null;
}

function invalidPage(): ServiceError {
  return new ServiceError(
    400,
    "Catalog page requires exactly cursor and maxEntries (1..64).",
    "invalid_request"
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function lstatOptional(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}
