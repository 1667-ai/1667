import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  releaseIdentityJson,
  stubExecutableSource
} from "./managed-package-fixture.js";

const TARGET = "windows-x64" as const;

export function windowsTestExecutable(
  scratch: string,
  version: string,
  name = "candidate"
): Buffer | string {
  if (process.platform !== "win32") return stubExecutableSource(version, TARGET);

  const sourcePath = path.join(scratch, `${name}.cs`);
  const outputPath = path.join(scratch, `${name}.exe`);
  const compilerPath = path.join(scratch, `${name}-compile.ps1`);
  const identity = releaseIdentityJson(version, TARGET);
  writeFileSync(sourcePath, `using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class Program {
  public static void Main(string[] args) {
    if (args.Length == 2 && args[0] == "--version" && args[1] == "--json") {
      Console.WriteLine(${JSON.stringify(identity)});
      return;
    }
    if (args.Length == 1 && args[0] == "--hold") {
      using (File.Open(Assembly.GetExecutingAssembly().Location, FileMode.Open,
          FileAccess.Read, FileShare.Read)) {
        Console.WriteLine("holding");
        Thread.Sleep(60000);
      }
      return;
    }
    if (args.Length == 2 && args[0] == "--hold-file") {
      using (File.Open(args[1], FileMode.Open, FileAccess.Read, FileShare.Read)) {
        Console.WriteLine("holding");
        Thread.Sleep(60000);
      }
      return;
    }
    if (args.Length == 2 && args[0] == "--wait-hold-file") {
      DateTime deadline = DateTime.UtcNow.AddSeconds(15);
      while (true) {
        if (DateTime.UtcNow >= deadline) Environment.Exit(2);
        if (!File.Exists(args[1])) {
          Thread.Sleep(10);
          continue;
        }
        try {
          using (File.Open(args[1], FileMode.Open, FileAccess.ReadWrite, FileShare.Read)) {
            Console.WriteLine("holding");
            Thread.Sleep(60000);
          }
          return;
        } catch (IOException) {
          Thread.Sleep(10);
        }
      }
    }
    Environment.Exit(1);
  }
}
`);
  writeFileSync(compilerPath, `param([string]$Source, [string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -Path $Source -OutputAssembly $Output -OutputType ConsoleApplication
`);
  execFileSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    compilerPath,
    sourcePath,
    outputPath
  ]);
  chmodSync(outputPath, 0o755);
  return readFileSync(outputPath);
}

export async function removeWindowsHandoffScratch(scratch: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      rmSync(scratch, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!new Set(["EBUSY", "ENOTEMPTY", "EPERM"]).has(code) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}
