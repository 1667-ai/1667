import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  LAUNCHER_RELEASE_TARGETS,
  resolveLaunchPlan,
  selectTarget
} from "../release/npm/launcher.mjs";
import { RELEASE_TARGETS } from "../shared/release-targets.js";

const VERSION = "3.0.0";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-23T10:20:30.000Z";
const execFileAsync = promisify(execFile);

test("standalone launcher target table exactly matches canonical release policy", () => {
  assert.deepEqual(
    LAUNCHER_RELEASE_TARGETS,
    Object.fromEntries(RELEASE_TARGETS.map((descriptor) => [
      descriptor.artifactTarget,
      {
        packageName: descriptor.packageName,
        os: descriptor.platform,
        cpu: descriptor.arch,
        executable: descriptor.executable
      }
    ]))
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
  assert.equal(plan.packageName, "1667-linux-x64");
  assert.equal(plan.productVersion, VERSION);
  assert.equal(plan.sourceCommit, COMMIT);
  assert.equal(plan.launcherRoot, root);
  assert.equal(
    plan.platformRoot,
    path.join(root, "node_modules", "1667-linux-x64")
  );
  assert.deepEqual(plan.args, ["--version", "--json"]);
  assert.equal(plan.executable, path.join(
    root,
    "node_modules",
    "1667-linux-x64",
    "bin",
    "1667"
  ));
  await rm(path.join(root, "node_modules", "1667-linux-x64"), {
    recursive: true,
    force: true
  });
  assert.throws(() => resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  }), /Missing 1667-linux-x64/);
});

test("launcher fails closed on package/build identity skew and unsupported targets", async (t) => {
  const { base, root } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const buildPath = path.join(
    root,
    "node_modules",
    "1667-linux-x64",
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

test("launcher ignores NODE_PATH while accepting one documented hoisted package", async (t) => {
  const { base, root } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const packageName = "1667-linux-x64";
  const nested = path.join(root, "node_modules", packageName);
  const ambientRoot = path.join(base, "ambient");
  await mkdir(ambientRoot);
  await rename(nested, path.join(ambientRoot, packageName));

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

  const hoisted = path.join(path.dirname(root), packageName);
  await rename(path.join(ambientRoot, packageName), hoisted);
  assert.equal(resolveLaunchPlan({
    launcherRoot: root,
    platform: "linux",
    arch: "x64"
  }).platformRoot, hoisted);
});

test("launcher preserves an independently signalled child's failure", {
  skip: process.platform === "win32"
}, async (t) => {
  const { base, root } = await launcherFixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const executable = path.join(
    root,
    "node_modules",
    "1667-linux-x64",
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

async function launcherFixture(): Promise<{ base: string; root: string }> {
  const temporaryBase = await mkdtemp(path.join(tmpdir(), "1667-launcher-test-"));
  const base = await realpath(temporaryBase);
  const root = path.join(base, "1667");
  const platformRoot = path.join(root, "node_modules", "1667-linux-x64");
  await mkdir(path.join(platformRoot, "bin"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "1667",
    version: VERSION,
    optionalDependencies: { "1667-linux-x64": VERSION }
  }));
  await writeFile(
    path.join(root, "build-manifest.json"),
    JSON.stringify(buildManifest("1667", "launcher"))
  );
  await writeFile(path.join(platformRoot, "package.json"), JSON.stringify({
    name: "1667-linux-x64",
    version: VERSION,
    os: ["linux"],
    cpu: ["x64"]
  }));
  await writeFile(
    path.join(platformRoot, "build-manifest.json"),
    JSON.stringify(buildManifest("1667-linux-x64", "linux-x64"))
  );
  const executable = path.join(platformRoot, "bin", "1667");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return { base, root };
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
