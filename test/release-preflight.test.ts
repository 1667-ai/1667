import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  type PackagedArtifactTarget
} from "../shared/build-identity.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_PACKAGE_COUNT,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";
import { createReleasePackageTemplates } from "../scripts/release-package-templates.js";

const VERSION = "4.0.0";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-23T10:20:30.000Z";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const execFileAsync = promisify(execFile);
const sourceEvidence = {
  schemaVersion: 1,
  productVersion: VERSION,
  sourceCommit: COMMIT,
  sourceDirty: false,
  tagName: `v${VERSION}`,
  tagObjectType: "annotated",
  tagSignature: "verified",
  tagTargetCommit: COMMIT,
  buildTimestamp: TIMESTAMP,
  packageVersions: {
    root: VERSION,
    tui: VERSION,
    rootLock: VERSION,
    rootLockPackage: VERSION
  }
} as const;

test("local release preflight CLI validates every tarball and emits canonical evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identities = createReleaseIdentitySet(sourceEvidence);
  const templates = createReleasePackageTemplates(identities);
  // Staging copies these repository-root files into every package root, and
  // release policy pins both to their reviewed digests, so the fixture stages
  // the real bytes rather than stand-ins.
  const license = await readFile(path.join(REPOSITORY_ROOT, "LICENSE"));
  const notice = await readFile(path.join(REPOSITORY_ROOT, "NOTICE"));
  const artifacts = [];
  for (const [index, template] of [
    templates.launcher,
    ...templates.platforms
  ].entries()) {
    const target = template.buildManifest.artifactTarget;
    const executable = target === "launcher"
      ? "bin/1667.js"
      : releaseTargetForArtifact(target).executable;
    const tarball = gzipSync(tar([
      entry(
        "package/package.json",
        0o644,
        Buffer.from(JSON.stringify(template.packageManifest))
      ),
      entry(
        `package/${executable}`,
        0o755,
        Buffer.from(target === "launcher" ? "#!/usr/bin/env node\n" : `native-${target}`)
      ),
      entry(
        "package/build-manifest.json",
        0o644,
        Buffer.from(JSON.stringify(template.buildManifest))
      ),
      entry(
        "package/sbom.spdx.json",
        0o644,
        Buffer.from('{"spdxVersion":"SPDX-2.3"}')
      ),
      entry("package/LICENSE", 0o644, license),
      entry("package/NOTICE", 0o644, notice)
    ]));
    const tarballPath = `artifact-${index}.tgz`;
    await writeFile(path.join(root, tarballPath), tarball);
    artifacts.push({ tarballPath, buildIdentity: template.buildIdentity });
  }
  const planPath = path.join(root, "plan.json");
  await writeFile(planPath, JSON.stringify({
    schemaVersion: 1,
    sourceEvidence,
    artifacts
  }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    path.join(REPOSITORY_ROOT, "scripts", "release-preflight.ts"),
    planPath
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  });
  const output = JSON.parse(stdout) as {
    artifacts: {
      name: string;
      license: { sha256: string };
      notice: { sha256: string };
    }[];
  };
  // Derived, so dropping or restoring a release target cannot silently
  // leave this gate asserting a stale artifact count.
  assert.equal(output.artifacts.length, RELEASE_PACKAGE_COUNT);
  assert.equal(output.artifacts[0]!.name, RELEASE_LAUNCHER_PACKAGE);
  for (const artifact of output.artifacts) {
    assert.equal(artifact.license.sha256, createHash("sha256").update(license).digest("hex"));
    assert.equal(artifact.notice.sha256, createHash("sha256").update(notice).digest("hex"));
  }
  assert.match(stderr, /^release-manifest-sha256 [0-9a-f]{64}\n$/);
  assert.equal(JSON.stringify(output), stdout);
  assert.equal(
    createHash("sha256").update(stdout).digest("hex"),
    stderr.match(/^release-manifest-sha256 ([0-9a-f]{64})\n$/)?.[1]
  );

  const duplicatePlan = path.join(root, "duplicate.json");
  await writeFile(duplicatePlan, '{"schemaVersion":1,"schemaVersion":1}');
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import",
      "tsx",
      path.join(REPOSITORY_ROOT, "scripts", "release-preflight.ts"),
      duplicatePlan
    ], { cwd: REPOSITORY_ROOT, encoding: "utf8" }),
    (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      return /duplicate object key/.test(stderr);
    }
  );
});

interface TarEntryFixture {
  header: Buffer;
  body: Buffer;
}

function entry(name: string, mode: number, body: Buffer): TarEntryFixture {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, body.byteLength);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return { header, body };
}

function tar(entries: TarEntryFixture[]): Buffer {
  const chunks: Buffer[] = [];
  for (const { header, body } of entries) {
    chunks.push(header, body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function octal(
  target: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  target.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  );
}
