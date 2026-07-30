/** Shared physical POSIX ustar fixtures for release parser conformance tests. */
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export type UstarTypeFlag =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "x"
  | "g"
  | "L"
  | "K";

export interface UstarFixtureEntry {
  readonly name: string;
  readonly type: UstarTypeFlag;
  readonly mode?: number;
  readonly body?: Buffer;
  readonly linkname?: string;
  readonly devmajor?: number;
  readonly devminor?: number;
}

export interface UstarArchiveOptions {
  readonly terminatorBlocks?: number;
  readonly trailingBytes?: Buffer;
}

export async function writeUstarGzipArchive(
  archivePath: string,
  entries: readonly UstarFixtureEntry[],
  options?: UstarArchiveOptions
): Promise<void> {
  await writeFile(archivePath, gzipSync(ustarArchive(entries, options)));
}

export function ustarArchive(
  entries: readonly UstarFixtureEntry[],
  options: UstarArchiveOptions = {}
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = ustarHeader(entry, body.byteLength);
    chunks.push(header);
    if (entryHasBody(entry.type) && body.byteLength > 0) {
      chunks.push(body);
      const padding = (512 - (body.byteLength % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(512 * (options.terminatorBlocks ?? 2)));
  if (options.trailingBytes !== undefined) chunks.push(options.trailingBytes);
  return Buffer.concat(chunks);
}

export function ustarHeader(
  entry: UstarFixtureEntry,
  bodyByteLength = entry.body?.byteLength ?? 0
): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  writeUstarOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
  writeUstarOctal(header, 108, 8, 0);
  writeUstarOctal(header, 116, 8, 0);
  writeUstarOctal(header, 124, 12, entryHasBody(entry.type) ? bodyByteLength : 0);
  writeUstarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(entry.type, 156, 1, "ascii");
  if (entry.linkname !== undefined) {
    header.write(entry.linkname, 157, 100, "utf8");
  }
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (entry.devmajor !== undefined) writeUstarOctal(header, 329, 8, entry.devmajor);
  if (entry.devminor !== undefined) writeUstarOctal(header, 337, 8, entry.devminor);
  writeUstarChecksum(header);
  return header;
}

export function writeUstarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

export function writeUstarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  target.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  );
}

function entryHasBody(type: UstarTypeFlag): boolean {
  return type === "0" || type === "x" || type === "g" || type === "L" || type === "K";
}
