import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";

const DARWIN_MNT_LOCAL = 0x00001000;

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
    const typeNameBytes = storage.subarray(72, 88);
    const terminator = typeNameBytes.indexOf(0);
    const typeName = new TextDecoder().decode(terminator === -1 ? typeNameBytes : typeNameBytes.subarray(0, terminator));
    const flags = view.getUint32(64, true);
    return {
      type: BigInt(view.getUint32(60, true)),
      typeName,
      local: (flags & DARWIN_MNT_LOCAL) !== 0
    };
  } finally {
    library.close();
  }
}
