/**
 * Non-extracting release tarball reader. Ustar FSM lives in shared/release-ustar.ts.
 * This module owns gzip bounds, manifest capture, and entry hashing for policy.
 */
import { createHash, type Hash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  MAX_RELEASE_ARTIFACT_GZIP_BYTES,
  MAX_RELEASE_ARTIFACT_TAR_BYTES,
  MAX_RELEASE_MANIFEST_BYTES
} from "../shared/release-artifact-bounds.js";
import {
  UstarStreamParser,
  type UstarEntry
} from "../shared/release-ustar.js";
import {
  MAX_RELEASE_TARBALL_ENTRIES,
  MAX_RELEASE_TARBALL_FILE_BYTES,
  type TarballInspectionEntry
} from "./release-package-policy.js";

export const MAX_RELEASE_TARBALL_GZIP_BYTES = MAX_RELEASE_ARTIFACT_GZIP_BYTES;
export const MAX_RELEASE_TAR_ARCHIVE_BYTES = MAX_RELEASE_ARTIFACT_TAR_BYTES;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type ReleaseTarballInput =
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface ReadReleaseTarballResult {
  packageManifest: unknown;
  buildManifest: unknown;
  gzip: {
    bytes: number;
    sha256: string;
  };
  inspection: {
    packageJsonSha256: string;
    entries: readonly TarballInspectionEntry[];
  };
}

/**
 * Reads, hashes, and validates a gzip-compressed ustar archive without extracting
 * it or retaining file bodies in memory. Only the two bounded JSON manifests are
 * buffered; native executables are hashed incrementally.
 */
export async function readReleaseTarball(
  input: ReleaseTarballInput
): Promise<ReadReleaseTarballResult> {
  const gzipHash = createHash("sha256");
  let gzipBytes = 0;
  const sinkState = createInspectionSink();
  const parser = new UstarStreamParser({
    maximumExpandedBytes: MAX_RELEASE_TAR_ARCHIVE_BYTES,
    maximumEntries: MAX_RELEASE_TARBALL_ENTRIES,
    maximumTotalFileBytes: MAX_RELEASE_TARBALL_FILE_BYTES,
    fail: releaseTarballError,
    onEntryStart: (entry) => sinkState.onEntryStart(entry),
    onBody: (_entry, chunk) => sinkState.onBody(chunk),
    onEntryEnd: (entry) => sinkState.onEntryEnd(entry)
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      try {
        parser.consume(chunk);
        callback();
      } catch (error) {
        callback(asError(error));
      }
    }
  });

  async function* boundedGzipChunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of inputChunks(input)) {
      if (!(chunk instanceof Uint8Array)) {
        throw releaseTarballError("Release tarball input contains a non-byte chunk");
      }
      if (chunk.byteLength === 0) continue;
      if (chunk.byteLength > MAX_RELEASE_TARBALL_GZIP_BYTES - gzipBytes) {
        throw releaseTarballError("Release tarball gzip size is outside the bound");
      }
      gzipBytes += chunk.byteLength;
      gzipHash.update(chunk);
      yield chunk;
    }
    if (gzipBytes === 0) {
      throw releaseTarballError("Release tarball gzip size is outside the bound");
    }
  }

  try {
    await pipeline(
      Readable.from(boundedGzipChunks(), { objectMode: false }),
      createGunzip(),
      sink
    );
  } catch (error) {
    if (error instanceof ReleaseTarballError) throw error;
    throw releaseTarballError("Release tarball is not a bounded gzip stream", error);
  }
  parser.finish();
  const parsed = sinkState.finish();
  return Object.freeze({
    ...parsed,
    gzip: Object.freeze({
      bytes: gzipBytes,
      sha256: gzipHash.digest("hex")
    })
  });
}

function createInspectionSink(): {
  onEntryStart(entry: UstarEntry): void;
  onBody(chunk: Uint8Array): void;
  onEntryEnd(entry: UstarEntry): void;
  finish(): Omit<ReadReleaseTarballResult, "gzip">;
} {
  const entries: TarballInspectionEntry[] = [];
  let currentHash: Hash | null = null;
  let manifestChunks: Buffer[] | null = null;
  let packageManifest: unknown;
  let buildManifest: unknown;

  return {
    onEntryStart(entry) {
      const captureManifest = entry.type === "file"
        && (entry.path === "package/package.json" || entry.path === "package/build-manifest.json");
      if (captureManifest && (entry.size === 0 || entry.size > MAX_RELEASE_MANIFEST_BYTES)) {
        throw releaseTarballError(`Tarball ${entry.path} is outside the size bound`);
      }
      currentHash = entry.type === "file" ? createHash("sha256") : null;
      manifestChunks = captureManifest ? [] : null;
    },
    onBody(chunk) {
      currentHash?.update(chunk);
      if (manifestChunks !== null) manifestChunks.push(Buffer.from(chunk));
    },
    onEntryEnd(entry) {
      if (manifestChunks !== null) {
        parseManifest(entry.path, Buffer.concat(manifestChunks, entry.size));
      }
      entries.push(Object.freeze({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
        sha256: currentHash?.digest("hex") ?? null
      }));
      currentHash = null;
      manifestChunks = null;
    },
    finish() {
      const packageJson = entries.find((entry) => {
        return entry.type === "file" && entry.path === "package/package.json";
      });
      if (packageJson?.sha256 === null || packageJson === undefined) {
        throw releaseTarballError("Tarball has no package/package.json");
      }
      if (packageManifest === undefined) {
        throw releaseTarballError("Tarball package.json could not be parsed");
      }
      if (buildManifest === undefined) {
        throw releaseTarballError("Tarball build manifest could not be parsed");
      }
      return Object.freeze({
        packageManifest,
        buildManifest,
        inspection: Object.freeze({
          packageJsonSha256: packageJson.sha256,
          entries: Object.freeze(entries)
        })
      });
    }
  };

  function parseManifest(path: string, bytes: Uint8Array): void {
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch (error) {
      throw releaseTarballError(`Tarball ${path} is not UTF-8`, error);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonRejectingDuplicateKeys(text);
    } catch (error) {
      throw releaseTarballError(`Tarball ${path} is not strict JSON`, error);
    }
    if (path === "package/package.json") packageManifest = parsed;
    else buildManifest = parsed;
  }
}

async function* inputChunks(
  input: ReleaseTarballInput
): AsyncGenerator<Uint8Array> {
  if (input instanceof Uint8Array) {
    yield input;
    return;
  }
  for await (const chunk of input) yield chunk;
}

class ReleaseTarballError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseTarballError";
  }
}

function releaseTarballError(message: string, cause?: unknown): ReleaseTarballError {
  // Preserve reader wording for expanded-size failures.
  const mapped = message
    .replace(
      "Tarball expanded size exceeds the release bound",
      "Release tar archive exceeds the expanded size bound"
    );
  return cause === undefined
    ? new ReleaseTarballError(mapped)
    : new ReleaseTarballError(mapped, { cause });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
