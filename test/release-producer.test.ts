import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseBuildIdentity } from "../shared/build-identity.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  RELEASE_TARGETS,
  releaseTargetForArtifact,
  releaseTargetForRuntime,
  type BuiltArtifactTarget,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";
import {
  npmPackInvocationFromEnvironment,
  packReleasePackage,
  packReleasePackages,
  type NpmPackInvocation
} from "../scripts/release-pack.js";
import { releaseIdentityForTarget } from "../scripts/release-identity.js";
import { createReleasePreflightPlan } from "../scripts/release-npm-plan.js";
import { publicationPackages } from "../scripts/release-npm-publish.js";
import { runReleasePreflight } from "../scripts/release-preflight.js";
import {
  stagePublishedReleasePackages,
  stageReleasePackage,
  type StagedReleasePackage
} from "../scripts/release-stage-packages.js";
import { releaseIdentitiesForSource } from "../scripts/release-source-facts.js";
import {
  assertMissing,
  tarModificationTimes
} from "./release-producer-fixture.js";

const VERSION = "0.1.2-beta.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-28T10:20:30.000Z";
const execFileAsync = promisify(execFile);
const facts = Object.freeze({
  version: VERSION,
  sourceCommit: COMMIT,
  buildTimestamp: TIMESTAMP
});

test("real staging and packing feed preflight reproducibly and launch locally", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = npmPackInvocationFromEnvironment();
  const builds = path.join(root, "builds");
  const buildDirectories = await stageBuildInputs(builds);
  const firstStage = path.join(root, "stage-a");
  let first: readonly StagedReleasePackage[];
  let publishedSourceCommitReads = 0;
  const previousUmask = process.umask(0o077);
  try {
    first = stagePublishedReleasePackages({
      version: facts.version,
      get sourceCommit(): string {
        publishedSourceCommitReads += 1;
        return publishedSourceCommitReads === 1 ? COMMIT : "f".repeat(40);
      },
      buildTimestamp: facts.buildTimestamp,
      buildDirectories,
      outputDirectory: firstStage
    });
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(publishedSourceCommitReads, 1);
  assert.equal(first.length, PUBLISHED_PACKAGE_COUNT);
  assert.deepEqual(
    first.map((entry) => entry.artifactTarget),
    ["launcher", ...PUBLISHED_ARTIFACT_TARGETS]
  );
  assert.ok(first.every((entry) => entry.published));
  await assertNormalizedMtimes(first);

  const firstPacked = await packReleasePackages({
    packages: first,
    outputDirectory: path.join(root, "pack-a"),
    npm
  });
  const identities = releaseIdentitiesForSource(facts);
  const observedIdentities = new Map(await Promise.all(first
    .filter((entry) => entry.artifactTarget !== "launcher")
    .map(async (entry) => {
      const artifactTarget = entry.artifactTarget as BuiltArtifactTarget;
      const descriptor = releaseTargetForArtifact(artifactTarget);
      const { stdout } = await execFileAsync(
        path.join(entry.directory, descriptor.executable),
        ["--version", "--json"],
        { encoding: "utf8" }
      );
      return [artifactTarget, parseBuildIdentity(JSON.parse(stdout))] as const;
    })));
  const observations = path.join(root, "observations");
  await mkdir(observations);
  for (const staged of first.slice(1)) {
    const target = staged.artifactTarget as PublishedArtifactTarget;
    const descriptor = releaseTargetForArtifact(target);
    const executable = path.join(staged.directory, descriptor.executable);
    const bytes = await readFile(executable);
    await writeFile(path.join(observations, `${target}.json`), JSON.stringify({
      schemaVersion: 1,
      artifactTarget: target,
      executable: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength
      },
      buildIdentity: observedIdentities.get(target)
    }));
  }
  const plan = await createReleasePreflightPlan(
    identities.evidence,
    path.join(root, "pack-a"),
    observations,
    await realpath(root)
  );
  const preflight = await runReleasePreflight(plan, root);
  assert.equal(preflight.manifest.artifacts.length, PUBLISHED_PACKAGE_COUNT);
  assert.deepEqual(
    preflight.manifest.artifacts.map((entry) => entry.name),
    first.map((entry) => entry.packageName)
  );
  const planPath = path.join(root, "plan.json");
  const manifestPath = path.join(root, "artifact-manifest.json");
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(manifestPath, preflight.text);
  assert.equal(
    (await publicationPackages(planPath, manifestPath, path.join(root, "pack-a")))
      .packages.length,
    PUBLISHED_PACKAGE_COUNT
  );
  await writeFile(manifestPath, "{}");
  await assert.rejects(
    publicationPackages(planPath, manifestPath, path.join(root, "pack-a")),
    /does not match repeated preflight/u
  );
  const mutatedTarget = PUBLISHED_ARTIFACT_TARGETS[0]!;
  const mutationFile = path.join(observations, `${mutatedTarget}.json`);
  const mutation = JSON.parse(await readFile(mutationFile, "utf8")) as {
    executable: { sha256: string };
  };
  mutation.executable.sha256 = "0".repeat(64);
  await writeFile(mutationFile, JSON.stringify(mutation));
  await assert.rejects(
    createReleasePreflightPlan(
      identities.evidence,
      path.join(root, "pack-a"),
      observations,
      await realpath(root)
    ),
    /observation does not describe the packaged executable/u
  );

  await varyBuildMtimes(buildDirectories);
  const second = stagePublishedReleasePackages({
    ...facts,
    buildDirectories,
    outputDirectory: path.join(root, "stage-b")
  });
  const secondPacked = await packReleasePackages({
    packages: second,
    outputDirectory: path.join(root, "pack-b"),
    npm
  });
  for (const [index, packed] of firstPacked.entries()) {
    const firstBytes = await readFile(packed.tarballPath);
    const secondBytes = await readFile(secondPacked[index]!.tarballPath);
    assert.deepEqual(
      secondBytes,
      firstBytes,
      `${packed.packageName} changed across identical staging inputs`
    );
    assert.deepEqual(
      tarModificationTimes(secondBytes),
      tarModificationTimes(firstBytes),
      `${packed.packageName} has variable tar header times`
    );
  }

  await assertInstalledLauncherStarts(firstPacked, npm, root);
});

