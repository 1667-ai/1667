import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGzip, gzipSync } from "node:zlib";
import test from "node:test";
import {
  MAX_RELEASE_TARBALL_FILE_BYTES,
  parseReleasePackageManifest,
  validateReleaseTarballInspection
} from "../scripts/release-package-policy.js";
import { RELEASE_PACKAGE_REPOSITORY } from "../scripts/release-package-manifests.js";
import { releaseTargetForArtifact } from "../shared/release-targets.js";
import { readReleaseTarball } from "../scripts/release-tar-reader.js";

const PLATFORM_PACKAGE = releaseTargetForArtifact("linux-x64").packageName;
const manifest = parseReleasePackageManifest({
  name: PLATFORM_PACKAGE,
  version: "3.0.0",
  private: false,
  os: ["linux"],
  cpu: ["x64"],
  libc: ["glibc"],
  files: ["bin/1667", "build-manifest.json", "sbom.spdx.json"],
  repository: RELEASE_PACKAGE_REPOSITORY,
  publishConfig: { access: "public" }
}, "3.0.0");
const execFileAsync = promisify(execFile);

test("non-extracting reader hashes a bounded ustar package for policy validation", async () => {
  const tarball = gzipSync(tar([
    entry(
      "package/package.json",
      "0",
      0o644,
      Buffer.from(JSON.stringify({ name: PLATFORM_PACKAGE }))
    ),
    entry("package/bin/1667", "0", 0o755, Buffer.from("native executable")),
    entry("package/build-manifest.json", "0", 0o644, Buffer.from('{"schemaVersion":1}')),
    entry("package/sbom.spdx.json", "0", 0o644, Buffer.from('{"spdxVersion":"SPDX-2.3"}'))
  ]));
  const result = await readReleaseTarball(tarball);
  const validated = validateReleaseTarballInspection(result.inspection, manifest);
  assert.equal(validated.entries.length, 4);
  assert.equal(validated.packageName, PLATFORM_PACKAGE);
  assert.ok(validated.entries.every((item) => item.type === "file"));
  assert.equal(
    (result.packageManifest as Record<string, unknown>).name,
    PLATFORM_PACKAGE
  );
  assert.equal(
    result.gzip.sha256,
    createHash("sha256").update(tarball).digest("hex")
  );
});

