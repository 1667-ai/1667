import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";

/** Atomically publish a directory only when the destination name is absent. */
export async function publishDirectoryNoReplace(
  source: string,
  target: string
): Promise<void> {
  if (process.versions.bun !== undefined) {
    await publishDirectoryNoReplaceNative(source, target);
    return;
  }
  await publishDirectoryNoReplaceThroughBun(source, target);
}

export async function publishDirectoryNoReplaceNative(
  source: string,
  target: string
): Promise<void> {
  const ffi = await loadBunFfi();
  if (process.platform === "win32") {
    const kernel = ffi.dlopen("kernel32.dll", {
      MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "i32" }
    });
    const from = Buffer.from(`${source}\0`, "utf16le");
    const to = Buffer.from(`${target}\0`, "utf16le");
    try {
      const moved = Number(kernel.symbols.MoveFileExW!(
        ffi.ptr(from),
        ffi.ptr(to),
        0
      ));
      if (moved !== 1) throw publicationFailed(target);
    } finally {
      from.fill(0);
      to.fill(0);
      kernel.close();
    }
    return;
  }

  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") {
    throw new Error(
      `Native no-replace directory publication is unsupported on ${process.platform}`
    );
  }
  const symbol = linux ? "renameat2" : "renameatx_np";
  const library = openPosixLibc(ffi, {
    [symbol]: {
      args: ["i32", "ptr", "i32", "ptr", "u32"],
      returns: "i32"
    }
  });
  const from = Buffer.from(`${source}\0`, "utf8");
  const to = Buffer.from(`${target}\0`, "utf8");
  try {
    const result = Number(library.symbols[symbol]!(
      -100,
      ffi.ptr(from),
      -100,
      ffi.ptr(to),
      linux ? 1 : 4
    ));
    if (result !== 0) throw publicationFailed(target);
  } finally {
    from.fill(0);
    to.fill(0);
    library.close();
  }
}

async function publishDirectoryNoReplaceThroughBun(
  source: string,
  target: string
): Promise<void> {
  const childScript = fileURLToPath(
    new URL("./directory-no-replace-child.ts", import.meta.url)
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "bun",
      [childScript, source, target],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length);
    });
    child.once("error", (error) => reject(new Error(
      "Bun is required for atomic no-replace directory publication",
      { cause: error }
    )));
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(
        stderr.trim()
          || `Atomic no-replace directory publication failed (${signal ?? code})`
      ));
    });
  });
}

function publicationFailed(target: string): Error {
  return new Error(
    `Atomic no-replace directory publication failed: ${target}`
  );
}