test("a held target stages and validates without entering the published batch", async (t) => {
  const held = RELEASE_TARGETS.find((entry) => entry.heldFromPublication !== null);
  assert.ok(held, "the test requires the current held target");
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-held-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, path.posix.basename(held.executable));
  await writeExecutable(executable, held.artifactTarget);
  let heldSourceCommitReads = 0;
  const staged = stageReleasePackage({
    version: facts.version,
    get sourceCommit(): string {
      heldSourceCommitReads += 1;
      return heldSourceCommitReads === 1 ? COMMIT : "f".repeat(40);
    },
    buildTimestamp: facts.buildTimestamp,
    artifactTarget: held.artifactTarget,
    executable,
    outputDirectory: path.join(root, "stage")
  });
  assert.equal(heldSourceCommitReads, 1);
  assert.equal(staged.published, false);
  assert.equal(staged.packageName, held.packageName);
  assert.equal(staged.packageManifest.name, held.packageName);
  await mkdir(path.join(root, "pack"));
  const packed = await packReleasePackage(
    staged,
    path.join(root, "pack"),
    npmPackInvocationFromEnvironment()
  );
  assert.equal(packed.artifactTarget, held.artifactTarget);
  assert.equal(packed.packageName, held.packageName);

  const wrongTarget = PUBLISHED_ARTIFACT_TARGETS[0]!;
  await mkdir(path.join(root, "wrong-pack"));
  await assert.rejects(
    packReleasePackage(
      { ...staged, artifactTarget: wrongTarget },
      path.join(root, "wrong-pack"),
      npmPackInvocationFromEnvironment()
    ),
    new RegExp(`returned ${held.artifactTarget}, expected ${wrongTarget}`)
  );

  await mkdir(path.join(root, "wrong-version-pack"));
  await assert.rejects(
    packReleasePackage(
      { ...staged, version: "0.1.0-rc.2" },
      path.join(root, "wrong-version-pack"),
      npmPackInvocationFromEnvironment()
    ),
    /wrong version/
  );

  const pinned = npmPackInvocationFromEnvironment();
  await mkdir(path.join(root, "relative-tool-pack"));
  await assert.rejects(
    packReleasePackage(staged, path.join(root, "relative-tool-pack"), {
      nodeExecutable: path.relative(process.cwd(), pinned.nodeExecutable),
      npmCli: path.relative(process.cwd(), pinned.npmCli)
    }),
    /absolute path/
  );

  await chmod(path.join(staged.directory, held.executable), 0o755);
  await mkdir(path.join(root, "unsafe-mode-pack"));
  await assert.rejects(
    packReleasePackage(
      staged,
      path.join(root, "unsafe-mode-pack"),
      npmPackInvocationFromEnvironment()
    ),
    /unsafe mode/
  );
});

