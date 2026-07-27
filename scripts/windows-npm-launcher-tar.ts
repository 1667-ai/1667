import { gzipSync, gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const MODE_OFFSET = 100;
const MODE_BYTES = 8;
const SIZE_OFFSET = 124;
const SIZE_BYTES = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_BYTES = 8;
const PREFIX_OFFSET = 345;
const PREFIX_BYTES = 155;
const NAME_BYTES = 100;
const LAUNCHER_PATH = "package/bin/1667.js";

/**
 * Repair the launcher mode that npm omits when it packs on Windows.
 *
 * The caller must validate the archive structure before it calls this function.
 */
export function normalizeWindowsNpmLauncherTarball(
  input: Uint8Array
): Buffer {
  const archive = gunzipSync(input);
  let offset = 0;
  let normalized = 0;
  while (offset + TAR_BLOCK_BYTES <= archive.byteLength) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    const path = headerPath(header);
    const size = octalField(header, SIZE_OFFSET, SIZE_BYTES);
    if (path === LAUNCHER_PATH) {
      const mode = octalField(header, MODE_OFFSET, MODE_BYTES);
      if (mode !== 0o644) {
        throw new Error(
          `Windows npm launcher mode cannot be normalized from ${mode.toString(8)}`
        );
      }
      writeOctalField(header, MODE_OFFSET, MODE_BYTES, 0o755);
      writeChecksum(header);
      normalized += 1;
    }
    offset += TAR_BLOCK_BYTES
      + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  if (normalized !== 1) {
    throw new Error("Windows npm archive has no unique launcher entry");
  }
  return gzipSync(archive, { level: 9 });
}

function headerPath(header: Uint8Array): string {
  const name = textField(header, 0, NAME_BYTES);
  const prefix = textField(header, PREFIX_OFFSET, PREFIX_BYTES);
  return prefix === "" ? name : `${prefix}/${name}`;
}

function textField(
  bytes: Uint8Array,
  start: number,
  length: number
): string {
  const field = bytes.subarray(start, start + length);
  const zero = field.indexOf(0);
  return Buffer.from(
    zero === -1 ? field : field.subarray(0, zero)
  ).toString("utf8");
}

function octalField(
  bytes: Uint8Array,
  start: number,
  length: number
): number {
  const text = Buffer.from(bytes.subarray(start, start + length))
    .toString("ascii")
    .replace(/\0.*$/u, "")
    .trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw new Error("Windows npm archive has a non-octal tar field");
  }
  return Number.parseInt(text, 8);
}

function writeOctalField(
  bytes: Uint8Array,
  start: number,
  length: number,
  value: number
): void {
  const text = `${value.toString(8).padStart(length - 1, "0")}\0`;
  bytes.set(Buffer.from(text, "ascii"), start);
}

function writeChecksum(header: Uint8Array): void {
  header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_BYTES);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const field = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.set(Buffer.from(field, "ascii"), CHECKSUM_OFFSET);
}
