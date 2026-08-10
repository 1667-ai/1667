/**
 * Runtime fixture generator for image normalization tests. Nothing here is
 * checked into the repository as a binary file: every fixture is built from
 * photon's own encoder, or from a small number of hand-written bytes for the
 * cases photon cannot produce (a decompression bomb, an EXIF segment).
 */
import { deflateSync } from "node:zlib";
import { loadPhoton, type Photon } from "../server/image-photon.js";

export interface RgbaPixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Build a raw RGBA raster from a per-pixel function, and wrap it as a
 *  photon source image ready to encode. */
async function rasterImage(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => RgbaPixel
): Promise<{ readonly photon: Photon; readonly image: InstanceType<Photon["PhotonImage"]> }> {
  const photon = await loadPhoton();
  const raw = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { r, g, b, a } = pixelAt(x, y);
      const index = (y * width + x) * 4;
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
      raw[index + 3] = a;
    }
  }
  return { photon, image: new photon.PhotonImage(raw, width, height) };
}

/** A four-quadrant image: distinct colors in each corner, opaque. Useful
 *  for proving an orientation transform landed the right quadrant in the
 *  right place, not just that it ran. */
export async function quadrantImage(width: number, height: number): Promise<Uint8Array> {
  const { image } = await rasterImage(width, height, (x, y) => {
    const left = x < width / 2;
    const top = y < height / 2;
    if (top && left) return { r: 255, g: 0, b: 0, a: 255 };
    if (top && !left) return { r: 0, g: 255, b: 0, a: 255 };
    if (!top && left) return { r: 0, g: 0, b: 255, a: 255 };
    return { r: 255, g: 255, b: 255, a: 255 };
  });
  return image.get_bytes();
}

export type QuadrantColor = "R" | "G" | "B" | "W" | "?";

/** Classify the color at one pixel of a decoded quadrant image, for
 *  asserting where a transform moved each corner's color. */
export async function quadrantAt(
  bytes: Uint8Array,
  x: number,
  y: number
): Promise<QuadrantColor> {
  const photon = await loadPhoton();
  const decoded = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    const width = decoded.get_width();
    const pixels = decoded.get_raw_pixels();
    const index = (y * width + x) * 4;
    const r = pixels[index]!, g = pixels[index + 1]!, b = pixels[index + 2]!;
    if (r > 200 && g > 200 && b > 200) return "W";
    if (r > 200 && g < 80 && b < 80) return "R";
    if (g > 200 && r < 80 && b < 80) return "G";
    if (b > 200 && r < 80 && g < 80) return "B";
    return "?";
  } finally {
    decoded.free();
  }
}

export async function decodedDimensions(
  bytes: Uint8Array
): Promise<{ readonly width: number; readonly height: number }> {
  const photon = await loadPhoton();
  const decoded = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    return { width: decoded.get_width(), height: decoded.get_height() };
  } finally {
    decoded.free();
  }
}

export async function minAlpha(bytes: Uint8Array): Promise<number> {
  const photon = await loadPhoton();
  const decoded = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    const pixels = decoded.get_raw_pixels();
    let min = 255;
    for (let index = 3; index < pixels.length; index += 4) {
      min = Math.min(min, pixels[index]!);
    }
    return min;
  } finally {
    decoded.free();
  }
}

/** An opaque PNG Source Image. */
export async function opaquePng(width: number, height: number): Promise<Uint8Array> {
  const { image } = await rasterImage(width, height, (x, y) => (
    { r: x % 256, g: y % 256, b: 128, a: 255 }
  ));
  return image.get_bytes();
}

/** A PNG Source Image with a transparent region. */
export async function transparentPng(width: number, height: number): Promise<Uint8Array> {
  const { image } = await rasterImage(width, height, (x, y) => (
    { r: x % 256, g: y % 256, b: 128, a: x < width / 2 ? 128 : 255 }
  ));
  return image.get_bytes();
}

export async function opaqueJpeg(
  width: number,
  height: number,
  quality = 90
): Promise<Uint8Array> {
  const { image } = await rasterImage(width, height, (x, y) => (
    { r: x % 256, g: y % 256, b: 128, a: 255 }
  ));
  return image.get_bytes_jpeg(quality);
}

export async function opaqueWebp(width: number, height: number): Promise<Uint8Array> {
  const { image } = await rasterImage(width, height, (x, y) => (
    { r: x % 256, g: y % 256, b: 128, a: 255 }
  ));
  return image.get_bytes_webp();
}

/** High-entropy content that resists lossless and lossy compression alike,
 *  for driving the deterministic reduction sequence past its first step. */
export async function noiseImage(
  width: number,
  height: number,
  transparent: boolean
): Promise<{ readonly png: Uint8Array; readonly jpeg: Uint8Array }> {
  const { image } = await rasterImage(width, height, () => (
    {
      r: Math.floor(Math.random() * 256),
      g: Math.floor(Math.random() * 256),
      b: Math.floor(Math.random() * 256),
      a: transparent ? (Math.random() < 0.02 ? 180 : 255) : 255
    }
  ));
  return { png: image.get_bytes(), jpeg: image.get_bytes_jpeg(95) };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)])), 8 + data.length);
  return out;
}

/**
 * A PNG whose IHDR declares `width`x`height` while its deflated IDAT holds a
 * far smaller, uniform raster. A header-first check reads the lie from the
 * first 24 bytes; a decoder that trusted IHDR would allocate the full
 * raster before discovering the IDAT does not match it.
 */
export function decompressionBombPng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanline = Buffer.alloc(width * 4 + 1);
  const idat = deflateSync(Buffer.concat(Array.from({ length: Math.min(height, 4) }, () => scanline)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** A hand-built PNG whose IHDR declares zero-valued dimensions. */
export function zeroDimensionPng(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(0, 0);
  ihdr.writeUInt32BE(0, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc(0))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** Insert an APP1 EXIF segment carrying one Orientation tag, directly after
 *  the JPEG SOI marker, the same shape a camera or a photo editor writes. */
export function jpegWithOrientation(jpegBytes: Uint8Array, orientation: number): Uint8Array {
  const ifd = Buffer.alloc(2 + 12 + 4);
  ifd.writeUInt16BE(1, 0);
  ifd.writeUInt16BE(0x0112, 2);
  ifd.writeUInt16BE(3, 4);
  ifd.writeUInt32BE(1, 6);
  ifd.writeUInt16BE(orientation, 10);
  ifd.writeUInt32BE(0, 14);
  const tiff = Buffer.concat([Buffer.from("MM\0\x2a", "latin1"), Buffer.from([0, 0, 0, 8]), ifd]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2, 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
  const source = Buffer.from(jpegBytes);
  return Buffer.concat([source.subarray(0, 2), app1, source.subarray(2)]);
}

export function truncate(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.subarray(0, length);
}

/** Corrupt a run of bytes well inside the compressed payload, past any
 *  fixed header a bounded parser reads, so the corruption only surfaces
 *  once a decoder actually inflates the data. */
export function corruptPayload(bytes: Uint8Array, fromOffset: number, length: number): Uint8Array {
  const copy = Buffer.from(bytes);
  for (let index = fromOffset; index < Math.min(copy.length, fromOffset + length); index += 1) {
    copy[index] = (copy[index]! + 137) % 256;
  }
  return copy;
}
