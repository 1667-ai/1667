import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  realpath,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseBuildIdentity,
  sameBuildIdentity,
  type BuildIdentity
} from "../../shared/build-identity.js";
import {
  releaseTargetForArtifact
} from "../../shared/release-targets.js";
import {
  parseReleasePackageManifest,
  validateReleaseTarballInspection,
  type ReleasePackageManifest
} from "../../scripts/release-package-policy.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson
} from "../../scripts/release-package-manifests.js";
import {
  readReleaseTarball
} from "../../scripts/release-tar-reader.js";
import { runStandalone } from "./standalone-smoke-process.js";

const execFileAsync = promisify(execFile);
const tuiRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(tuiRoot);
const WINDOWS_TARGET = releaseTargetForArtifact("windows-x64");

/** Stage the exact Windows package layout and execute it through the launcher. */
export async function smokeWindowsNpmPackage(
  executable: string,
  identity: BuildIdentity,
  directory: string,
  environment: Record<string, string>
): Promise<string> {
  if (process.platform !== WINDOWS_TARGET.platform
    || identity.artifactTarget !== WINDOWS_TARGET.artifactTarget) {
    throw new Error("Windows npm package smoke requires a windows-x64 candidate");
  }
  const sourceRoot = path.join(directory, "npm-source");
  const launcherRoot = path.join(sourceRoot, "1667");
  const platformRoot = path.join(
    sourceRoot,
    WINDOWS_TARGET.packageName
  );
  const launcher = path.join(launcherRoot, "bin", "1667.js");
  const stagedExecutable = path.join(platformRoot, WINDOWS_TARGET.executable);
  const launcherManifest = createReleaseLauncherManifest(
    identity.productVersion
  );
  const platformManifest = createReleasePlatformManifest(
    WINDOWS_TARGET.artifactTarget,
    identity.productVersion
  );
  await Promise.all([
    mkdir(path.dirname(launcher), { recursive: true }),
    mkdir(path.dirname(stagedExecutable), { recursive: true })
  ]);
  await Promise.all([
    copyFile(path.join(repositoryRoot, "release", "npm", "launcher.mjs"), launcher),
    copyFile(executable, stagedExecutable),
    writeJson(
      path.join(launcherRoot, "package.json"),
      releasePackageJson(launcherManifest)
    ),
    writeJson(
      path.join(launcherRoot, "build-manifest.json"),
      buildManifest(identity, "1667", "launcher")
    ),
    writeJson(
      path.join(launcherRoot, "sbom.spdx.json"),
      smokeSbom(identity, launcherManifest.name)
    ),
    writeJson(
      path.join(platformRoot, "package.json"),
      releasePackageJson(platformManifest)
    ),
    writeJson(
      path.join(platformRoot, "build-manifest.json"),
      buildManifest(
        identity,
        WINDOWS_TARGET.packageName,
        WINDOWS_TARGET.artifactTarget
      )
    ),
    writeJson(
      path.join(platformRoot, "sbom.spdx.json"),
      smokeSbom(identity, platformManifest.name)
    )
  ]);

  const packRoot = path.join(directory, "npm-pack");
  const npm = await resolveNpmInvocation();
  const [launcherTarball, platformTarball] = await Promise.all([
    packAndValidate(launcherRoot, packRoot, launcherManifest, npm),
    packAndValidate(platformRoot, packRoot, platformManifest, npm)
  ]);
  const installRoot = path.join(directory, "npm-install");
  await mkdir(installRoot);
  await writeJson(path.join(installRoot, "package.json"), {
    name: "1667-windows-package-smoke",
    private: true,
    version: identity.productVersion
  });
  await runNpm(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--package-lock=false",
    launcherTarball,
    platformTarball
  ], installRoot);
  const installedLauncher = path.join(
    installRoot,
    "node_modules",
    launcherManifest.name,
    "bin",
    "1667.js"
  );
  const installedExecutable = path.join(
    installRoot,
    "node_modules",
    platformManifest.name,
    WINDOWS_TARGET.executable
  );
  const launched = await runStandalone(
    "node",
    [installedLauncher, "--version", "--json"],
    installRoot,
    environment
  );
  if (launched.exitCode !== 0 || launched.stderr !== "") {
    throw new Error(
      `Windows npm launcher smoke failed (${launched.exitCode}): `
        + launched.stderr.trim()
    );
  }
  const observed = parseBuildIdentity(JSON.parse(launched.stdout));
  if (!sameBuildIdentity(observed, identity)) {
    throw new Error("Windows npm launcher did not execute the staged candidate");
  }
  return createHash("sha256")
    .update(await readFile(installedExecutable))
    .digest("hex");
}

