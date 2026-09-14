import {
  address,
  decode,
  load,
  type LibraryHandle
} from "koffi";
import type {
  FfiFunction,
  FfiLibrary,
  FfiSymbols,
  NativeFfi
} from "./bun-ffi.js";

/** Create the small FFI surface used by the native platform adapters. */
export function loadNodeFfi(): NativeFfi {
  return {
    dlopen: (path, symbols) => openLibrary(path, symbols),
    ptr: (buffer) => pointerValue(address(buffer)),
    toArrayBuffer: (pointer, byteOffset = 0, byteLength) => {
      if (byteLength === undefined) {
        throw new Error("Node FFI memory views require a byte length");
      }
      // Electron forbids external ArrayBuffers. Decode native bytes into
      // owned memory, which also stays valid after the native call releases it.
      return Uint8Array.from(
        decode(BigInt(pointer), byteOffset, "uint8_t", byteLength) as Uint8Array
      ).buffer;
    }
  };
}

function openLibrary(path: string, symbols: FfiSymbols): FfiLibrary {
  const library = load(path);
  try {
    const functions = Object.fromEntries(
      Object.entries(symbols).map(([name, declaration]) => [
        name,
        loadFunction(library, name, declaration.returns, declaration.args)
      ])
    ) as Record<string, FfiFunction>;
    return {
      symbols: functions,
      close: () => library.unload()
    };
  } catch (error) {
    library.unload();
    throw error;
  }
}

function loadFunction(
  library: LibraryHandle,
  name: string,
  result: string,
  args: readonly string[]
): FfiFunction {
  const nativeResult = koffiType(result);
  const nativeArgs = args.map(koffiType);
  const call = process.platform === "win32"
    ? library.func("__stdcall", name, nativeResult, nativeArgs)
    : library.func(name, nativeResult, nativeArgs);
  return call as FfiFunction;
}

function koffiType(type: string): string {
  switch (type) {
    case "i32": return "int32_t";
    case "u32": return "uint32_t";
    case "i64": return "int64_t";
    case "ptr": return "void *";
    default: return type;
  }
}

function pointerValue(value: bigint): number {
  const pointer = Number(value);
  if (!Number.isSafeInteger(pointer)) {
    throw new Error("Node FFI returned an unsafe pointer");
  }
  return pointer;
}
