import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import { INSTALL_LOCK_FILE } from "../shared/install-layout.js";
import {
  renderPowerShellInstallScript,
  type ReleaseArchiveDigest
} from "../scripts/release-install-script.js";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import {
  INSTALL_REPO,
  canonicalReleaseArchiveEntries,
  execFileAsync
} from "./release-install-script-fixture.js";
import { ustarArchive } from "./ustar-fixture.js";

const WINDOWS_TARGET = "windows-x64" as const;
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("PowerShell Installer handles install, repeat, and upgrade cases", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("Test requires Windows x64");
    return;
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "1667-powershell-install-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const assets = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    const asset = assets.get(request.url ?? "");
    if (asset === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-length": asset.byteLength });
    response.end(asset);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  const base = `http://127.0.0.1:${address.port}`;

  const v1 = await addRelease(assets, scratch, base, "1.2.3", "v1");
  const v2 = await addRelease(assets, scratch, base, "1.2.4", "v2");
  const installRoot = path.join(scratch, "managed");

  const fresh = await runInstaller(v1.url, installRoot);
  assert.match(fresh.stdout, /Installed 1667 1\.2\.3 \(stable\)/u);
  assert.equal(await installedVersion(installRoot), "1.2.3");
  const firstRecord = await ownershipRecord(installRoot);
  assert.equal(firstRecord.method, "powershell");
  assert.equal(firstRecord.artifactTarget, WINDOWS_TARGET);

  const repeat = await runInstaller(v1.url, installRoot);
  assert.match(repeat.stdout, /Installed 1667 1\.2\.3 \(stable\)/u);
  assert.equal(await installedVersion(installRoot), "1.2.3");
  assert.equal((await ownershipRecord(installRoot)).installationId, firstRecord.installationId);

  const active = path.join(installRoot, "1667.exe");
  const held = spawn(active, ["--hold"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (held.exitCode === null) held.kill();
  });
  await once(held.stdout!, "data");
  await assert.rejects(runInstaller(v2.url, installRoot), (error: unknown) => {
    return /Close all running 1667 processes.*run this installer again/isu.test(errorText(error));
  });
  assert.equal(await installedVersion(installRoot), "1.2.3");
  assert.deepEqual(await ownershipRecord(installRoot), firstRecord);
  const heldExit = once(held, "exit");
  held.kill();
  await heldExit;

  const upgraded = await runInstaller(v2.url, installRoot);
  assert.match(upgraded.stdout, /Installed 1667 1\.2\.4 \(stable\)/u);
  assert.equal(await installedVersion(installRoot), "1.2.4");
  assert.equal((await ownershipRecord(installRoot)).installationId, firstRecord.installationId);

  const unmanagedRoot = path.join(scratch, "unmanaged");
  await mkdir(unmanagedRoot);
  await writeFile(path.join(unmanagedRoot, "1667.exe"), "unmanaged\n");
  await assert.rejects(runInstaller(v2.url, unmanagedRoot), (error: unknown) => {
    return /Refusing to replace an unmanaged executable/iu.test(errorText(error));
  });
  assert.equal(await readFile(path.join(unmanagedRoot, "1667.exe"), "utf8"), "unmanaged\n");

  const badDigest = addInstaller(
    assets,
    `${base}/bad-digest`,
    "1.2.4",
    v2.archive,
    "0".repeat(64)
  );
  assets.set(`/bad-digest/${v2.archiveName}`, v2.archive);
  const retryRoot = path.join(scratch, "bad-digest");
  await assert.rejects(runInstaller(badDigest, retryRoot), (error: unknown) => {
    return /SHA-256 digest did not match/iu.test(errorText(error));
  });

  // The failed attempt above took the Install Root lock, and closing the handle
  // does not remove the lock file. A root holding only what the Installer itself
  // left behind is still fresh, so the next attempt must install rather than
  // refuse the root forever.
  assert.ok(
    (await readdir(retryRoot)).includes(INSTALL_LOCK_FILE),
    "the failed attempt leaves its lock file in the Install Root"
  );
  const retried = await runInstaller(v1.url, retryRoot);
  assert.match(retried.stdout, /Installed 1667 1\.2\.3 \(stable\)/u);
  assert.equal(await installedVersion(retryRoot), "1.2.3");

  const foreignRoot = path.join(scratch, "foreign");
  await mkdir(foreignRoot);
  await writeFile(path.join(foreignRoot, "notes.txt"), "not ours\n");
  await assert.rejects(runInstaller(v1.url, foreignRoot), (error: unknown) => {
    return /Fresh Install Root is not empty/iu.test(errorText(error));
  });

  const wrongIdentityExe = await compileFixture(
    scratch,
    "1.2.5",
    "wrong-identity",
    "other-product"
  );
  const wrongIdentityArchive = releaseArchive("1.2.5", wrongIdentityExe);
  const wrongIdentity = addInstaller(
    assets,
    `${base}/wrong-identity`,
    "1.2.5",
    wrongIdentityArchive,
    sha256(wrongIdentityArchive)
  );
  await assert.rejects(
    runInstaller(wrongIdentity, path.join(scratch, "wrong-identity-root")),
    (error: unknown) => /Candidate identity does not match/iu.test(errorText(error))
  );
});