test("reader accepts the actual script-disabled npm pack format", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-pack-test-"));
  const output = path.join(root, "packed");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(output);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: PLATFORM_PACKAGE,
    version: "3.0.0",
    private: false,
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
    files: ["bin/1667", "build-manifest.json", "sbom.spdx.json"],
    repository: RELEASE_PACKAGE_REPOSITORY,
    publishConfig: { access: "public" }
  })}\n`);
  await writeFile(path.join(root, "bin", "1667"), "native executable");
  await chmod(path.join(root, "bin", "1667"), 0o755);
  await writeFile(path.join(root, "build-manifest.json"), '{"schemaVersion":1}\n');
  await writeFile(path.join(root, "sbom.spdx.json"), '{"spdxVersion":"SPDX-2.3"}\n');
  const { stdout } = await execFileAsync("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    output
  ], { cwd: root, encoding: "utf8" });
  const packed = JSON.parse(stdout) as Array<{ filename: string }>;
  const bytes = await readFile(path.join(output, packed[0]!.filename));
  const result = await readReleaseTarball(bytes);
  assert.doesNotThrow(() => {
    validateReleaseTarballInspection(result.inspection, manifest);
  });
  assert.equal(
    (result.packageManifest as Record<string, unknown>).version,
    "3.0.0"
  );
});

test("reader rejects links, corrupt headers, truncation, and bytes after termination", async () => {
  await assert.rejects(readReleaseTarball(gzipSync(tar([
    entry("package/package.json", "2", 0o644, Buffer.alloc(0))
  ]))), /unsupported entry type/);

  const corrupt = tar([
    entry("package/package.json", "0", 0o644, Buffer.from("{}"))
  ]);
  corrupt[0] = corrupt[0]! ^ 1;
  await assert.rejects(readReleaseTarball(gzipSync(corrupt)), /checksum/);

  const truncated = tar([
    entry("package/package.json", "0", 0o644, Buffer.alloc(600))
  ]).subarray(0, 700);
  await assert.rejects(readReleaseTarball(gzipSync(truncated)));

  const trailing = Buffer.concat([
    tar([entry("package/package.json", "0", 0o644, Buffer.from("{}"))]),
    Buffer.from([1])
  ]);
  await assert.rejects(readReleaseTarball(gzipSync(trailing)), /trailing bytes/);
});

test("reader enforces padding, terminator, alignment, and file-byte bounds", async () => {
  const fixture = entry(
    "package/package.json",
    "0",
    0o644,
    Buffer.from("{}")
  );
  const nonzeroPadding = tar([fixture]);
  nonzeroPadding[512 + fixture.body.byteLength] = 1;
  await assert.rejects(
    readReleaseTarball(gzipSync(nonzeroPadding)),
    /padding is nonzero/
  );

  const oneTerminator = tar([fixture]).subarray(0, -512);
  await assert.rejects(
    readReleaseTarball(gzipSync(oneTerminator)),
    /complete end marker/
  );

  const nonBlockAligned = Buffer.concat([tar([fixture]), Buffer.alloc(1)]);
  await assert.rejects(
    readReleaseTarball(gzipSync(nonBlockAligned)),
    /non-block-aligned/
  );

  const oversized = Buffer.concat([
    tarHeader(
      "package/bin/1667",
      "0",
      0o755,
      MAX_RELEASE_TARBALL_FILE_BYTES + 1
    ),
    Buffer.alloc(1024)
  ]);
  await assert.rejects(
    readReleaseTarball(gzipSync(oversized)),
    /file bytes exceed/
  );
});

test("reader streams a realistic native payload within a bounded RSS budget", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-tar-streaming-test-"));
  const tarballPath = path.join(root, "large-native.tgz");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeLargeTarball(tarballPath, 64 * 1024 * 1024);

  const readerUrl = pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "release-tar-reader.ts"
  )).href;
  const program = [
    'import { createReadStream } from "node:fs";',
    `import { readReleaseTarball } from ${JSON.stringify(readerUrl)};`,
    "const started = performance.now();",
    `const result = await readReleaseTarball(createReadStream(${JSON.stringify(tarballPath)}));`,
    "process.stdout.write(JSON.stringify({",
    "  elapsedMs: performance.now() - started,",
    "  gzipBytes: result.gzip.bytes,",
    "  maxRssBytes: process.resourceUsage().maxRSS * 1024",
    "}));"
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    program
  ], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000
  });
  const measurement = JSON.parse(stdout) as {
    elapsedMs: number;
    gzipBytes: number;
    maxRssBytes: number;
  };
  assert.ok(measurement.gzipBytes > 0);
  assert.ok(
    measurement.maxRssBytes < 384 * 1024 * 1024,
    `streaming reader peak RSS ${formatMiB(measurement.maxRssBytes)} MiB`
  );
  assert.ok(
    measurement.elapsedMs < 30_000,
    `streaming reader took ${measurement.elapsedMs.toFixed(1)} ms`
  );
  t.diagnostic(
    `64 MiB native body: ${measurement.elapsedMs.toFixed(1)} ms, `
      + `${formatMiB(measurement.maxRssBytes)} MiB peak RSS`
  );
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

async function writeLargeTarball(filePath: string, nativeBytes: number): Promise<void> {
  const gzip = createGzip({ level: 1 });
  const completion = pipeline(gzip, createWriteStream(filePath));
  await writeSmallEntry(
    gzip,
    "package/package.json",
    0o644,
    Buffer.from(JSON.stringify({ name: PLATFORM_PACKAGE }))
  );
  await writeChunk(gzip, tarHeader("package/bin/1667", "0", 0o755, nativeBytes));
  const nativeChunk = Buffer.alloc(64 * 1024, 0x61);
  for (let written = 0; written < nativeBytes; written += nativeChunk.byteLength) {
    await writeChunk(gzip, nativeChunk.subarray(
      0,
      Math.min(nativeChunk.byteLength, nativeBytes - written)
    ));
  }
  const nativePadding = (512 - (nativeBytes % 512)) % 512;
  if (nativePadding !== 0) await writeChunk(gzip, Buffer.alloc(nativePadding));
  await writeSmallEntry(
    gzip,
    "package/build-manifest.json",
    0o644,
    Buffer.from('{"schemaVersion":1}')
  );
  gzip.end(Buffer.alloc(1024));
  await completion;
}

async function writeSmallEntry(
  target: Writable,
  name: string,
  mode: number,
  body: Buffer
): Promise<void> {
  await writeChunk(target, tarHeader(name, "0", mode, body.byteLength));
  await writeChunk(target, body);
  const padding = (512 - (body.byteLength % 512)) % 512;
  if (padding !== 0) await writeChunk(target, Buffer.alloc(padding));
}

async function writeChunk(target: Writable, bytes: Uint8Array): Promise<void> {
  if (!target.write(bytes)) await once(target, "drain");
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