interface NpmInvocation {
  readonly executable: string;
  readonly cli: string;
}

async function packAndValidate(
  packageRoot: string,
  packRoot: string,
  expected: ReleasePackageManifest,
  npm: NpmInvocation
): Promise<string> {
  await mkdir(packRoot, { recursive: true });
  const stdout = await runNpm(npm, [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packRoot
  ], packageRoot);
  const packed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(packed)
    || packed.length !== 1
    || packed[0] === null
    || typeof packed[0] !== "object"
    || typeof (packed[0] as { filename?: unknown }).filename !== "string") {
    throw new Error(`npm pack returned no archive for ${expected.name}`);
  }
  const filename = (packed[0] as { filename: string }).filename;
  if (path.basename(filename) !== filename) {
    throw new Error(`npm pack returned an unsafe filename for ${expected.name}`);
  }
  const tarball = path.join(packRoot, filename);
  const parsed = await readReleaseTarball(await readFile(tarball));
  const manifest = parseReleasePackageManifest(
    parsed.packageManifest,
    expected.version
  );
  if (manifest.name !== expected.name) {
    throw new Error(`npm pack returned the wrong archive for ${expected.name}`);
  }
  validateReleaseTarballInspection(parsed.inspection, manifest);
  return tarball;
}

async function resolveNpmInvocation(): Promise<NpmInvocation> {
  const environmentCli = process.env.npm_execpath;
  if (environmentCli !== undefined && environmentCli.endsWith(".js")) {
    await access(environmentCli);
    return {
      executable: process.env.npm_node_execpath ?? await resolveNodeExecutable(),
      cli: environmentCli
    };
  }
  const executable = await resolveNodeExecutable();
  const cli = process.platform === "win32"
    ? path.join(
        path.dirname(executable),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js"
      )
    : await realpath((await execFileAsync("which", ["npm"], {
        encoding: "utf8"
      })).stdout.trim());
  await access(cli);
  return { executable, cli };
}

async function resolveNodeExecutable(): Promise<string> {
  const configured = process.env.npm_node_execpath;
  if (configured !== undefined) {
    await access(configured);
    return configured;
  }
  const command = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await execFileAsync(command, ["node"], {
    encoding: "utf8"
  });
  const executable = stdout.split(/\r?\n/u).find((line) => line.trim() !== "");
  if (executable === undefined) throw new Error("Node executable is unavailable");
  await access(executable);
  return executable;
}

async function runNpm(
  invocation: NpmInvocation,
  args: readonly string[],
  cwd: string
): Promise<string> {
  const { stdout } = await execFileAsync(
    invocation.executable,
    [invocation.cli, ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );
  return stdout;
}

function smokeSbom(
  identity: BuildIdentity,
  packageName: string
): Record<string, unknown> {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${packageName}-${identity.productVersion}`,
    documentNamespace: `https://1667.ai/sbom/${packageName}/${identity.sourceCommit}`,
    creationInfo: {
      created: identity.buildTimestamp,
      creators: ["Tool: 1667 standalone package smoke"]
    }
  };
}

function buildManifest(
  identity: BuildIdentity,
  packageName: string,
  artifactTarget: "launcher" | "windows-x64"
) {
  return {
    schemaVersion: 1,
    product: "1667",
    productVersion: identity.productVersion,
    sourceCommit: identity.sourceCommit,
    buildTimestamp: identity.buildTimestamp,
    packageName,
    artifactTarget
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value));
}
