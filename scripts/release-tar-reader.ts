import { createHash, type Hash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  MAX_RELEASE_TARBALL_ENTRIES,
  MAX_RELEASE_TARBALL_FILE_BYTES,
  type TarballInspectionEntry
} from "./release-package-policy.js";

export const MAX_RELEASE_TARBALL_GZIP_BYTES = 320 * 1024 * 1024;
export const MAX_RELEASE_TAR_ARCHIVE_BYTES = 288 * 1024 * 1024;

const TAR_BLOCK_BYTES = 512;
const MANIFEST_MAX_BYTES = 64 * 1024;
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
  const parser = new UstarParser();
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
  const parsed = parser.finish();
  return Object.freeze({
    ...parsed,
    gzip: Object.freeze({
      bytes: gzipBytes,
      sha256: gzipHash.digest("hex")
    })
  });
}

type ParserState = "header" | "body" | "padding" | "trailing";

interface CurrentEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  size: number;
  hash: Hash | null;
  manifestChunks: Buffer[] | null;
}

class UstarParser {
  readonly #entries: TarballInspectionEntry[] = [];
  readonly #paths = new Set<string>();
  readonly #header = Buffer.alloc(TAR_BLOCK_BYTES);
  #state: ParserState = "header";
  #headerBytes = 0;
  #expandedBytes = 0;
  #fileBytes = 0;
  #zeroBlocks = 0;
  #bodyRemaining = 0;
  #paddingRemaining = 0;
  #current: CurrentEntry | null = null;
  #packageManifest: unknown;
  #buildManifest: unknown;

  consume(chunk: Uint8Array): void {
    if (chunk.byteLength > MAX_RELEASE_TAR_ARCHIVE_BYTES - this.#expandedBytes) {
      throw releaseTarballError("Release tar archive exceeds the expanded size bound");
    }
    this.#expandedBytes += chunk.byteLength;
    let offset = 0;
    while (offset < chunk.byteLength) {
      switch (this.#state) {
        case "header":
          offset = this.#consumeHeader(chunk, offset);
          break;
        case "body":
          offset = this.#consumeBody(chunk, offset);
          break;
        case "padding":
          offset = this.#consumePadding(chunk, offset);
          break;
        case "trailing":
          assertZeroBytes(chunk.subarray(offset), "Tarball has nonzero trailing bytes");
          offset = chunk.byteLength;
          break;
      }
    }
  }

  finish(): Omit<ReadReleaseTarballResult, "gzip"> {
    if (this.#state !== "trailing" || this.#zeroBlocks !== 2) {
      if (this.#state === "body") throw releaseTarballError("Tarball entry body is truncated");
      if (this.#state === "padding") {
        throw releaseTarballError("Tarball entry padding is truncated");
      }
      throw releaseTarballError("Tarball has no complete end marker");
    }
    if (this.#expandedBytes % TAR_BLOCK_BYTES !== 0) {
      throw releaseTarballError("Tarball has non-block-aligned trailing bytes");
    }
    const packageJson = this.#entries.find((entry) => {
      return entry.type === "file" && entry.path === "package/package.json";
    });
    if (packageJson?.sha256 === null || packageJson === undefined) {
      throw releaseTarballError("Tarball has no package/package.json");
    }
    if (this.#packageManifest === undefined) {
      throw releaseTarballError("Tarball package.json could not be parsed");
    }
    if (this.#buildManifest === undefined) {
      throw releaseTarballError("Tarball build manifest could not be parsed");
    }
    return Object.freeze({
      packageManifest: this.#packageManifest,
      buildManifest: this.#buildManifest,
      inspection: Object.freeze({
        packageJsonSha256: packageJson.sha256,
        entries: Object.freeze(this.#entries)
      })
    });
  }

  #consumeHeader(chunk: Uint8Array, offset: number): number {
    const count = Math.min(
      TAR_BLOCK_BYTES - this.#headerBytes,
      chunk.byteLength - offset
    );
    this.#header.set(chunk.subarray(offset, offset + count), this.#headerBytes);
    this.#headerBytes += count;
    if (this.#headerBytes !== TAR_BLOCK_BYTES) return offset + count;
    this.#headerBytes = 0;
    if (isZeroBlock(this.#header)) {
      this.#zeroBlocks += 1;
      if (this.#zeroBlocks === 2) this.#state = "trailing";
      return offset + count;
    }
    if (this.#zeroBlocks !== 0) {
      throw releaseTarballError("Tarball has data after one zero terminator block");
    }
    this.#startEntry(this.#header);
    return offset + count;
  }

  #startEntry(header: Uint8Array): void {
    if (this.#entries.length >= MAX_RELEASE_TARBALL_ENTRIES) {
      throw releaseTarballError("Tarball entry count exceeds the release bound");
    }
    validateHeaderChecksum(header);
    if (fieldText(header, 257, 6) !== "ustar"
      || fieldText(header, 263, 2) !== "00") {
      throw releaseTarballError("Tarball entry is not POSIX ustar");
    }
    const name = fieldText(header, 0, 100);
    const prefix = fieldText(header, 345, 155);
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const mode = octalField(header, 100, 8, "mode");
    const size = octalField(header, 124, 12, "size");
    const typeByte = header[156]!;
    const type = typeByte === 0 || typeByte === 0x30
      ? "file"
      : typeByte === 0x35
        ? "directory"
        : null;
    if (type === null) {
      throw releaseTarballError(`Tarball contains unsupported entry type ${typeByte}`);
    }
    if (fieldText(header, 157, 100).length !== 0) {
      throw releaseTarballError("Tarball file or directory has link metadata");
    }
    const path = type === "directory" ? normalizeDirectoryPath(rawPath) : rawPath;
    if (path.length === 0 || this.#paths.has(path)) {
      throw releaseTarballError(`Tarball has an empty or duplicate path: ${path}`);
    }
    this.#paths.add(path);
    if (type === "directory" && size !== 0) {
      throw releaseTarballError("Tarball directory has file bytes");
    }
    if (type === "file" && size > MAX_RELEASE_TARBALL_FILE_BYTES - this.#fileBytes) {
      throw releaseTarballError("Tarball file bytes exceed the release bound");
    }
    const captureManifest = type === "file"
      && (path === "package/package.json" || path === "package/build-manifest.json");
    if (captureManifest && (size === 0 || size > MANIFEST_MAX_BYTES)) {
      throw releaseTarballError(`Tarball ${path} is outside the size bound`);
    }
    this.#current = {
      path,
      type,
      mode,
      size,
      hash: type === "file" ? createHash("sha256") : null,
      manifestChunks: captureManifest ? [] : null
    };
    this.#bodyRemaining = size;
    this.#paddingRemaining = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES))
      % TAR_BLOCK_BYTES;
    if (size === 0) this.#finishEntryBody();
    else this.#state = "body";
  }

