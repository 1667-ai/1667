import { realpath } from "node:fs/promises";
import { loadBunFfi } from "./bun-ffi.js";

const CSIDL_LOCAL_APP_DATA = 0x001c;
const SHGFP_TYPE_CURRENT = 0;

export async function windowsLocalAppDataDirectory(): Promise<string> {
  const ffi = await loadBunFfi();
  const shell = ffi.dlopen("shell32.dll", {
    SHGetFolderPathW: {
      args: ["ptr", "i32", "ptr", "u32", "ptr"],
      returns: "i32"
    }
  });
  const storage = Buffer.alloc(32_768 * 2);
  try {
    const result = Number(shell.symbols.SHGetFolderPathW!(
      0,
      CSIDL_LOCAL_APP_DATA,
      0,
      SHGFP_TYPE_CURRENT,
      ffi.ptr(storage)
    ));
    if (result !== 0) {
      throw new Error(`Windows LocalAppData lookup failed (${result})`);
    }
    const observed = decodeWideString(storage);
    if (observed === "") {
      throw new Error("Windows returned an empty LocalAppData path");
    }
    return await realpath(observed);
  } finally {
    storage.fill(0);
    shell.close();
  }
}

function decodeWideString(value: Buffer): string {
  let end = 0;
  while (end + 1 < value.byteLength
    && (value[end] !== 0 || value[end + 1] !== 0)) {
    end += 2;
  }
  return value.subarray(0, end).toString("utf16le");
}
