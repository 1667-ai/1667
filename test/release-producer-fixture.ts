import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

export function tarModificationTimes(gzip: Buffer): Readonly<Record<string, number>> {
  const tar = gunzipSync(gzip);
  const mtimes: Record<string, number> = {};
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const entryPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    mtimes[entryPath] = tarOctal(header, 136, 12);
    const size = tarOctal(header, 124, 12);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(Object.keys(mtimes).length > 0, "packed tarball has no header times");
  return mtimes;
}

export async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file), { code: "ENOENT" });
}

function tarText(bytes: Buffer, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarOctal(bytes: Buffer, offset: number, length: number): number {
  const text = tarText(bytes, offset, length).trim();
  assert.match(text, /^[0-7]+$/u);
  return Number.parseInt(text, 8);
}
