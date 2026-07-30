/**
 * Streams a gzip platform package, validates release package policy, and
 * extracts only the native executable. Ustar FSM lives in release-ustar.ts.
 */
import { createHash, type Hash } from "node:crypto";
import { closeSync, lstatSync, renameSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  MAX_RELEASE_ARTIFACT_ENTRIES,
  MAX_RELEASE_ARTIFACT_GZIP_BYTES,
  MAX_RELEASE_ARTIFACT_TAR_BYTES,
  MAX_RELEASE_EXECUTABLE_BYTES,
  MAX_RELEASE_MANIFEST_BYTES
} from "./release-artifact-bounds.js";
import {
  closeAndFsync,
  openExclusiveWrite,
  removeQuietly,
  writeAll,
  type StagingMode
} from "./safe-file-write.js";
import {
  validatePlatformPackageInspection,
  type ValidatedPlatformPackage
} from "./platform-package-policy.js";
import type { PublishedPlatformPackage } from "./release-targets.js";
import type { TarballEntry } from "./release-package-layout.js";
import {
  UstarStreamParser,
  type UstarEntry
} from "./release-ustar.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type ReleaseTarInput =
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface ExtractedPlatformPackage extends ValidatedPlatformPackage {
  readonly gzipBytes: number;
  readonly gzipSha256: string;
  readonly gzipSha512: string;
  readonly executablePath: string;
}

/**
 * Streams a gzip-compressed npm platform package, validates the exact release
 * package policy, and extracts only the native executable with exclusive create.
 */
