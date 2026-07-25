import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FilesystemInfo } from "./storage-filesystem.js";
import { loadBunFfi } from "./bun-ffi.js";

const execFileAsync = promisify(execFile);

/** Native packaged probe; backend storage checks never create descendants. */
export async function filesystemInfo(directory: string): Promise<FilesystemInfo> {
  if (process.platform !== "win32") {
    throw new Error("Windows filesystem verification requires Windows");
  }
  const root = windowsDriveRoot(directory);
  if (process.versions.bun === undefined) {
    return await nodeWindowsFilesystemInfo(root);
  }
  const ffi = await loadBunFfi();
  const kernel = ffi.dlopen("kernel32.dll", {
    GetDriveTypeW: { args: ["ptr"], returns: "u32" }
  });
  const encoded = Buffer.from(`${root}\0`, "utf16le");
  try {
    const driveType = Number(kernel.symbols.GetDriveTypeW!(ffi.ptr(encoded)));
    if (!Number.isSafeInteger(driveType)) {
      throw new Error("Windows returned an invalid drive type");
    }
    return { type: BigInt(driveType) };
  } finally {
    encoded.fill(0);
    kernel.close();
  }
}

/** Source/test fallback; packaged builds always use the direct Win32 probe. */
async function nodeWindowsFilesystemInfo(root: string): Promise<FilesystemInfo> {
  const device = root.slice(0, 2).toUpperCase();
  const systemRoot = trustedSystemRoot(process.env);
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${device}'").DriveType`;
  const { stdout } = await execFileAsync(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 10_000,
      env: windowsSystemEnvironment(process.env, systemRoot)
    }
  );
  const type = Number(stdout.trim());
  if (!Number.isSafeInteger(type)) {
    throw new Error("Windows returned an invalid drive type");
  }
  return { type: BigInt(type) };
}

function trustedSystemRoot(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot;
  const windir = environment.WINDIR;
  if (systemRoot === undefined
    || windir === undefined
    || systemRoot.toLowerCase() !== windir.toLowerCase()
    || !path.win32.isAbsolute(systemRoot)
    || path.win32.normalize(systemRoot) !== systemRoot
    || path.win32.parse(systemRoot).root === systemRoot) {
    throw new Error("Windows SystemRoot is unavailable or ambiguous");
  }
  return systemRoot;
}

function windowsSystemEnvironment(
  source: NodeJS.ProcessEnv,
  systemRoot: string
): NodeJS.ProcessEnv {
  const names = ["COMSPEC", "PATHEXT", "TEMP", "TMP"];
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ...Object.fromEntries(names.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }))
  };
}

export function windowsDriveRoot(directory: string): string {
  if (!path.win32.isAbsolute(directory) || directory.startsWith("\\\\")) {
    throw new Error("The data directory has no local Windows drive root");
  }
  const root = path.win32.parse(directory).root;
  if (!/^[A-Za-z]:\\$/.test(root)) {
    throw new Error("The data directory has no Windows drive root");
  }
  return root;
}
