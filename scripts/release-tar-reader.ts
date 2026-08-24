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
  MAX_RELEASE_SBOM_BYTES,
  MAX_RELEASE_TARBALL_ENTRIES,
  MAX_RELEASE_TARBALL_FILE_BYTES,
  type ReleaseNoticeAttribution,
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
    noticeAttribution: ReleaseNoticeAttribution;
    entries: readonly TarballInspectionEntry[];
  };
}

/**
 * Reads, hashes, and validates a gzip-compressed ustar archive without extracting
 * it or retaining large file bodies in memory. It buffers only bounded JSON
 * metadata files. It hashes native executables incrementally.
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
  let documentChunks: Buffer[] | null = null;
  let packageManifest: unknown;
  let buildManifest: unknown;
  let noticeAttribution: ReleaseNoticeAttribution | undefined;

  return {
    onEntryStart(entry) {
      const captureDocument = entry.type === "file" && (
        entry.path === "package/package.json"
        || entry.path === "package/build-manifest.json"
        || entry.path === "package/sbom.spdx.json"
      );
      const maximum = entry.path === "package/sbom.spdx.json"
        ? MAX_RELEASE_SBOM_BYTES
        : MAX_RELEASE_MANIFEST_BYTES;
      if (captureDocument && (entry.size === 0 || entry.size > maximum)) {
        throw releaseTarballError(`Tarball ${entry.path} is outside the size bound`);
      }
      currentHash = entry.type === "file" ? createHash("sha256") : null;
      documentChunks = captureDocument ? [] : null;
    },
    onBody(chunk) {
      currentHash?.update(chunk);
      if (documentChunks !== null) documentChunks.push(Buffer.from(chunk));
    },
    onEntryEnd(entry) {
      if (documentChunks !== null) {
        parseDocument(entry.path, Buffer.concat(documentChunks, entry.size));
      }
      entries.push(Object.freeze({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
        sha256: currentHash?.digest("hex") ?? null
      }));
      currentHash = null;
      documentChunks = null;
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
      if (noticeAttribution === undefined) {
        throw releaseTarballError("Tarball SBOM NOTICE attribution could not be parsed");
      }
      return Object.freeze({
        packageManifest,
        buildManifest,
        inspection: Object.freeze({
          packageJsonSha256: packageJson.sha256,
          noticeAttribution,
          entries: Object.freeze(entries)
        })
      });
    }
  };

  function parseDocument(path: string, bytes: Uint8Array): void {
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
    else if (path === "package/build-manifest.json") buildManifest = parsed;
    else noticeAttribution = noticeAttributionFromSbom(parsed);
  }
}

function noticeAttributionFromSbom(value: unknown): ReleaseNoticeAttribution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw releaseTarballError("Tarball SBOM is not a JSON object");
  }
  const packages = (value as Record<string, unknown>).packages;
  if (!Array.isArray(packages)) {
    throw releaseTarballError("Tarball SBOM has no packages array");
  }
  const documentDescribes = (value as Record<string, unknown>).documentDescribes;
  if (!Array.isArray(documentDescribes) || documentDescribes.length !== 1
    || typeof documentDescribes[0] !== "string") {
    throw releaseTarballError("Tarball SBOM must describe one product package");
  }
  const products = packages.filter((entry) => {
    return entry !== null && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).SPDXID === documentDescribes[0];
  });
  if (products.length !== 1
    || (products[0] as Record<string, unknown>).name !== "1667") {
    throw releaseTarballError("Tarball SBOM must contain one 1667 product package");
  }
  const attributionTexts = (products[0] as Record<string, unknown>).attributionTexts;
  if (!Array.isArray(attributionTexts) || attributionTexts.length !== 1
    || typeof attributionTexts[0] !== "string" || attributionTexts[0].length === 0) {
    throw releaseTarballError("Tarball SBOM has incomplete NOTICE attribution");
  }
  const bytes = Buffer.from(attributionTexts[0], "utf8");
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  });
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
