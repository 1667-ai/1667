/**
 * Canonical streaming POSIX ustar parser for release tarballs.
 * Owns header/checksum/octal/path/type/duplicate/entry-count/expanded-size/
 * cumulative file-byte/padding/two-zero-terminator validation and chunk state.
 * Consumers supply typed entry hooks for product-specific body handling.
 */

export const USTAR_BLOCK_BYTES = 512;

export type UstarEntryType = "file" | "directory";

export interface UstarEntry {
  readonly path: string;
  readonly type: UstarEntryType;
  readonly mode: number;
  readonly size: number;
}

export type UstarFail = (message: string, cause?: unknown) => Error;

export interface UstarParserOptions {
  readonly maximumExpandedBytes: number;
  readonly maximumEntries: number;
  readonly maximumTotalFileBytes: number;
  readonly fail: UstarFail;
  readonly onEntryStart: (entry: UstarEntry) => void;
  readonly onBody: (entry: UstarEntry, chunk: Uint8Array) => void;
  readonly onEntryEnd: (entry: UstarEntry) => void;
}

type ParserState = "header" | "body" | "padding" | "trailing";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Incremental ustar parser. Call consume for each expanded tar chunk, then finish.
 */
export class UstarStreamParser {
  readonly #options: UstarParserOptions;
  readonly #paths = new Set<string>();
  readonly #header = Buffer.alloc(USTAR_BLOCK_BYTES);
  #state: ParserState = "header";
  #headerBytes = 0;
  #expandedBytes = 0;
  #fileBytes = 0;
  #entryCount = 0;
  #zeroBlocks = 0;
  #bodyRemaining = 0;
  #paddingRemaining = 0;
  #current: UstarEntry | null = null;

  constructor(options: UstarParserOptions) {
    this.#options = options;
  }

  get expandedBytes(): number {
    return this.#expandedBytes;
  }

  get entryCount(): number {
    return this.#entryCount;
  }

