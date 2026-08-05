import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import { npmPackInvocationFromEnvironment } from "../scripts/release-pack.js";
import { AI_1667_PRODUCT_VERSION } from "../shared/build-identity.js";
import { releaseIdentityForTarget } from "../scripts/release-identity.js";
import {
  collectRepositoryReleaseSource
} from "../scripts/release-source-facts.js";

const REPOSITORY_ROOT = path.dirname(path.dirname(import.meta.filename));
const FACTS = Object.freeze({
  // Release identity refuses a version the checkout's manifests disagree with.
  version: AI_1667_PRODUCT_VERSION,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  buildTimestamp: "2026-07-28T10:20:30.000Z"
});

test("the SBOM command rejects a version that does not describe the checkout", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/release-sbom.ts",
    "9.9.9",
    FACTS.sourceCommit,
    FACTS.buildTimestamp,
    RELEASE_LAUNCHER_PACKAGE
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Release root version does not match 9\.9\.9/u);
});

test("the npm stage and pack commands redirect valid JSON for the complete matrix", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builds = path.join(root, "builds");
  const { identities } = collectRepositoryReleaseSource(FACTS).artifactInputs();
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const descriptor = releaseTargetForArtifact(target);
    const directory = path.join(builds, target);
    const executable = path.join(directory, path.posix.basename(descriptor.executable));
    await mkdir(directory, { recursive: true });
    await writeFile(executable, [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(JSON.stringify(
        releaseIdentityForTarget(identities, target)
      ))});`,
      ""
    ].join("\n"));
    await chmod(executable, 0o755);
  }
  const npm = npmPackInvocationFromEnvironment();
  const staging = path.join(root, "staging");
  const stageOutput = path.join(root, "stage.json");
  const staged = await runReleaseCommand(npm, "release:stage", [
    FACTS.version,
    FACTS.sourceCommit,
    FACTS.buildTimestamp,
    builds,
    staging
  ], stageOutput);
  assert.equal(staged.packages.length, PUBLISHED_PACKAGE_COUNT);

  const tarballs = path.join(root, "tarballs");
  const packOutput = path.join(root, "pack.json");
  const packed = await runReleaseCommand(npm, "release:pack", [
    FACTS.version,
    staging,
    tarballs
  ], packOutput);
  assert.equal(packed.packages.length, PUBLISHED_PACKAGE_COUNT);
  await Promise.all(packed.packages.map((entry) => {
    const tarballPath = entry.tarballPath;
    assert.ok(typeof tarballPath === "string");
    return access(tarballPath);
  }));
});

interface CommandOutput {
  packages: { tarballPath?: string }[];
}

async function runReleaseCommand(
  npm: ReturnType<typeof npmPackInvocationFromEnvironment>,
  script: string,
  args: readonly string[],
  outputPath: string
): Promise<CommandOutput> {
  const output = await open(outputPath, "wx");
  try {
    const result = spawnSync(
      npm.nodeExecutable,
      [npm.npmCli, "run", "--silent", script, "--", ...args],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", output.fd, "pipe"]
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    await output.close();
  }
  return JSON.parse(await readFile(outputPath, "utf8")) as CommandOutput;
}
