import { execFile } from "node:child_process";
import {
  access,
  realpath
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";

const execFileAsync = promisify(execFile);
const helperExtension = path.extname(fileURLToPath(import.meta.url));
const helperFile = fileURLToPath(new URL(
  `./platform-state-root-windows-helper${helperExtension}`,
  import.meta.url
));
let bunExecutable: Promise<string> | undefined;

export function createNodeWindowsPrivateStateRootAdapter(): WindowsPrivateStateRootAdapter {
  return {
    localAppDataDirectory: async () => {
      const observed = await runBunHelper(["local-app-data"]);
      return await realpath(observed);
    },
    preparePrivateStateRoot: async (root, trustedBase) => {
      return await runBunHelper([
        "prepare",
        root,
        ...(trustedBase === undefined ? [] : [trustedBase])
      ]);
    }
  };
}

async function runBunHelper(
  args: readonly string[]
): Promise<string> {
  const systemRoot = trustedSystemRoot(process.env);
  const executable = await resolveBunExecutable();
  const { stdout, stderr } = await execFileAsync(
    executable,
    [helperFile, ...args],
    {
      encoding: "utf8",
      env: windowsSystemEnvironment(process.env, systemRoot),
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      windowsHide: true
    }
  );
  const result = stdout.trim();
  if (result === "") {
    throw new Error(
      stderr.trim() || "Windows private state adapter returned no path"
    );
  }
  return result;
}

async function resolveBunExecutable(): Promise<string> {
  bunExecutable ??= findBunExecutable();
  return await bunExecutable;
}

async function findBunExecutable(): Promise<string> {
  const entries = (process.env.PATH ?? "").split(path.win32.delimiter);
  for (const entry of entries) {
    if (entry === "") continue;
    const candidate = path.win32.join(entry.replace(/^"|"$/gu, ""), "bun.exe");
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      // Try the next trusted runtime location.
    }
  }
  throw new Error(
    "Windows private state preparation needs Bun on PATH"
  );
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
  const inherited = Object.fromEntries(
    ["COMSPEC", "PATHEXT", "TEMP", "TMP"].flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ...inherited
  };
}
