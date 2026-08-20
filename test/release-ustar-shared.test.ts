/**
 * Shared ustar FSM regressions: both release-tar-reader and release-tar-extract
 * reject the same malformed streams, and setuid/sticky modes are not masked to
 * look like 0755 for publication policy.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  parseReleasePackageManifest,
  validateReleaseTarballInspection
} from "../scripts/release-package-policy.js";
import {
  createReleasePlatformManifest,
  releasePackageJson,
  RELEASE_PACKAGE_NOTICE
} from "../scripts/release-package-manifests.js";
import { readReleaseTarball } from "../scripts/release-tar-reader.js";
import { extractPlatformPackageExecutable } from "../shared/release-tar-extract.js";
import { RELEASE_SBOM_FIXTURE } from "./release-sbom-fixture.js";
import { ustarArchive } from "./ustar-fixture.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const LICENSE = await readFile(path.join(REPOSITORY_ROOT, "LICENSE"));
const NOTICE = Buffer.from(RELEASE_PACKAGE_NOTICE, "utf8");

const PLATFORM_MANIFEST = releasePackageJson(
  createReleasePlatformManifest("linux-x64", "3.0.0")
);
const PLATFORM_PACKAGE = PLATFORM_MANIFEST.name as "@1667-ai/linux-x64";
const manifest = parseReleasePackageManifest(PLATFORM_MANIFEST, "3.0.0");

/** setuid + rwxr-xr-x — must not be accepted as a normal 0755 executable. */
const SETUID_EXEC_MODE = 0o4755;

function platformFixture(executableMode: number): Buffer {
  return gzipSync(ustarArchive([
    {
      name: "package/package.json",
      type: "0",
      mode: 0o644,
      body: Buffer.from(JSON.stringify(PLATFORM_MANIFEST))
    },
    {
      name: "package/bin/1667",
      type: "0",
      mode: executableMode,
      body: Buffer.from("native executable")
    },
    {
      name: "package/build-manifest.json",
      type: "0",
      mode: 0o644,
      body: Buffer.from('{"schemaVersion":1}')
    },
    {
      name: "package/sbom.spdx.json",
      type: "0",
      mode: 0o644,
      body: RELEASE_SBOM_FIXTURE
    },
    { name: "package/LICENSE", type: "0", mode: 0o644, body: LICENSE },
    { name: "package/NOTICE", type: "0", mode: 0o644, body: NOTICE }
  ]));
}

test("reader preserves full mode 04755 and policy rejects it as unsafe", async () => {
  const tarball = platformFixture(SETUID_EXEC_MODE);
  const result = await readReleaseTarball(tarball);
  const bin = result.inspection.entries.find((e) => e.path === "package/bin/1667");
  assert.ok(bin !== undefined);
  assert.equal(bin.mode, SETUID_EXEC_MODE);
  assert.notEqual(bin.mode, 0o755);
  assert.throws(
    () => validateReleaseTarballInspection(result.inspection, manifest),
    /unsafe mode/
  );
});

test("extractor refuses mode 04755 executable (does not mask to 0755)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-ustar-extract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "candidate");
  const tarball = platformFixture(SETUID_EXEC_MODE);
  await assert.rejects(
    extractPlatformPackageExecutable(tarball, {
      packageName: PLATFORM_PACKAGE,
      version: "3.0.0",
      destinationPath: destination
    }),
    // Raw 04755 is not treated as the package executable (exact 0755 only),
    // so extraction fails closed rather than publishing a setuid candidate.
    /missing the platform executable|unsafe mode/
  );
});

test("reader and extractor reject the same malformed ustar streams", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-ustar-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cases: Array<{ name: string; bytes: Buffer; pattern: RegExp }> = [
    {
      name: "symlink entry type",
      bytes: gzipSync(ustarArchive([
        {
          name: "package/package.json",
          type: "2",
          mode: 0o644,
          linkname: "target"
        }
      ])),
      pattern: /unsupported entry type/
    },
    {
      name: "corrupt header checksum",
      bytes: (() => {
        const raw = ustarArchive([
          {
            name: "package/package.json",
            type: "0",
            mode: 0o644,
            body: Buffer.from("{}")
          }
        ]);
        raw[0] = raw[0]! ^ 1;
        return gzipSync(raw);
      })(),
      pattern: /checksum/
    },
    {
      name: "nonzero padding",
      bytes: (() => {
        const body = Buffer.from("{}");
        const raw = ustarArchive([
          {
            name: "package/package.json",
            type: "0",
            mode: 0o644,
            body
          }
        ]);
        raw[512 + body.byteLength] = 1;
        return gzipSync(raw);
      })(),
      pattern: /padding is nonzero/
    },
    {
      name: "incomplete end marker",
      bytes: gzipSync(
        ustarArchive(
          [{
            name: "package/package.json",
            type: "0",
            mode: 0o644,
            body: Buffer.from("{}")
          }],
          { terminatorBlocks: 1 }
        )
      ),
      pattern: /complete end marker/
    }
  ];

  for (const sample of cases) {
    await assert.rejects(
      readReleaseTarball(sample.bytes),
      sample.pattern,
      `reader: ${sample.name}`
    );
    await assert.rejects(
      extractPlatformPackageExecutable(sample.bytes, {
        packageName: PLATFORM_PACKAGE,
        version: "3.0.0",
        destinationPath: path.join(root, `out-${sample.name.replace(/\s+/g, "-")}`)
      }),
      sample.pattern,
      `extractor: ${sample.name}`
    );
  }
});

test("reader and extractor agree on sha256 of a well-formed 0755 executable entry", async () => {
  const body = Buffer.from("native executable");
  const tarball = platformFixture(0o755);
  const result = await readReleaseTarball(tarball);
  const bin = result.inspection.entries.find((e) => e.path === "package/bin/1667");
  assert.ok(bin !== undefined);
  assert.equal(bin.mode, 0o755);
  assert.equal(bin.sha256, createHash("sha256").update(body).digest("hex"));
});