test("release pack refuses an unpinned npm invocation", async () => {
  await assert.rejects(
    packReleasePackages({
      packages: [],
      outputDirectory: ".",
      npm: { nodeExecutable: "node", npmCli: "npm" }
    }),
    /exactly .* staged packages/
  );
  await assert.rejects(
    packReleasePackage({
      artifactTarget: "launcher",
      packageName: "@1667-ai/cli",
      version: VERSION,
      directory: "."
    }, ".", {
      nodeExecutable: "node",
      npmCli: "npm"
    }),
    /absolute path/
  );
});

test("staging and batch packing do not publish partial output", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builds = path.join(root, "builds");
  const buildDirectories = await stageBuildInputs(builds);
  const brokenTarget = PUBLISHED_ARTIFACT_TARGETS.at(-1)!;
  const brokenDescriptor = releaseTargetForArtifact(brokenTarget);
  const brokenExecutable = path.join(
    buildDirectories[brokenTarget],
    path.posix.basename(brokenDescriptor.executable)
  );
  await rm(brokenExecutable);
  const staging = path.join(root, "staging");
  assert.throws(() => stagePublishedReleasePackages({
    ...facts,
    buildDirectories,
    outputDirectory: staging
  }));
  await assertMissing(staging);

  await writeExecutable(brokenExecutable, brokenTarget);
  const staged = stagePublishedReleasePackages({
    ...facts,
    buildDirectories,
    outputDirectory: staging
  });
  const pinned = npmPackInvocationFromEnvironment();
  const invalidToolOutput = path.join(root, "invalid-tool");
  await assert.rejects(packReleasePackages({
    packages: staged,
    outputDirectory: invalidToolOutput,
    npm: {
      nodeExecutable: path.relative(process.cwd(), pinned.nodeExecutable),
      npmCli: path.relative(process.cwd(), pinned.npmCli)
    }
  }), /absolute path/);
  await assertMissing(invalidToolOutput);
  assert.equal(
    (await readdir(root)).some((name) => name.startsWith(".invalid-tool-")),
    false,
    "invalid tools leaked a temporary batch directory"
  );

  const mixedVersion = staged.map((entry, index) => {
    return index === 1 ? { ...entry, version: "0.1.0-rc.2" } : entry;
  });
  const mixedOutput = path.join(root, "mixed-version");
  await assert.rejects(packReleasePackages({
    packages: mixedVersion,
    outputDirectory: mixedOutput,
    npm: npmPackInvocationFromEnvironment()
  }), /one version/);
  await assertMissing(mixedOutput);

  const unsafe = staged[1]!;
  const unsafeManifest = path.join(unsafe.directory, "package.json");
  const originalManifest = await readFile(unsafeManifest);
  const wrongManifest = JSON.parse(originalManifest.toString("utf8")) as Record<string, unknown>;
  wrongManifest.version = "0.1.0-rc.2";
  await writeFile(unsafeManifest, JSON.stringify(wrongManifest));
  const packed = path.join(root, "packed");
  await assert.rejects(packReleasePackages({
    packages: staged,
    outputDirectory: packed,
    npm: npmPackInvocationFromEnvironment()
  }), /wrong version/);
  await assertMissing(packed);

  await writeFile(unsafeManifest, originalManifest);
  const complete = await packReleasePackages({
    packages: staged,
    outputDirectory: packed,
    npm: npmPackInvocationFromEnvironment()
  });
  assert.equal(complete.length, PUBLISHED_PACKAGE_COUNT);
});