export async function extractPlatformPackageExecutable(
  input: ReleaseTarInput,
  options: {
    readonly packageName: PublishedPlatformPackage;
    readonly version: string;
    readonly destinationPath: string;
    readonly maximumGzipBytes?: number;
    /** Cumulative regular-file payload bound (default: expanded archive total). */
    readonly maximumTotalFileBytes?: number;
    /** Per-executable entry bound (default: executable max). */
    readonly maximumExecutableBytes?: number;
    /** Optional abort; settles the extract promise and cleans staging/destination. */
    readonly signal?: AbortSignal;
  }
): Promise<ExtractedPlatformPackage> {
  const maximumGzip = options.maximumGzipBytes ?? MAX_RELEASE_ARTIFACT_GZIP_BYTES;
  const maximumTotalFileBytes = options.maximumTotalFileBytes ?? MAX_RELEASE_ARTIFACT_TAR_BYTES;
  const maximumExecutableBytes = options.maximumExecutableBytes ?? MAX_RELEASE_EXECUTABLE_BYTES;
  const signal = options.signal;
  if (signal?.aborted) throw abortAsTarError(signal);
  const stagingPath = `${options.destinationPath}.extract.${process.pid}`;
  refuseUnsafeExistingPath(stagingPath, "Extract staging path");
  refuseUnsafeExistingPath(options.destinationPath, "Candidate destination path");
  removeQuietly(stagingPath);
  removeQuietly(options.destinationPath);
  const gzipSha256 = createHash("sha256");
  const gzipSha512 = createHash("sha512");
  let gzipBytes = 0;
  const sinkState = createExtractSink(stagingPath, maximumExecutableBytes);
  const parser = new UstarStreamParser({
    maximumExpandedBytes: MAX_RELEASE_ARTIFACT_TAR_BYTES,
    maximumEntries: MAX_RELEASE_ARTIFACT_ENTRIES,
    maximumTotalFileBytes,
    fail: tarError,
    onEntryStart: (entry) => sinkState.onEntryStart(entry),
    onBody: (entry, chunk) => sinkState.onBody(entry, chunk),
    onEntryEnd: (entry) => sinkState.onEntryEnd(entry)
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      try {
        if (signal?.aborted) {
          callback(abortAsTarError(signal));
          return;
        }
        parser.consume(chunk);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  async function* boundedGzipChunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of inputChunks(input)) {
      if (signal?.aborted) throw abortAsTarError(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw tarError("Release package input contains a non-byte chunk");
      }
      if (chunk.byteLength === 0) continue;
      if (chunk.byteLength > maximumGzip - gzipBytes) {
        throw tarError("Release package gzip size is outside the bound");
      }
      gzipBytes += chunk.byteLength;
      gzipSha256.update(chunk);
      gzipSha512.update(chunk);
      yield chunk;
    }
    if (gzipBytes === 0) throw tarError("Release package gzip size is outside the bound");
  }

  const source = Readable.from(boundedGzipChunks(), { objectMode: false });
  try {
    if (signal === undefined) {
      await pipeline(source, createGunzip(), sink);
    } else {
      await pipeline(source, createGunzip(), sink, { signal });
    }
    if (signal?.aborted) throw abortAsTarError(signal);
    parser.finish();
    const parsed = sinkState.finish();
    const validated = validatePlatformPackageInspection({
      packageName: options.packageName,
      version: options.version,
      packageManifest: parsed.packageManifest,
      buildManifest: parsed.buildManifest,
      entries: parsed.entries
    });
    if (validated.executableSha256 !== parsed.executableSha256
      || validated.packageExecutablePath !== parsed.packageExecutablePath) {
      throw tarError("Extracted executable digest did not match the package policy");
    }
    renameSync(stagingPath, options.destinationPath);
    return Object.freeze({
      ...validated,
      gzipBytes,
      gzipSha256: gzipSha256.digest("hex"),
      gzipSha512: gzipSha512.digest("hex"),
      executablePath: options.destinationPath
    });
  } catch (error) {
    sinkState.abort();
    destroyQuietly(source);
    removeQuietly(stagingPath);
    removeQuietly(options.destinationPath);
    if (signal?.aborted || isAbortError(error)) {
      throw abortAsTarError(signal, error);
    }
    if (error instanceof ReleaseTarError) throw error;
    if (error instanceof Error && error.name === "ReleaseTarError") throw error;
    throw tarError(
      error instanceof Error ? error.message : "Release package could not be extracted",
      error
    );
  }
}

export function sha512Integrity(digestHex: string): string {
  return `sha512-${Buffer.from(digestHex, "hex").toString("base64")}`;
}

export function integrityMatches(integrity: string, sha512Hex: string): boolean {
  return integrity === sha512Integrity(sha512Hex);
}

function createExtractSink(
  destinationPath: string,
  maximumExecutableBytes: number
): {
  onEntryStart(entry: UstarEntry): void;
  onBody(entry: UstarEntry, chunk: Uint8Array): void;
  onEntryEnd(entry: UstarEntry): void;
  finish(): {
    packageManifest: unknown;
    buildManifest: unknown;
    entries: readonly TarballEntry[];
    packageExecutablePath: string;
    executableSha256: string;
  };
  abort(): void;
} {
  const entries: TarballEntry[] = [];
  let currentHash: Hash | null = null;
  let manifestChunks: Buffer[] | null = null;
  let executableFd: number | null = null;
  let packageExecutablePath: string | null = null;
  let executableSha256: string | null = null;
  let packageManifest: unknown;
  let buildManifest: unknown;

  return {
    onEntryStart(entry) {
      currentHash = entry.type === "file" ? createHash("sha256") : null;
      manifestChunks = entry.type === "file"
        && (entry.path === "package/package.json" || entry.path === "package/build-manifest.json")
        ? []
        : null;
      if (manifestChunks !== null
        && (entry.size === 0 || entry.size > MAX_RELEASE_MANIFEST_BYTES)) {
        throw tarError(`Tarball ${entry.path} is outside the size bound`);
      }
      if (entry.type === "file"
        && entry.path.startsWith("package/bin/")
        && entry.mode === 0o755) {
        if (packageExecutablePath !== null) {
          throw tarError("Package contains more than one executable");
        }
        if (entry.size === 0 || entry.size > maximumExecutableBytes) {
          throw tarError("Package executable entry is outside the size bound");
        }
        packageExecutablePath = entry.path;
        executableFd = openExclusiveWrite(destinationPath, 0o755 as StagingMode);
      }
    },
    onBody(entry, chunk) {
      currentHash?.update(chunk);
      if (manifestChunks !== null) manifestChunks.push(Buffer.from(chunk));
      if (executableFd !== null && entry.path === packageExecutablePath) {
        writeAll(executableFd, chunk);
      }
    },
    onEntryEnd(entry) {
      if (manifestChunks !== null) {
        parseManifest(entry.path, Buffer.concat(manifestChunks, entry.size));
      }
      const sha256 = currentHash?.digest("hex") ?? null;
      if (entry.path === packageExecutablePath && executableFd !== null) {
        closeAndFsync(executableFd, destinationPath);
        executableFd = null;
        executableSha256 = sha256;
      }
      entries.push(Object.freeze({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
        sha256
      }));
      currentHash = null;
      manifestChunks = null;
    },
    finish() {
      if (executableFd !== null) {
        throw tarError("Package executable write was not finished");
      }
      if (packageManifest === undefined || buildManifest === undefined) {
        throw tarError("Tarball is missing package or build manifest");
      }
      if (packageExecutablePath === null || executableSha256 === null) {
        throw tarError("Tarball is missing the platform executable");
      }
      return {
        packageManifest,
        buildManifest,
        entries,
        packageExecutablePath,
        executableSha256
      };
    },
    abort() {
      if (executableFd !== null) {
        try {
          closeSync(executableFd);
        } catch {
          // Best effort.
        }
        executableFd = null;
      }
      removeQuietly(destinationPath);
    }
  };

  function parseManifest(path: string, bytes: Uint8Array): void {
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch (error) {
      throw tarError(`Tarball ${path} is not UTF-8`, error);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonRejectingDuplicateKeys(text);
    } catch (error) {
      throw tarError(`Tarball ${path} is not strict JSON`, error);
    }
    if (path === "package/package.json") packageManifest = parsed;
    else buildManifest = parsed;
  }
}

async function* inputChunks(input: ReleaseTarInput): AsyncGenerator<Uint8Array> {
  if (input instanceof Uint8Array) {
    yield input;
    return;
  }
  for await (const chunk of input) yield chunk;
}

class ReleaseTarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseTarError";
  }
}

function tarError(message: string, cause?: unknown): ReleaseTarError {
  // Map shared FSM wording to extract/package error categories used by callers.
  const mapped = message
    .replace(
      "Tarball expanded size exceeds the release bound",
      "Release package tar archive exceeds the expanded size bound"
    );
  return cause === undefined
    ? new ReleaseTarError(mapped)
    : new ReleaseTarError(mapped, { cause });
}

function refuseUnsafeExistingPath(path: string, label: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw tarError(`${label} must not be a symbolic link`);
    }
    if (!stats.isFile()) {
      throw tarError(`${label} must be a regular file or absent`);
    }
  } catch (error) {
    if (error instanceof ReleaseTarError) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}

function abortAsTarError(signal?: AbortSignal, cause?: unknown): ReleaseTarError {
  const reason = signal?.reason;
  const base = reason instanceof Error
    ? reason
    : cause instanceof Error
      ? cause
      : new DOMException("The operation was aborted", "AbortError");
  // Preserve AbortError name so callers can map interruption without string match.
  const error = new ReleaseTarError(
    base.message || "The operation was aborted",
    { cause: base }
  );
  error.name = "AbortError";
  return error;
}

function destroyQuietly(stream: Readable): void {
  try {
    stream.destroy();
  } catch {
    // Best effort.
  }
}
