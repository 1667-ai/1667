export interface FfiFunction {
  (...args: unknown[]): number | bigint;
}

export interface FfiLibrary {
  symbols: Record<string, FfiFunction>;
  close(): void;
}

export interface FfiSymbols {
  [name: string]: { args: string[]; returns: string };
}

export interface BunFfi {
  dlopen(path: string, symbols: FfiSymbols): FfiLibrary;
  ptr(buffer: Uint8Array): number;
  toArrayBuffer(pointer: number, byteOffset?: number, byteLength?: number): ArrayBuffer;
}

const ffiModuleName = "bun:ffi";

export async function loadBunFfi(): Promise<BunFfi> {
  return await import(ffiModuleName) as unknown as BunFfi;
}

/** Bun ships for both glibc and musl Linux. Try each runtime's conventional
 * libc/loader names instead of assuming the glibc-only libc.so.6 soname. */
export function openPosixLibc(ffi: BunFfi, symbols: FfiSymbols): FfiLibrary {
  const candidates = posixLibcCandidates(process.platform, process.arch);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return ffi.dlopen(candidate, symbols);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not load the platform C library (${candidates.join(", ")})`, { cause: lastError });
}

export function posixLibcCandidates(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (platform !== "linux") return [];
  const muslArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  return [
    "libc.so.6",
    `libc.musl-${muslArch}.so.1`,
    `/lib/ld-musl-${muslArch}.so.1`,
    `/usr/lib/ld-musl-${muslArch}.so.1`
  ];
}
