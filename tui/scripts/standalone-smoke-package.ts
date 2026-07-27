import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rmdir,
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
  MACHINE_TIER_OVERRIDE_VARIABLE
} from "../../server/machine-tier.js";
import {
  createWindowsPrivateStateRootAdapter
} from "../../server/platform-state-root-windows.js";
import {
  parseReleasePackageManifest,
  validateReleaseTarballInspection,
  type ReleasePackageManifest
} from "../../scripts/release-package-policy.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson,
  RELEASE_LICENSE_FILES
} from "../../scripts/release-package-manifests.js";
import {
  createReleasePackageBuildManifest
} from "../../scripts/release-package-templates.js";
import {
  readReleaseTarball
} from "../../scripts/release-tar-reader.js";
import {
  normalizeWindowsNpmLauncherTarball
} from "../../scripts/windows-npm-launcher-tar.js";
import {
  removeSmokeTree,
  runStandalone
} from "./standalone-smoke-process.js";

const execFileAsync = promisify(execFile);
const tuiRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(tuiRoot);
const WINDOWS_TARGET = releaseTargetForArtifact("windows-x64");
const DEFAULT_STATE_SMOKE_VARIABLE =
  "AI_1667_WINDOWS_DEFAULT_STATE_SMOKE";

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
      createReleasePackageBuildManifest(
        identity,
        launcherManifest.name,
        "launcher"
      )
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
      createReleasePackageBuildManifest(
        identity,
        WINDOWS_TARGET.packageName,
        WINDOWS_TARGET.artifactTarget
      )
    ),
    writeJson(
      path.join(platformRoot, "sbom.spdx.json"),
      smokeSbom(identity, platformManifest.name)
    ),
    ...RELEASE_LICENSE_FILES.flatMap((name) => [
      copyFile(
        path.join(repositoryRoot, name),
        path.join(launcherRoot, name)
      ),
      copyFile(
        path.join(repositoryRoot, name),
        path.join(platformRoot, name)
      )
    ])
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
  const render = await runStandalone(
    "node",
    [
      installedLauncher,
      "--data",
      path.join(installRoot, "render-data"),
      "--render-once",
      "--size",
      "20x10"
    ],
    installRoot,
    environment
  );
  if (render.exitCode !== 0 || render.stderr !== "") {
    throw new Error(
      `Installed Windows npm worker smoke failed (${render.exitCode}): `
      + render.stderr.trim()
    );
  }
  if (process.env[DEFAULT_STATE_SMOKE_VARIABLE] === "1") {
    await smokeDefaultWindowsStateRoot(
      installedLauncher,
      installRoot,
      environment
    );
  }
  return createHash("sha256")
    .update(await readFile(installedExecutable))
    .digest("hex");
}

async function smokeDefaultWindowsStateRoot(
  installedLauncher: string,
  installRoot: string,
  environment: Record<string, string>
): Promise<void> {
  const adapter = await createWindowsPrivateStateRootAdapter();
  const localAppData = await adapter.localAppDataDirectory();
  const productRoot = path.join(localAppData, "1667");
  const stateRoot = path.join(productRoot, "State");
  const productExisted = await pathExists(productRoot);
  if (await pathExists(stateRoot)) {
    throw new Error(
      `Windows default state smoke requires an absent root: ${stateRoot}`
    );
  }
  const defaultEnvironment = { ...environment };
  delete defaultEnvironment[MACHINE_TIER_OVERRIDE_VARIABLE];
  let created = false;
  try {
    const render = await runStandalone(
      "node",
      [
        installedLauncher,
        "--data",
        path.join(installRoot, "default-state-data"),
        "--render-once",
        "--size",
        "20x10"
      ],
      installRoot,
      defaultEnvironment
    );
    if (render.exitCode !== 0 || render.stderr !== "") {
      throw new Error(
        `Windows default state smoke failed (${render.exitCode}): `
          + render.stderr.trim()
      );
    }
    const info = await lstat(stateRoot);
    const canonical = await realpath(stateRoot);
    if (!info.isDirectory()
      || info.isSymbolicLink()
      || canonical.toLowerCase() !== stateRoot.toLowerCase()) {
      throw new Error(
        "Windows package did not create its canonical default state root"
      );
    }
    created = true;
  } finally {
    if (created) {
      await removeSmokeTree(stateRoot);
      if (!productExisted) await rmdir(productRoot);
    }
  }
  console.log("windows-default-state-smoke ok");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error
      && "code" in error
      && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
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
  let bytes = await readFile(tarball);
  let parsed = await readReleaseTarball(bytes);
  let manifest = parseReleasePackageManifest(
    parsed.packageManifest,
    expected.version
  );
  if (manifest.name !== expected.name) {
    throw new Error(`npm pack returned the wrong archive for ${expected.name}`);
  }
  const launcher = parsed.inspection.entries.find(
    (entry) => entry.path === "package/bin/1667.js"
  );
  if (process.platform === "win32"
    && manifest.kind === "launcher"
    && launcher?.mode === 0o644) {
    validateReleaseTarballInspection({
      packageJsonSha256: parsed.inspection.packageJsonSha256,
      entries: parsed.inspection.entries.map((entry) =>
        entry === launcher ? { ...entry, mode: 0o755 } : entry)
    }, manifest);
    bytes = normalizeWindowsNpmLauncherTarball(bytes);
    await writeFile(tarball, bytes);
    parsed = await readReleaseTarball(bytes);
    manifest = parseReleasePackageManifest(
      parsed.packageManifest,
      expected.version
    );
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

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value));
}
