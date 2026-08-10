/**
 * The owned bounded header parser for a Source Image.
 *
 * This module reads only the fixed-position header fields of PNG, JPEG, and
 * WebP: the magic bytes, the declared dimensions, and, for JPEG, the EXIF
 * orientation tag. It never asks a decoder to allocate a raster. It runs
 * before `server/image-photon.ts` touches the bytes, so a hostile or
 * oversized input is refused while it is still bytes.
 *
 * `server/image-normalize.ts` calls `parseImageHeader` first, on every
 * Source Image, with no exception.
 */
import {
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_DIMENSION,
  MAX_SOURCE_IMAGE_PIXELS,
  SOURCE_IMAGE_MEDIA_TYPES,
  type SourceImageMediaType
} from "../shared/image-attachment.js";
import { hasPngSignature, PNG_SIGNATURE } from "../shared/png-text-chunk.js";
import { ServiceError } from "./errors.js";

/** The eight EXIF orientation values. 1 means "no correction needed". */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageHeaderResult {
  readonly mediaType: SourceImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly orientation: ExifOrientation;
}

const JPEG_SOI = 0xd8;
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_APP1 = 0xe1;
/** Start-of-frame markers that carry dimensions. 0xc4 (DHT), 0xc8
 *  (reserved), and 0xcc (DAC) are excluded: they share the 0xc0-0xcf range
 *  but are not frame headers. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);
/** Markers with no length field and no payload: restart markers, SOI, TEM. */
const JPEG_STANDALONE_MARKERS = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8
]);
const JPEG_EOI = 0xd9;
const EXIF_ORIENTATION_TAG = 0x0112;
const EXIF_TYPE_SHORT = 3;

/**
 * Read the media type, dimensions, and EXIF orientation from a Source Image,
 * and reject anything the normalizer must not decode.
 *
 * @param declaredMediaType The content type the caller claimed for these
 *   bytes, when one was supplied (an HTTP request's `Content-Type`, for
 *   example). When it disagrees with the magic bytes, this throws
 *   `image_invalid` rather than trusting either source alone.
 */
export function parseImageHeader(
  bytes: Uint8Array,
  declaredMediaType?: string
): ImageHeaderResult {
  if (bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new ServiceError(
      413,
      `The image is larger than ${MAX_SOURCE_IMAGE_BYTES} bytes.`,
      "image_source_too_large"
    );
  }
  const mediaType = detectSourceMediaType(bytes);
  if (declaredMediaType !== undefined && declaredMediaType !== mediaType) {
    throw new ServiceError(
      400,
      "The declared image content type does not match the image bytes.",
      "image_invalid"
    );
  }
  const { width, height, orientation } = mediaType === "image/png"
    ? readPngHeader(bytes)
    : mediaType === "image/jpeg"
      ? readJpegHeader(bytes)
      : readWebpHeader(bytes);
  requireBoundedDimensions(width, height);
  return { mediaType, width, height, orientation };
}

function detectSourceMediaType(bytes: Uint8Array): SourceImageMediaType {
  if (hasPngSignature(bytes)) return "image/png";
  if (bytes.byteLength >= 3
    && bytes[0] === JPEG_MARKER_PREFIX
    && bytes[1] === JPEG_SOI
    && bytes[2] === JPEG_MARKER_PREFIX) {
    return "image/jpeg";
  }
  if (bytes.byteLength >= 12
    && asciiEquals(bytes, 0, "RIFF")
    && asciiEquals(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  throw new ServiceError(
    415,
    `Only ${SOURCE_IMAGE_MEDIA_TYPES.join(", ")} images are supported.`,
    "image_type_not_supported"
  );
}

function requireBoundedDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1) {
    throw new ServiceError(400, "The image header has invalid dimensions.", "image_invalid");
  }
  if (width > MAX_SOURCE_IMAGE_DIMENSION || height > MAX_SOURCE_IMAGE_DIMENSION) {
    throw new ServiceError(
      413,
      `The image is wider or taller than ${MAX_SOURCE_IMAGE_DIMENSION} pixels.`,
      "image_source_too_large"
    );
  }
  if (width * height > MAX_SOURCE_IMAGE_PIXELS) {
    throw new ServiceError(
      413,
      `The image has more than ${MAX_SOURCE_IMAGE_PIXELS} pixels.`,
      "image_source_too_large"
    );
  }
}

interface RawHeader {
  readonly width: number;
  readonly height: number;
  readonly orientation: ExifOrientation;
}

/**
 * PNG requires IHDR as the first chunk, so the width and height sit at fixed
 * offsets: the 8-byte signature (`PNG_SIGNATURE`), then a 4-byte chunk
 * length, a 4-byte "IHDR" type, then width and height as big-endian
 * 4-byte integers. PNG carries no EXIF orientation this parser reads; the
 * normalizer applies orientation 1 (no correction) to every PNG.
 */
function readPngHeader(bytes: Uint8Array): RawHeader {
  const chunkHeaderStart = PNG_SIGNATURE.length;
  const ihdrDataStart = chunkHeaderStart + 8;
  if (bytes.byteLength < ihdrDataStart + 13) {
    throw new ServiceError(400, "The PNG header is truncated.", "image_invalid");
  }
  if (!asciiEquals(bytes, chunkHeaderStart + 4, "IHDR")) {
    throw new ServiceError(400, "The PNG has no leading IHDR chunk.", "image_invalid");
  }
  const view = boundedView(bytes);
  const width = view.getUint32(ihdrDataStart, false);
  const height = view.getUint32(ihdrDataStart + 4, false);
  return { width, height, orientation: 1 };
}

