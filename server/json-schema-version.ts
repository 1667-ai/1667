import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { noFollowFlag } from "./data-directory-file-read.js";
import { StoryFormatError } from "./story-format-facts.js";
import { SchemaVersionNumberScanner } from "./schema-version-number.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SCHEMA_KEY_BYTES = "schemaVersion".length * 6;
const MAX_JSON_NESTING = 256;
export const MAX_LEGACY_STORY_MANIFEST_BYTES = 64 * 1024 * 1024;

type ObjectState = "first-key-or-end" | "key" | "colon" | "value" | "comma-or-end";
type ArrayState = "first-value-or-end" | "value" | "comma-or-end";
type JsonFrame =
  | { kind: "object"; state: ObjectState }
  | { kind: "array"; state: ArrayState };
type StringRole = "key" | "value";

/** Read an oversized legacy manifest only after a constant-memory first pass
 * recognizes its last top-level schemaVersion. Both passes share one handle. */
export async function readOversizeLegacyManifestBytes(
  file: string,
  label: string
): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | noFollowFlag());
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new StoryFormatError(`${label} is not a regular file`);
    if (before.size > BigInt(MAX_LEGACY_STORY_MANIFEST_BYTES)) {
      throw new StoryFormatError(
        `${label} exceeds its ${MAX_LEGACY_STORY_MANIFEST_BYTES}-byte legacy migration limit`
      );
    }
    const scanner = new TopLevelSchemaVersionScanner();
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      scanner.push(buffer.subarray(0, bytesRead));
      if (scanner.isRejected()) return null;
      position += bytesRead;
      if (position > MAX_LEGACY_STORY_MANIFEST_BYTES) {
        throw new StoryFormatError(
          `${label} exceeds its ${MAX_LEGACY_STORY_MANIFEST_BYTES}-byte legacy migration limit`
        );
      }
    }
    const afterScan = await handle.stat({ bigint: true });
    if (!sameFileState(before, afterScan) || afterScan.size !== BigInt(position)) {
      throw new StoryFormatError(`${label} changed while being classified`);
    }
    if (scanner.finish() === null) return null;

    const allocation = Buffer.alloc(position + 1);
    let total = 0;
    while (total < allocation.length) {
      const { bytesRead } = await handle.read(allocation, total, allocation.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (total !== position || !sameFileState(afterScan, afterRead)) {
      throw new StoryFormatError(`${label} changed while being read`);
    }
    return allocation.subarray(0, total);
  } finally {
    await handle?.close();
  }
}

/** Byte-level discrimination used before choosing legacy replacement decoding
 * or the strict V5/V6 UTF-8 decoder. */
export function hasLegacyTopLevelSchemaVersion(bytes: Uint8Array): boolean {
  const scanner = new TopLevelSchemaVersionScanner();
  scanner.push(bytes);
  return scanner.finish() !== null;
}

class TopLevelSchemaVersionScanner {
  private readonly frames: JsonFrame[] = [];
  private rootStarted = false;
  private done = false;
  private invalid = false;
  private inString = false;
  private escaped = false;
  private unicodeEscapeDigits = 0;
  private stringRole: StringRole = "value";
  private stringBytes: number[] = [];
  private stringOverflow = false;
  private currentKeyIsSchemaVersion = false;
  private number: SchemaVersionNumberScanner | null = null;
  private numberIsSchemaVersion = false;
  private literalRemaining: string | null = null;
  private schemaVersion: 2 | 3 | 4 | null = null;

