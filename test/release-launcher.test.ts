import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  LAUNCHER_PACKAGE_NAME,
  LAUNCHER_RELEASE_TARGETS,
  resolveLaunchPlan,
  runLauncher,
  selectTarget
} from "../release/npm/launcher.mjs";
import {
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_TARGETS,
  type PackagedArtifactTarget,
  type ReleaseTargetDescriptor,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import {
  createReleasePlatformManifest,
  releasePackageJson
} from "../scripts/release-package-manifests.js";

const VERSION = "3.0.0";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-23T10:20:30.000Z";
const PLATFORM_PACKAGE = releaseTargetForArtifact("linux-x64").packageName;
const execFileAsync = promisify(execFile);

test("standalone launcher target table exactly matches canonical release policy", () => {
  assert.equal(LAUNCHER_PACKAGE_NAME, RELEASE_LAUNCHER_PACKAGE);
  assert.deepEqual(
    launcherReleasePolicy(),
    canonicalLauncherReleasePolicy()
  );
  for (const descriptor of RELEASE_TARGETS) {
    assert.equal(
      selectTarget(descriptor.platform, descriptor.arch),
      descriptor.artifactTarget
    );
  }
});

test("script-free launcher resolves the exact local platform package with no fallback", async (t) => {
  const { base, root } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const plan = resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64",
    args: ["--version", "--json"]
  });
  assert.equal(plan.target, "linux-x64");
  assert.equal(plan.packageName, PLATFORM_PACKAGE);
  assert.equal(plan.productVersion, VERSION);
  assert.equal(plan.sourceCommit, COMMIT);
  assert.equal(plan.launcherRoot, root);
  assert.equal(
    plan.platformRoot,
    path.join(root, "node_modules", PLATFORM_PACKAGE)
  );
  assert.deepEqual(plan.args, ["--version", "--json"]);
  assert.equal(plan.executable, path.join(
    root,
    "node_modules",
    PLATFORM_PACKAGE,
    "bin",
    "1667"
  ));
  await rm(path.join(root, "node_modules", PLATFORM_PACKAGE), {
    recursive: true,
    force: true
  });
  assert.throws(
    () => resolveLaunchPlan({
      launcherRoot: root,
      platform: "linux",
      arch: "x64"
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes(`Missing ${PLATFORM_PACKAGE}`)
  );
});

test("launcher fails closed on package/build identity skew and unsupported targets", async (t) => {
  const { base, root } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const buildPath = path.join(
    root,
    "node_modules",
    PLATFORM_PACKAGE,
    "build-manifest.json"
  );
  const build = JSON.parse(await readFile(buildPath, "utf8")) as Record<string, unknown>;
  await writeFile(buildPath, JSON.stringify({ ...build, sourceCommit: "f".repeat(40) }));
  assert.throws(() => resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  }), /identities disagree/);
  assert.throws(() => selectTarget("win32", "arm64"), /Unsupported/);
});

test("launcher rejects missing or incorrect Linux libc metadata", async (t) => {
  const { base, root, platformRoot } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const packagePath = path.join(platformRoot, "package.json");
  const platformPackage = JSON.parse(
    await readFile(packagePath, "utf8")
  ) as Record<string, unknown>;

  const { libc: _libc, ...withoutLibc } = platformPackage;
  await writeFile(packagePath, JSON.stringify(withoutLibc));
  assert.throws(() => resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  }), /declares the wrong target/);

  await writeFile(packagePath, JSON.stringify({
    ...platformPackage,
    libc: ["musl"]
  }));
  assert.throws(() => resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  }), /declares the wrong target/);
});

test("launcher rejects libc metadata on a Darwin package", async (t) => {
  const { base, root, platformRoot } = await launcherFixture("darwin-arm64");
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.doesNotThrow(() => resolveLaunchPlan({
    launcherRoot: root,
    platform: "darwin",
    arch: "arm64"
  }));

  const packagePath = path.join(platformRoot, "package.json");
  const platformPackage = JSON.parse(
    await readFile(packagePath, "utf8")
  ) as Record<string, unknown>;
  await writeFile(packagePath, JSON.stringify({
    ...platformPackage,
    libc: ["glibc"]
  }));
  assert.throws(() => resolveLaunchPlan({
    launcherRoot: root,
    platform: "darwin",
    arch: "arm64"
  }), /declares the wrong target/);
});

