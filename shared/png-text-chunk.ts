const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CHUNK_PAYLOAD_BYTES = 1_000_000;
const DEFAULT_LABEL = "Character card";

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Read a text chunk from a PNG file by keyword.
 * Returns the decoded string if found, or null if no chunk with the keyword exists.
 * Throws if the PNG structure or metadata is invalid.
 *
 * More than one archive kind travels in a PNG, so the caller names the kind it
 * is reading. A lorebook must not report a character-card error.
 */
export function readPngTextChunk(
  bytes: Uint8Array,
  keyword: string,
  label: string = DEFAULT_LABEL
): string | null {
  if (!hasPngSignature(bytes)) return null;
  const payload = scanPngTextChunk(bytes, keyword, label);
  if (payload === null) return null;

  return decodeTextChunkPayload(payload, keyword, label);
}

function scanPngTextChunk(bytes: Uint8Array, keyword: string, label: string): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let payload: string | null = null;
  let sawEnd = false;

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) {
      throw new Error(`${label} PNG has a truncated chunk.`);
    }
    const length = view.getUint32(offset, false);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) {
      throw new Error(`${label} PNG has an invalid chunk length.`);
    }
    const type = ascii(bytes, offset + 4, offset + 8, label);
    if (type === "tEXt") {
      const separator = findByte(bytes, 0, dataStart, dataEnd);
      if (separator !== -1) {
        if (equalsAscii(bytes, dataStart, separator, keyword)) {
          if (payload !== null) {
            throw new Error(`${label} PNG contains duplicate ${keyword} metadata.`);
          }
          payload = ascii(bytes, separator + 1, dataEnd, label);
        }
      }
    } else if (type === "zTXt" || type === "iTXt") {
      const separator = findByte(bytes, 0, dataStart, dataEnd);
      if (separator !== -1 && equalsAscii(bytes, dataStart, separator, keyword)) {
        throw new Error(`Compressed ${label} PNG metadata is not supported; export it again uncompressed.`);
      }
    } else if (type === "IEND") {
      if (length !== 0) {
        throw new Error(`${label} PNG has an invalid IEND chunk.`);
      }
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawEnd) {
    throw new Error(`${label} PNG is missing its IEND chunk.`);
  }

  return payload;
}

function decodeTextChunkPayload(source: string, keyword: string, label: string): string {
  const encoded = source.trim();
  const maxEncoded = Math.ceil(MAX_CHUNK_PAYLOAD_BYTES / 3) * 4;
  if (encoded.length === 0 || encoded.length > maxEncoded || !BASE64.test(encoded)) {
    throw new Error(`${label} PNG contains invalid or oversized Base64 metadata.`);
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error(`${label} PNG contains invalid Base64 metadata.`);
  }
  if (decoded.length > MAX_CHUNK_PAYLOAD_BYTES) {
    throw new Error(`${label} data exceeds the 1 MB limit.`);
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} data is not valid UTF-8.`);
  }
}

function ascii(bytes: Uint8Array, start: number, end: number, label: string): string {
  let result = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index]!;
    if (byte > 127) {
      throw new Error(`${label} PNG metadata is not valid ASCII.`);
    }
    result += String.fromCharCode(byte);
  }
  return result;
}

function findByte(bytes: Uint8Array, value: number, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] === value) return index;
  }
  return -1;
}

function equalsAscii(bytes: Uint8Array, start: number, end: number, expected: string): boolean {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[start + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}
