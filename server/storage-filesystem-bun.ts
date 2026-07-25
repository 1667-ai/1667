import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";

const DARWIN_MNT_LOCAL = 0x00001000;
const DARWIN_LEGACY_FILESYSTEM_NAME_LENGTH = 15;
const DARWIN_MODERN_FILESYSTEM_NAME_LENGTH = 16;

export async function filesystemInfo(directory: string): Promise<{
  type: bigint;
  typeName?: string;
  local?: boolean;
}> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Filesystem verification is not implemented on ${process.platform}`);
  }
  const ffi = await loadBunFfi();
  const library = openPosixLibc(ffi, { statfs: { args: ["ptr", "ptr"], returns: "i32" } });
  const encoded = new TextEncoder().encode(`${directory}\0`);
  const storage = new Uint8Array(process.platform === "darwin" ? 2_240 : 256);
  try {
    if (library.symbols.statfs!(ffi.ptr(encoded), ffi.ptr(storage)) !== 0) {
      throw new Error(`Could not inspect the data-directory filesystem: ${directory}`);
    }
    const view = new DataView(storage.buffer, storage.byteOffset, storage.byteLength);
    if (process.platform === "linux") return { type: view.getBigInt64(0, true) };
    return decodeDarwinStatfs(storage, process.arch);
  } finally {
    library.close();
  }
}

export function decodeDarwinStatfs(
  storage: Uint8Array,
  architecture: string
): { type: bigint; typeName: string; local: boolean } {
  // Raw `statfs` uses Darwin's legacy symbol on Intel. Compiled callers receive
  // `statfs$INODE64`, but FFI symbol lookup does not apply that header alias.
  const legacy = architecture === "x64";
  if (!legacy && architecture !== "arm64") {
    throw new Error(`Darwin statfs decoding is not implemented on ${architecture}`);
  }
  const typeOffset = legacy ? 78 : 60;
  const flagsOffset = legacy ? 80 : 64;
  const typeNameOffset = legacy ? 104 : 72;
  const view = new DataView(storage.buffer, storage.byteOffset, storage.byteLength);
  const typeNameBytes = storage.subarray(
    typeNameOffset,
    typeNameOffset + (legacy
      ? DARWIN_LEGACY_FILESYSTEM_NAME_LENGTH
      : DARWIN_MODERN_FILESYSTEM_NAME_LENGTH)
  );
  const terminator = typeNameBytes.indexOf(0);
  const typeName = new TextDecoder().decode(
    terminator === -1 ? typeNameBytes : typeNameBytes.subarray(0, terminator)
  );
  const flags = legacy
    ? view.getBigUint64(flagsOffset, true)
    : BigInt(view.getUint32(flagsOffset, true));
  return {
    type: BigInt(legacy
      ? view.getUint16(typeOffset, true)
      : view.getUint32(typeOffset, true)),
    typeName,
    local: (flags & BigInt(DARWIN_MNT_LOCAL)) !== 0n
  };
}