  #consumeBody(chunk: Uint8Array, offset: number): number {
    const current = this.#requireCurrent();
    const count = Math.min(this.#bodyRemaining, chunk.byteLength - offset);
    const bytes = chunk.subarray(offset, offset + count);
    current.hash?.update(bytes);
    if (current.manifestChunks !== null) {
      current.manifestChunks.push(Buffer.from(bytes));
    }
    this.#bodyRemaining -= count;
    if (this.#bodyRemaining === 0) this.#finishEntryBody();
    return offset + count;
  }

  #finishEntryBody(): void {
    const current = this.#requireCurrent();
    if (current.type === "file") this.#fileBytes += current.size;
    if (current.manifestChunks !== null) {
      this.#parseManifest(current.path, Buffer.concat(current.manifestChunks, current.size));
    }
    this.#entries.push(Object.freeze({
      path: current.path,
      type: current.type,
      mode: current.mode,
      size: current.size,
      sha256: current.hash?.digest("hex") ?? null
    }));
    this.#state = this.#paddingRemaining === 0 ? "header" : "padding";
    if (this.#paddingRemaining === 0) this.#current = null;
  }

  #consumePadding(chunk: Uint8Array, offset: number): number {
    const count = Math.min(this.#paddingRemaining, chunk.byteLength - offset);
    assertZeroBytes(
      chunk.subarray(offset, offset + count),
      "Tarball entry padding is nonzero"
    );
    this.#paddingRemaining -= count;
    if (this.#paddingRemaining === 0) {
      this.#current = null;
      this.#state = "header";
    }
    return offset + count;
  }

  #parseManifest(path: string, bytes: Uint8Array): void {
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
    if (path === "package/package.json") this.#packageManifest = parsed;
    else this.#buildManifest = parsed;
  }

  #requireCurrent(): CurrentEntry {
    if (this.#current === null) {
      throw releaseTarballError("Tarball parser entered an invalid state");
    }
    return this.#current;
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

function validateHeaderChecksum(header: Uint8Array): void {
  const expected = octalField(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw releaseTarballError("Tarball header checksum is invalid");
}

function octalField(
  bytes: Uint8Array,
  start: number,
  length: number,
  label: string
): number {
  const field = bytes.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    throw releaseTarballError(`Tarball ${label} uses unsupported base-256`);
  }
  const raw = ascii(field);
  const zero = raw.indexOf("\0");
  if (zero !== -1 && !/^[\0 ]*$/u.test(raw.slice(zero))) {
    throw releaseTarballError(`Tarball ${label} has noncanonical padding`);
  }
  const text = (zero === -1 ? raw : raw.slice(0, zero)).trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw releaseTarballError(`Tarball ${label} is not canonical octal`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw releaseTarballError(`Tarball ${label} exceeds safe integer range`);
  }
  return value;
}

function fieldText(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const zero = field.indexOf(0);
  const content = zero === -1 ? field : field.subarray(0, zero);
  if (zero !== -1 && !isZeroBlock(field.subarray(zero))) {
    throw releaseTarballError("Tarball text field has noncanonical padding");
  }
  try {
    return UTF8.decode(content);
  } catch (error) {
    throw releaseTarballError("Tarball header path is not UTF-8", error);
  }
}

function ascii(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    if (byte > 0x7f) throw releaseTarballError("Tarball numeric field is not ASCII");
    value += String.fromCharCode(byte);
  }
  return value;
}

function normalizeDirectoryPath(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

function assertZeroBytes(bytes: Uint8Array, message: string): void {
  if (!isZeroBlock(bytes)) throw releaseTarballError(message);
}

class ReleaseTarballError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseTarballError";
  }
}

function releaseTarballError(message: string, cause?: unknown): ReleaseTarballError {
  return cause === undefined
    ? new ReleaseTarballError(message)
    : new ReleaseTarballError(message, { cause });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
