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
  releasePackageJson
} from "../scripts/release-package-manifests.js";
import { readReleaseTarball } from "../scripts/release-tar-reader.js";
import { extractPlatformPackageExecutable } from "../shared/release-tar-extract.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const LICENSE = await readFile(path.join(REPOSITORY_ROOT, "LICENSE"));
const NOTICE = await readFile(path.join(REPOSITORY_ROOT, "NOTICE"));

const PLATFORM_MANIFEST = releasePackageJson(
  createReleasePlatformManifest("linux-x64", "3.0.0")
);
const PLATFORM_PACKAGE = PLATFORM_MANIFEST.name as "@1667-ai/linux-x64";
const manifest = parseReleasePackageManifest(PLATFORM_MANIFEST, "3.0.0");

/** setuid + rwxr-xr-x — must not be accepted as a normal 0755 executable. */
const SETUID_EXEC_MODE = 0o4755;

function platformFixture(executableMode: number): Buffer {
  return gzipSync(tar([
    entry(
      "package/package.json",
      "0",
      0o644,
      Buffer.from(JSON.stringify(PLATFORM_MANIFEST))
    ),
    entry(
      "package/bin/1667",
      "0",
      executableMode,
      Buffer.from("native executable")
    ),
    entry("package/build-manifest.json", "0", 0o644, Buffer.from('{"schemaVersion":1}')),
    entry("package/sbom.spdx.json", "0", 0o644, Buffer.from('{"spdxVersion":"SPDX-2.3"}')),
    entry("package/LICENSE", "0", 0o644, LICENSE),
    entry("package/NOTICE", "0", 0o644, NOTICE)
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
      bytes: gzipSync(tar([
        entry("package/package.json", "2", 0o644, Buffer.alloc(0))
      ])),
      pattern: /unsupported entry type/
    },
    {
      name: "corrupt header checksum",
      bytes: (() => {
        const raw = tar([
          entry("package/package.json", "0", 0o644, Buffer.from("{}"))
        ]);
        raw[0] = raw[0]! ^ 1;
        return gzipSync(raw);
      })(),
      pattern: /checksum/
    },
    {
      name: "nonzero padding",
      bytes: (() => {
        const fixture = entry("package/package.json", "0", 0o644, Buffer.from("{}"));
        const raw = tar([fixture]);
        raw[512 + fixture.body.byteLength] = 1;
        return gzipSync(raw);
      })(),
      pattern: /padding is nonzero/
    },
    {
      name: "incomplete end marker",
      bytes: gzipSync(
        tar([entry("package/package.json", "0", 0o644, Buffer.from("{}"))])
          .subarray(0, -512)
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

interface TarEntryFixture {
  header: Buffer;
  body: Buffer;
}

function entry(
  name: string,
  type: "0" | "2" | "5",
  mode: number,
  body: Buffer
): TarEntryFixture {
  return { header: tarHeader(name, type, mode, body.byteLength), body };
}

function tarHeader(
  name: string,
  type: "0" | "2" | "5",
  mode: number,
  size: number
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
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