test("scoped launcher resolves and starts from the hoisted npm layout", async (t) => {
  const { base, root, platformRoot } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const packageName = PLATFORM_PACKAGE;
  const nested = path.join(root, "node_modules", packageName);
  const ambientRoot = path.join(base, "ambient");
  const ambient = path.join(ambientRoot, packageName);
  await mkdir(path.dirname(ambient), { recursive: true });
  await rename(nested, ambient);

  const launcherUrl = pathToFileURL(path.resolve("release/npm/launcher.mjs")).href;
  const source = [
    `import assert from "node:assert/strict";`,
    `import { resolveLaunchPlan } from ${JSON.stringify(launcherUrl)};`,
    `assert.throws(() => resolveLaunchPlan({ launcherRoot: ${JSON.stringify(root)},`,
    `  platform: "linux", arch: "x64" }), /Missing/);`
  ].join("\n");
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, NODE_PATH: ambientRoot }
  });

  const hoisted = path.join(base, "node_modules", packageName);
  assert.notEqual(hoisted, platformRoot);
  await mkdir(path.dirname(hoisted), { recursive: true });
  await rename(ambient, hoisted);
  assert.equal(resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  }).platformRoot, hoisted);
  const child = runLauncher({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test("launcher preserves an independently signalled child's failure", async (t) => {
  const { base, root } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const executable = path.join(
    root,
    "node_modules",
    PLATFORM_PACKAGE,
    "bin",
    "1667"
  );
  await writeFile(executable, "#!/bin/sh\nkill -TERM $$\n");
  await chmod(executable, 0o755);

  const launcherUrl = pathToFileURL(path.resolve("release/npm/launcher.mjs")).href;
  const source = [
    `import { runLauncher } from ${JSON.stringify(launcherUrl)};`,
    `runLauncher({ launcherRoot: ${JSON.stringify(root)},`,
    `  platform: "linux", arch: "x64" });`
  ].join("\n");
  await assert.rejects(
    execFileAsync(process.execPath, ["--input-type=module", "--eval", source]),
    (error: unknown) => {
      return (error as { signal?: string }).signal === "SIGTERM";
    }
  );
});

async function launcherFixture(): Promise<{
  base: string;
  root: string;
  platformRoot: string;
}>;
async function launcherFixture(
  target: PackagedArtifactTarget
): Promise<{
  base: string;
  root: string;
  platformRoot: string;
}>;
async function launcherFixture(
  target: PackagedArtifactTarget = "linux-x64"
): Promise<{
  base: string;
  root: string;
  platformRoot: string;
}> {
  const temporaryBase = await mkdtemp(path.join(tmpdir(), "1667-launcher-test-"));
  const base = await realpath(temporaryBase);
  const platformManifest = releasePackageJson(
    createReleasePlatformManifest(target, VERSION)
  );
  const platformPackage = platformManifest.name;
  const root = path.join(base, "node_modules", RELEASE_LAUNCHER_PACKAGE);
  const platformRoot = path.join(root, "node_modules", platformPackage);
  await mkdir(path.join(platformRoot, "bin"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: RELEASE_LAUNCHER_PACKAGE,
    version: VERSION,
    optionalDependencies: { [platformPackage]: VERSION }
  }));
  await writeFile(
    path.join(root, "build-manifest.json"),
    JSON.stringify(buildManifest(RELEASE_LAUNCHER_PACKAGE, "launcher"))
  );
  await writeFile(
    path.join(platformRoot, "package.json"),
    JSON.stringify(platformManifest)
  );
  await writeFile(
    path.join(platformRoot, "build-manifest.json"),
    JSON.stringify(buildManifest(platformPackage, target))
  );
  const executable = path.join(platformRoot, "bin", "1667");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return { base, root, platformRoot };
}

function buildManifest(packageName: string, artifactTarget: string) {
  return {
    schemaVersion: 1,
    product: "1667",
    productVersion: VERSION,
    sourceCommit: COMMIT,
    buildTimestamp: TIMESTAMP,
    packageName,
    artifactTarget
  };
}

type LauncherReleaseTargetDescriptor = Readonly<
  Omit<ReleaseTargetDescriptor, "artifactTarget" | "platform" | "arch">
  & {
    readonly os: ReleaseTargetDescriptor["platform"];
    readonly cpu: ReleaseTargetDescriptor["arch"];
  }
>;
type ReleasePolicyByTarget = Readonly<Record<string, ReleaseTargetDescriptor>>;

function launcherReleasePolicy(): ReleasePolicyByTarget {
  const targets: Readonly<Record<string, LauncherReleaseTargetDescriptor>> =
    LAUNCHER_RELEASE_TARGETS;
  return Object.fromEntries(
    Object.entries(targets).map(([artifactTarget, descriptor]) => {
      const { os, cpu, ...fields } = descriptor;
      return [artifactTarget, {
        artifactTarget,
        ...fields,
        platform: os,
        arch: cpu
      }];
    })
  );
}

function canonicalLauncherReleasePolicy(): ReleasePolicyByTarget {
  return Object.fromEntries(RELEASE_TARGETS.map((descriptor) => [
    descriptor.artifactTarget,
    descriptor
  ]));
}