/**
 * Walk JPEG marker segments from the SOI. Each APP1 segment is checked for
 * an EXIF orientation tag; the first start-of-frame segment supplies the
 * dimensions and ends the scan, because scan data after it is entropy-coded
 * and no longer safe to read as markers.
 */
function readJpegHeader(bytes: Uint8Array): RawHeader {
  const view = boundedView(bytes);
  let offset = 2;
  let orientation: ExifOrientation = 1;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== JPEG_MARKER_PREFIX) {
      throw new ServiceError(400, "The JPEG has an invalid marker.", "image_invalid");
    }
    const marker = bytes[offset + 1]!;
    if (marker === JPEG_EOI) break;
    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.byteLength) {
      throw new ServiceError(400, "The JPEG is truncated.", "image_invalid");
    }
    const length = view.getUint16(offset + 2, false);
    const segmentEnd = offset + 2 + length;
    if (length < 2 || segmentEnd > bytes.byteLength) {
      throw new ServiceError(400, "The JPEG is truncated.", "image_invalid");
    }
    if (marker === JPEG_APP1) {
      const found = readExifOrientation(bytes, view, offset + 4, segmentEnd);
      if (found !== null) orientation = found;
    } else if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 4 + 5 > bytes.byteLength) {
        throw new ServiceError(400, "The JPEG frame header is truncated.", "image_invalid");
      }
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      return { width, height, orientation };
    }
    offset = segmentEnd;
  }
  throw new ServiceError(400, "The JPEG has no frame header.", "image_invalid");
}

/**
 * Read the Orientation tag (0x0112) from one APP1 segment, when the segment
 * is an EXIF block and the tag is present with a plausible value. Anything
 * else, including a malformed TIFF header, reports no orientation rather
 * than rejecting the image: EXIF is auxiliary, and real files carry
 * imperfect copies of it.
 */
function readExifOrientation(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number
): ExifOrientation | null {
  const exifPrefix = "Exif\0\0";
  if (end - start < exifPrefix.length + 8) return null;
  if (!asciiEquals(bytes, start, exifPrefix)) return null;
  const tiffStart = start + exifPrefix.length;
  const byteOrderHigh = bytes[tiffStart];
  const byteOrderLow = bytes[tiffStart + 1];
  let littleEndian: boolean;
  if (byteOrderHigh === 0x49 && byteOrderLow === 0x49) littleEndian = true;
  else if (byteOrderHigh === 0x4d && byteOrderLow === 0x4d) littleEndian = false;
  else return null;
  if (view.getUint16(tiffStart + 2, littleEndian) !== 42) return null;
  const ifdOffset = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
  if (ifdOffset + 2 > end) return null;
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const entriesStart = ifdOffset + 2;
  if (entriesStart + entryCount * 12 > end) return null;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesStart + index * 12;
    const tag = view.getUint16(entryOffset, littleEndian);
    if (tag !== EXIF_ORIENTATION_TAG) continue;
    const type = view.getUint16(entryOffset + 2, littleEndian);
    if (type !== EXIF_TYPE_SHORT) return null;
    const value = view.getUint16(entryOffset + 8, littleEndian);
    return isExifOrientation(value) ? value : null;
  }
  return null;
}

function isExifOrientation(value: number): value is ExifOrientation {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

/**
 * WebP carries its dimensions in the first sub-chunk after the RIFF/WEBP
 * container header, in one of three layouts depending on the fourcc: an
 * extended header (`VP8X`), a lossy frame (`VP8 `), or a lossless bitstream
 * (`VP8L`). WebP orientation, when present, lives in an optional EXIF chunk
 * this parser does not read; the normalizer applies orientation 1 to every
 * WebP, matching the PNG behavior above.
 */
function readWebpHeader(bytes: Uint8Array): RawHeader {
  const view = boundedView(bytes);
  if (bytes.byteLength < 20) {
    throw new ServiceError(400, "The WebP header is truncated.", "image_invalid");
  }
  const fourCc = asciiSlice(bytes, 12, 16);
  if (fourCc === "VP8X") {
    if (bytes.byteLength < 30) {
      throw new ServiceError(400, "The WebP header is truncated.", "image_invalid");
    }
    const width = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16);
    const height = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16);
    return { width: width + 1, height: height + 1, orientation: 1 };
  }
  if (fourCc === "VP8L") {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) {
      throw new ServiceError(400, "The WebP lossless header is invalid.", "image_invalid");
    }
    const packed = view.getUint32(21, true);
    const width = packed & 0x3fff;
    const height = (packed >>> 14) & 0x3fff;
    return { width: width + 1, height: height + 1, orientation: 1 };
  }
  if (fourCc === "VP8 ") {
    if (bytes.byteLength < 30
      || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new ServiceError(400, "The WebP lossy header is invalid.", "image_invalid");
    }
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return { width, height, orientation: 1 };
  }
  throw new ServiceError(400, "The WebP has no recognized bitstream chunk.", "image_invalid");
}

function boundedView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function asciiEquals(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  let result = "";
  for (let index = start; index < end; index += 1) {
    result += String.fromCharCode(bytes[index]!);
  }
  return result;
}
