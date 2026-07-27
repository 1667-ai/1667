import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBuildIdentity,
  sameBuildIdentity,
  type BuildIdentity
} from "../../shared/build-identity.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson
} from "../../scripts/release-package-manifests.js";
import { runStandalone } from "./standalone-smoke-process.js";

const tuiRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(tuiRoot);
const PACKAGE_NAME = "1667-windows-x64";

/** Stage the exact Windows package layout and execute it through the launcher. */
export async function smokeWindowsNpmPackage(
  executable: string,
  identity: BuildIdentity,
  directory: string,
  environment: Record<string, string>
): Promise<string> {
  if (process.platform !== "win32" || identity.artifactTarget !== "windows-x64") {
    throw new Error("Windows npm package smoke requires a windows-x64 candidate");
  }
  const launcherRoot = path.join(directory, "npm-stage", "1667");
  const platformRoot = path.join(
    launcherRoot,
    "node_modules",
    PACKAGE_NAME
  );
  const launcher = path.join(launcherRoot, "bin", "1667.js");
  const stagedExecutable = path.join(platformRoot, "bin", "1667.exe");
  await Promise.all([
    mkdir(path.dirname(launcher), { recursive: true }),
    mkdir(path.dirname(stagedExecutable), { recursive: true })
  ]);
  await Promise.all([
    copyFile(path.join(repositoryRoot, "release", "npm", "launcher.mjs"), launcher),
    copyFile(executable, stagedExecutable),
    writeJson(
      path.join(launcherRoot, "package.json"),
      releasePackageJson(
        createReleaseLauncherManifest(identity.productVersion)
      )
    ),
    writeJson(
      path.join(launcherRoot, "build-manifest.json"),
      buildManifest(identity, "1667", "launcher")
    ),
    writeJson(
      path.join(platformRoot, "package.json"),
      releasePackageJson(
        createReleasePlatformManifest(
          "windows-x64",
          identity.productVersion
        )
      )
    ),
    writeJson(
      path.join(platformRoot, "build-manifest.json"),
      buildManifest(identity, PACKAGE_NAME, "windows-x64")
    )
  ]);

  const launched = await runStandalone(
    "node",
    [launcher, "--version", "--json"],
    launcherRoot,
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
    .update(await readFile(stagedExecutable))
    .digest("hex");
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