async function addRelease(
  assets: Map<string, Buffer>,
  scratch: string,
  base: string,
  version: string,
  route: string
): Promise<{ readonly url: string; readonly archive: Buffer; readonly archiveName: string }> {
  const executable = await compileFixture(scratch, version, route);
  const archive = releaseArchive(version, executable);
  const routeBase = `${base}/${route}`;
  const url = addInstaller(assets, routeBase, version, archive, sha256(archive));
  return { url, archive, archiveName: releaseArchiveFileName(version, WINDOWS_TARGET) };
}

function addInstaller(
  assets: Map<string, Buffer>,
  routeBase: string,
  version: string,
  archive: Buffer,
  digest: string
): string {
  const route = new URL(routeBase).pathname.replace(/\/$/u, "");
  const archiveName = releaseArchiveFileName(version, WINDOWS_TARGET);
  const archives: ReleaseArchiveDigest[] = PUBLISHED_ARTIFACT_TARGETS.map((target) => ({
    target,
    fileName: releaseArchiveFileName(version, target),
    sha256: target === WINDOWS_TARGET
      ? digest
      : createHash("sha256").update(`${version}:${target}`).digest("hex")
  }));
  const body = renderPowerShellInstallScript({
    version,
    channel: "stable",
    repository: INSTALL_REPO,
    archives,
    assetBaseUrl: routeBase
  });
  assets.set(`${route}/install.ps1`, Buffer.from(body));
  assets.set(`${route}/${archiveName}`, archive);
  return `${routeBase}/install.ps1`;
}

function releaseArchive(version: string, executable: Buffer): Buffer {
  return gzipSync(ustarArchive(canonicalReleaseArchiveEntries(
    version,
    WINDOWS_TARGET,
    executable
  )));
}

async function compileFixture(
  scratch: string,
  version: string,
  name: string,
  product = "1667"
): Promise<Buffer> {
  const identity = JSON.stringify({
    schemaVersion: 1,
    product,
    productVersion: version,
    buildKind: "release",
    sourceCommit: SOURCE_COMMIT,
    sourceDirty: false,
    buildTimestamp: "2026-07-31T00:00:00.000Z",
    artifactTarget: WINDOWS_TARGET,
    apiProtocolVersion: 10,
    minClientProtocolVersion: 10,
    maxClientProtocolVersion: 10
  });
  const sourcePath = path.join(scratch, `${name}.cs`);
  const executablePath = path.join(scratch, `${name}.exe`);
  const compilerPath = path.join(scratch, "compile.ps1");
  await writeFile(sourcePath, `using System;
using System.Threading;
public static class Program {
  public static void Main(string[] args) {
    if (args.Length == 2 && args[0] == "--version" && args[1] == "--json") {
      Console.WriteLine(${JSON.stringify(identity)});
      return;
    }
    if (args.Length == 1 && args[0] == "--hold") {
      Console.WriteLine("holding");
      Thread.Sleep(60000);
      return;
    }
    Console.WriteLine("fixture");
  }
}
`);
  await writeFile(compilerPath, `param([string]$Source, [string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -Path $Source -OutputAssembly $Output -OutputType ConsoleApplication
`);
  await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    compilerPath,
    sourcePath,
    executablePath
  ]);
  return readFile(executablePath);
}

async function runInstaller(url: string, installRoot: string) {
  return execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `irm '${url}' | iex`
  ], {
    env: {
      ...process.env,
      AI_1667_INSTALL_ROOT: installRoot,
      AI_1667_SKIP_PATH_UPDATE: "1"
    },
    timeout: 15_000
  });
}

async function installedVersion(installRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(path.join(installRoot, "1667.exe"), [
    "--version",
    "--json"
  ]);
  return (JSON.parse(stdout) as { productVersion: string }).productVersion;
}

async function ownershipRecord(installRoot: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path.join(installRoot, ".1667-install.json"), "utf8")) as
    Record<string, string>;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  return [error.message, detail.stdout, detail.stderr]
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "")
    .join("\n");
}