test("staging refuses an existing package path without following it", async (t) => {
  const held = RELEASE_TARGETS.find((entry) => entry.heldFromPublication !== null);
  assert.ok(held);
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, path.posix.basename(held.executable));
  await writeExecutable(executable, held.artifactTarget);
  const staging = path.join(root, "staging");
  const outside = path.join(root, "outside");
  await mkdir(staging);
  await mkdir(outside);
  await symlink(outside, path.join(staging, held.artifactTarget), "dir");
  const marker = path.join(outside, "keep");
  await writeFile(marker, "unchanged");
  assert.throws(() => stageReleasePackage({
    ...facts,
    artifactTarget: held.artifactTarget,
    executable,
    outputDirectory: staging
  }), /already exists/);
  assert.equal(await readFile(marker, "utf8"), "unchanged");
});

test("release pack cannot run package lifecycle scripts", async (t) => {
  const held = RELEASE_TARGETS.find((entry) => entry.heldFromPublication !== null);
  assert.ok(held);
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, path.posix.basename(held.executable));
  await writeExecutable(executable, held.artifactTarget);
  const staged = stageReleasePackage({
    ...facts,
    artifactTarget: held.artifactTarget,
    executable,
    outputDirectory: path.join(root, "staging")
  });
  const sentinel = path.join(root, "lifecycle-ran");
  const manifest = JSON.parse(await readFile(
    path.join(staged.directory, "package.json"),
    "utf8"
  )) as Record<string, unknown>;
  manifest.scripts = { prepack: "node prepack.cjs", prepare: "node prepack.cjs" };
  await writeFile(
    path.join(staged.directory, "prepack.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`
  );
  await writeFile(path.join(staged.directory, "package.json"), JSON.stringify(manifest));
  const pinned = npmPackInvocationFromEnvironment();
  const fakeNpmSentinel = path.join(root, "fake-npm-ran");
  const fakeNpm = path.join(root, "fake-npm.cjs");
  await writeFile(fakeNpm, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(fakeNpmSentinel)}, JSON.stringify({`,
    "  command: process.argv[2],",
    "  ignoreScriptsFlag: process.argv.includes('--ignore-scripts'),",
    "  ignoreScriptsConfig: process.env.npm_config_ignore_scripts",
    "}));",
    "process.stdout.write('[]');",
    ""
  ].join("\n"));
  await mkdir(path.join(root, "fake-packed"));
  await assert.rejects(packReleasePackage(
    staged,
    path.join(root, "fake-packed"),
    { nodeExecutable: pinned.nodeExecutable, npmCli: fakeNpm }
  ));
  await assertMissing(fakeNpmSentinel);

  delete manifest.scripts;
  await writeFile(path.join(staged.directory, "package.json"), JSON.stringify(manifest));
  await mkdir(path.join(root, "valid-packed"));
  await assert.rejects(packReleasePackage(
    staged,
    path.join(root, "valid-packed"),
    { nodeExecutable: pinned.nodeExecutable, npmCli: fakeNpm }
  ), /no unique archive/);
  assert.deepEqual(JSON.parse(await readFile(fakeNpmSentinel, "utf8")), {
    command: "pack",
    ignoreScriptsFlag: true,
    ignoreScriptsConfig: "true"
  });
});

async function stageBuildInputs(
  root: string
): Promise<Record<PublishedArtifactTarget, string>> {
  const entries = await Promise.all(PUBLISHED_ARTIFACT_TARGETS.map(async (target) => {
    const directory = path.join(root, target);
    const descriptor = releaseTargetForArtifact(target);
    await mkdir(directory, { recursive: true });
    await writeExecutable(
      path.join(directory, path.posix.basename(descriptor.executable)),
      target
    );
    return [target, directory] as const;
  }));
  return Object.fromEntries(entries) as Record<PublishedArtifactTarget, string>;
}

async function writeExecutable(file: string, target: BuiltArtifactTarget): Promise<void> {
  const identity = releaseIdentityForTarget(releaseIdentitiesForSource(facts), target);
  await writeFile(file, [
    "#!/usr/bin/env node",
    `const identity = ${JSON.stringify(identity)};`,
    "if (process.argv.includes('--version')) process.stdout.write(JSON.stringify(identity));",
    `else process.stdout.write("producer-ok:${target}");`,
    ""
  ].join("\n"));
  await chmod(file, 0o755);
}

async function varyBuildMtimes(
  buildDirectories: Readonly<Record<PublishedArtifactTarget, string>>
): Promise<void> {
  const varied = new Date("2020-01-02T03:04:05.000Z");
  await Promise.all(PUBLISHED_ARTIFACT_TARGETS.map((target) => {
    const descriptor = releaseTargetForArtifact(target);
    return utimes(
      path.join(buildDirectories[target], path.posix.basename(descriptor.executable)),
      varied,
      varied
    );
  }));
}

async function assertNormalizedMtimes(packages: readonly StagedReleasePackage[]): Promise<void> {
  const expected = new Date(TIMESTAMP).getTime();
  for (const staged of packages) {
    for (const entry of await entriesBelow(staged.directory)) {
      const metadata = await stat(entry);
      assert.equal(
        metadata.mtimeMs,
        expected,
        `${path.relative(staged.directory, entry) || "."} has a variable mtime`
      );
      if (metadata.isDirectory()) {
        assert.equal(metadata.mode & 0o777, 0o755, "staged directory has an unsafe mode");
      }
    }
  }
}

async function entriesBelow(directory: string): Promise<string[]> {
  const entries = [directory];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await entriesBelow(child));
    else entries.push(child);
  }
  return entries;
}

async function assertInstalledLauncherStarts(
  packed: readonly {
    artifactTarget: "launcher" | BuiltArtifactTarget;
    tarballPath: string;
  }[],
  npm: NpmPackInvocation,
  root: string
): Promise<void> {
  const host = releaseTargetForRuntime(process.platform, process.arch);
  assert.ok(host !== null && host.heldFromPublication === null);
  const launcher = packed.find((entry) => entry.artifactTarget === "launcher");
  const platform = packed.find((entry) => entry.artifactTarget === host.artifactTarget);
  assert.ok(launcher);
  assert.ok(platform);
  const install = path.join(root, "install");
  await mkdir(install);
  await writeFile(path.join(install, "package.json"), JSON.stringify({
    name: "release-producer-integration",
    version: VERSION,
    private: true
  }));
  await runNpm(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--package-lock=false",
    launcher.tarballPath,
    platform.tarballPath
  ], install);
  const installedLauncher = path.join(
    install,
    "node_modules",
    "@1667-ai",
    "cli",
    "bin",
    "1667.js"
  );
  const { stdout, stderr } = await execFileAsync(
    npm.nodeExecutable,
    [installedLauncher, "--producer-smoke"],
    { cwd: install, encoding: "utf8" }
  );
  assert.equal(stderr, "");
  assert.equal(stdout, `producer-ok:${host.artifactTarget}`);
}

async function runNpm(
  npm: NpmPackInvocation,
  args: readonly string[],
  cwd: string
): Promise<void> {
  await execFileAsync(npm.nodeExecutable, [npm.npmCli, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
}