  consume(chunk: Uint8Array): void {
    const fail = this.#options.fail;
    if (chunk.byteLength > this.#options.maximumExpandedBytes - this.#expandedBytes) {
      throw fail("Tarball expanded size exceeds the release bound");
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
          assertZero(chunk.subarray(offset), "Tarball has nonzero trailing bytes", fail);
          offset = chunk.byteLength;
          break;
      }
    }
  }

  /**
   * Completes parse after the stream ends. Rejects incomplete or non-aligned
   * archives. Does not interpret package-specific required paths.
   */
  finish(): void {
    const fail = this.#options.fail;
    if (this.#state !== "trailing" || this.#zeroBlocks !== 2) {
      if (this.#state === "body") throw fail("Tarball entry body is truncated");
      if (this.#state === "padding") throw fail("Tarball entry padding is truncated");
      throw fail("Tarball has no complete end marker");
    }
    if (this.#expandedBytes % USTAR_BLOCK_BYTES !== 0) {
      throw fail("Tarball has non-block-aligned trailing bytes");
    }
  }

  #consumeHeader(chunk: Uint8Array, offset: number): number {
    const count = Math.min(
      USTAR_BLOCK_BYTES - this.#headerBytes,
      chunk.byteLength - offset
    );
    this.#header.set(chunk.subarray(offset, offset + count), this.#headerBytes);
    this.#headerBytes += count;
    if (this.#headerBytes !== USTAR_BLOCK_BYTES) return offset + count;
    this.#headerBytes = 0;
    if (isZero(this.#header)) {
      this.#zeroBlocks += 1;
      if (this.#zeroBlocks === 2) this.#state = "trailing";
      return offset + count;
    }
    if (this.#zeroBlocks !== 0) {
      throw this.#options.fail("Tarball has data after one zero terminator block");
    }
    this.#startEntry(this.#header);
    return offset + count;
  }

  #startEntry(header: Uint8Array): void {
    const fail = this.#options.fail;
    if (this.#entryCount >= this.#options.maximumEntries) {
      throw fail("Tarball entry count exceeds the release bound");
    }
    validateHeaderChecksum(header, fail);
    if (fieldText(header, 257, 6, fail) !== "ustar"
      || fieldText(header, 263, 2, fail) !== "00") {
      throw fail("Tarball entry is not POSIX ustar");
    }
    const name = fieldText(header, 0, 100, fail);
    const prefix = fieldText(header, 345, 155, fail);
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    // Keep the full canonical octal mode (including setuid/setgid/sticky).
    // Consumers and policy must compare exact modes; do not mask to 0o777 here.
    const mode = octalField(header, 100, 8, "mode", fail);
    const size = octalField(header, 124, 12, "size", fail);
    const typeByte = header[156]!;
    const type: UstarEntryType | null = typeByte === 0 || typeByte === 0x30
      ? "file"
      : typeByte === 0x35
        ? "directory"
        : null;
    if (type === null) {
      throw fail(`Tarball contains unsupported entry type ${typeByte}`);
    }
    if (fieldText(header, 157, 100, fail).length !== 0) {
      throw fail("Tarball file or directory has link metadata");
    }
    const path = type === "directory" && rawPath.endsWith("/")
      ? rawPath.slice(0, -1)
      : rawPath;
    if (path.length === 0 || this.#paths.has(path)) {
      throw fail(`Tarball has an empty or duplicate path: ${path}`);
    }
    this.#paths.add(path);
    if (type === "directory" && size !== 0) {
      throw fail("Tarball directory has file bytes");
    }
    if (type === "file" && size > this.#options.maximumTotalFileBytes - this.#fileBytes) {
      throw fail("Tarball file bytes exceed the release bound");
    }
    const entry = Object.freeze({ path, type, mode, size });
    this.#current = entry;
    this.#options.onEntryStart(entry);
    this.#bodyRemaining = size;
    this.#paddingRemaining = (USTAR_BLOCK_BYTES - (size % USTAR_BLOCK_BYTES))
      % USTAR_BLOCK_BYTES;
    if (size === 0) this.#finishEntryBody();
    else this.#state = "body";
  }

  #consumeBody(chunk: Uint8Array, offset: number): number {
    const entry = this.#requireCurrent();
    const count = Math.min(this.#bodyRemaining, chunk.byteLength - offset);
    const bytes = chunk.subarray(offset, offset + count);
    this.#options.onBody(entry, bytes);
    this.#bodyRemaining -= count;
    if (this.#bodyRemaining === 0) this.#finishEntryBody();
    return offset + count;
  }

  #finishEntryBody(): void {
    const entry = this.#requireCurrent();
    if (entry.type === "file") this.#fileBytes += entry.size;
    this.#entryCount += 1;
    this.#options.onEntryEnd(entry);
    this.#state = this.#paddingRemaining === 0 ? "header" : "padding";
    if (this.#paddingRemaining === 0) this.#current = null;
  }

  #consumePadding(chunk: Uint8Array, offset: number): number {
    const count = Math.min(this.#paddingRemaining, chunk.byteLength - offset);
    assertZero(
      chunk.subarray(offset, offset + count),
      "Tarball entry padding is nonzero",
      this.#options.fail
    );
    this.#paddingRemaining -= count;
    if (this.#paddingRemaining === 0) {
      this.#current = null;
      this.#state = "header";
    }
    return offset + count;
  }

  #requireCurrent(): UstarEntry {
    if (this.#current === null) {
      throw this.#options.fail("Tarball parser entered an invalid state");
    }
    return this.#current;
  }
}

function validateHeaderChecksum(header: Uint8Array, fail: UstarFail): void {
  const expected = octalField(header, 148, 8, "checksum", fail);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw fail("Tarball header checksum is invalid");
}

function octalField(
  bytes: Uint8Array,
  start: number,
  length: number,
  label: string,
  fail: UstarFail
): number {
  const field = bytes.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    throw fail(`Tarball ${label} uses unsupported base-256`);
  }
  let raw = "";
  for (const byte of field) {
    if (byte > 0x7f) throw fail(`Tarball ${label} is not ASCII`);
    raw += String.fromCharCode(byte);
  }
  const zero = raw.indexOf("\0");
  if (zero !== -1 && !/^[\0 ]*$/u.test(raw.slice(zero))) {
    throw fail(`Tarball ${label} has noncanonical padding`);
  }
  const text = (zero === -1 ? raw : raw.slice(0, zero)).trim();
  if (!/^[0-7]+$/u.test(text)) throw fail(`Tarball ${label} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw fail(`Tarball ${label} exceeds safe integer range`);
  }
  return value;
}

function fieldText(
  bytes: Uint8Array,
  start: number,
  length: number,
  fail: UstarFail
): string {
  const field = bytes.subarray(start, start + length);
  const zero = field.indexOf(0);
  const content = zero === -1 ? field : field.subarray(0, zero);
  if (zero !== -1 && !isZero(field.subarray(zero))) {
    throw fail("Tarball text field has noncanonical padding");
  }
  try {
    return UTF8.decode(content);
  } catch (error) {
    throw fail("Tarball header path is not UTF-8", error);
  }
}

function isZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

function assertZero(bytes: Uint8Array, message: string, fail: UstarFail): void {
  if (!isZero(bytes)) throw fail(message);
}