  push(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.pushByte(byte);
      if (this.invalid) break;
    }
  }

  isRejected(): boolean {
    return this.invalid;
  }

  finish(): 2 | 3 | 4 | null {
    if (this.number !== null) this.finishNumber();
    return this.done && !this.invalid ? this.schemaVersion : null;
  }

  private pushByte(byte: number): void {
    if (this.invalid) return;
    if (this.done) {
      if (!isWhitespace(byte)) this.invalid = true;
      return;
    }
    if (this.inString) {
      this.pushStringByte(byte);
      return;
    }
    if (this.number !== null) {
      if (isValueDelimiter(byte)) {
        this.finishNumber();
        if (!this.invalid) this.pushStructuralByte(byte);
      } else {
        this.number.push(byte);
      }
      return;
    }
    if (this.literalRemaining !== null) {
      this.pushLiteralByte(byte);
      return;
    }
    this.pushStructuralByte(byte);
  }

  private pushStringByte(byte: number): void {
    if (this.unicodeEscapeDigits > 0) {
      if (!isHexDigit(byte)) {
        this.invalid = true;
        return;
      }
      this.appendKeyByte(byte);
      this.unicodeEscapeDigits -= 1;
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (!isSimpleEscape(byte) && byte !== 0x75) {
        this.invalid = true;
        return;
      }
      this.appendKeyByte(byte);
      if (byte === 0x75) this.unicodeEscapeDigits = 4;
      return;
    }
    if (byte === 0x5c) {
      this.escaped = true;
      this.appendKeyByte(byte);
      return;
    }
    if (byte < 0x20) {
      this.invalid = true;
      return;
    }
    if (byte !== 0x22) {
      this.appendKeyByte(byte);
      return;
    }
    this.inString = false;
    if (this.stringRole === "key") {
      const frame = this.currentFrame();
      if (frame?.kind !== "object" || (frame.state !== "first-key-or-end" && frame.state !== "key")) {
        this.invalid = true;
        return;
      }
      if (this.frames.length === 1) {
        this.currentKeyIsSchemaVersion = !this.stringOverflow
          && decodeJsonKey(this.stringBytes) === "schemaVersion";
      }
      frame.state = "colon";
    } else {
      this.completeValue();
    }
  }

  private pushStructuralByte(byte: number): void {
    if (isWhitespace(byte)) return;
    if (!this.rootStarted) {
      if (byte !== 0x7b) this.invalid = true;
      else {
        this.rootStarted = true;
        this.frames.push({ kind: "object", state: "first-key-or-end" });
      }
      return;
    }
    const frame = this.currentFrame();
    if (frame === undefined) {
      this.invalid = true;
      return;
    }
    if (frame.kind === "object") {
      this.pushObjectByte(frame, byte);
    } else {
      this.pushArrayByte(frame, byte);
    }
  }

  private pushObjectByte(frame: Extract<JsonFrame, { kind: "object" }>, byte: number): void {
    switch (frame.state) {
      case "first-key-or-end":
        if (byte === 0x7d) this.closeContainer("object");
        else if (byte === 0x22) this.startString("key");
        else this.invalid = true;
        return;
      case "key":
        if (byte === 0x22) this.startString("key");
        else this.invalid = true;
        return;
      case "colon":
        if (byte === 0x3a) frame.state = "value";
        else this.invalid = true;
        return;
      case "value":
        this.startValue(byte);
        return;
      case "comma-or-end":
        if (byte === 0x2c) frame.state = "key";
        else if (byte === 0x7d) this.closeContainer("object");
        else this.invalid = true;
        return;
    }
  }

  private pushArrayByte(frame: Extract<JsonFrame, { kind: "array" }>, byte: number): void {
    switch (frame.state) {
      case "first-value-or-end":
        if (byte === 0x5d) this.closeContainer("array");
        else this.startValue(byte);
        return;
      case "value":
        this.startValue(byte);
        return;
      case "comma-or-end":
        if (byte === 0x2c) frame.state = "value";
        else if (byte === 0x5d) this.closeContainer("array");
        else this.invalid = true;
        return;
    }
  }

  private startValue(byte: number): void {
    const schemaValue = this.frames.length === 1 && this.currentKeyIsSchemaVersion;
    if (byte === 0x22) {
      if (schemaValue) this.schemaVersion = null;
      this.startString("value");
    } else if (byte === 0x7b || byte === 0x5b) {
      if (schemaValue) this.schemaVersion = null;
      this.openContainer(byte === 0x7b ? "object" : "array");
    } else if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
      if (schemaValue) this.schemaVersion = null;
      this.literalRemaining = byte === 0x74 ? "rue" : byte === 0x66 ? "alse" : "ull";
    } else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
      this.number = new SchemaVersionNumberScanner();
      this.numberIsSchemaVersion = schemaValue;
      this.number.push(byte);
    } else {
      this.invalid = true;
    }
  }

  private pushLiteralByte(byte: number): void {
    const remaining = this.literalRemaining;
    if (remaining === null || byte !== remaining.charCodeAt(0)) {
      this.invalid = true;
      return;
    }
    this.literalRemaining = remaining.length === 1 ? null : remaining.slice(1);
    if (this.literalRemaining === null) this.completeValue();
  }

  private finishNumber(): void {
    const number = this.number;
    if (number === null || !number.isValid()) {
      this.invalid = true;
      return;
    }
    if (this.numberIsSchemaVersion) this.schemaVersion = number.finish();
    this.number = null;
    this.numberIsSchemaVersion = false;
    this.completeValue();
  }

  private openContainer(kind: JsonFrame["kind"]): void {
    if (this.frames.length >= MAX_JSON_NESTING) {
      this.invalid = true;
      return;
    }
    this.frames.push(kind === "object"
      ? { kind, state: "first-key-or-end" }
      : { kind, state: "first-value-or-end" });
  }

  private closeContainer(kind: JsonFrame["kind"]): void {
    if (this.currentFrame()?.kind !== kind) {
      this.invalid = true;
      return;
    }
    this.frames.pop();
    if (this.frames.length === 0) this.done = true;
    else this.completeValue();
  }

  private completeValue(): void {
    const frame = this.currentFrame();
    if (frame?.kind === "object" && frame.state === "value") {
      frame.state = "comma-or-end";
    } else if (frame?.kind === "array" && (
      frame.state === "first-value-or-end" || frame.state === "value"
    )) {
      frame.state = "comma-or-end";
    } else {
      this.invalid = true;
    }
  }

  private startString(role: StringRole): void {
    this.inString = true;
    this.escaped = false;
    this.unicodeEscapeDigits = 0;
    this.stringRole = role;
    this.stringBytes = [];
    this.stringOverflow = false;
  }

  private appendKeyByte(byte: number): void {
    if (this.stringRole !== "key" || this.frames.length !== 1) return;
    if (this.stringBytes.length < MAX_SCHEMA_KEY_BYTES) this.stringBytes.push(byte);
    else this.stringOverflow = true;
  }

  private currentFrame(): JsonFrame | undefined {
    return this.frames[this.frames.length - 1];
  }
}

function decodeJsonKey(bytes: readonly number[]): string | null {
  if (bytes.some((byte) => byte > 0x7f)) return null;
  try {
    return JSON.parse(`"${String.fromCharCode(...bytes)}"`) as string;
  } catch {
    return null;
  }
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isValueDelimiter(byte: number): boolean {
  return isWhitespace(byte) || byte === 0x2c || byte === 0x7d || byte === 0x5d;
}

function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66);
}

function isSimpleEscape(byte: number): boolean {
  return byte === 0x22
    || byte === 0x5c
    || byte === 0x2f
    || byte === 0x62
    || byte === 0x66
    || byte === 0x6e
    || byte === 0x72
    || byte === 0x74;
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}
