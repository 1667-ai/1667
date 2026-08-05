/**
 * Shell Installer extract security: physical ustar validation, complete
 * decompressed stream bound, special entries, and the executable size bound.
 * Exercises the generated installer external interface (sh install-beta.sh).
 */
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderInstallScript } from "../scripts/release-install-script.js";
import {
  MAX_RELEASE_ARTIFACT_TAR_BYTES,
  MAX_RELEASE_EXECUTABLE_BYTES,
  MAX_RELEASE_TOTAL_FILE_BYTES
} from "../shared/release-artifact-bounds.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  canonicalReleaseArchiveEntries,
  digestsFor,
  execFileAsync,
  hostShellInstallerTarget,
  releaseStub,
  ustarArchive,
  writeFakeArchive,
  writeUstarGzipArchive
} from "./release-install-script-fixture.js";
import { createInstallerArchiveHarness } from "./release-install-script-harness.js";

test("generated installer pins shared archive and executable bounds and extract-only member", () => {
  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION)
  });
  assert.match(body, new RegExp(`MAX_TAR_BYTES=${MAX_RELEASE_ARTIFACT_TAR_BYTES}\\b`));
  assert.match(body, new RegExp(`MAX_EXECUTABLE_BYTES=${MAX_RELEASE_EXECUTABLE_BYTES}\\b`));
  assert.match(body, new RegExp(`MAX_FILE_BYTES=${MAX_RELEASE_TOTAL_FILE_BYTES}\\b`));
  assert.match(body, /validate_ustar_physical/);
  assert.match(body, /decompress_archive_bounded/);
  assert.match(body, /require_extract_tools/);
  assert.match(body, /Release executable size is outside the bound/);
  assert.match(body, /Release archive expanded size is outside the bound/);
  assert.match(
    body,
    /tar --no-same-owner -xf "\$tar_path" -C "\$stage" "\$member" 9>&-/
  );
  // Pipe limiter: fullblock so count is complete 512-byte blocks on GNU/BSD dd.
  assert.match(
    body,
    /dd bs=512 count=\$\(\(max_blocks \+ 1\)\) iflag=fullblock of="\$tar_path"/
  );
  // gzip exit status is captured in a private file (POSIX sh has no pipefail).
  assert.match(body, /gzip_status_path="\$\{tar_path\}\.gzip-status"/);
  assert.match(body, /gzip -dc "\$archive_path" 9>&- \|\| gs=\$\?/);
  assert.match(body, /\[ "\$gzip_status" -ne 0 \]/);
  // cmp children must not inherit the Install Root lock FD.
  const blockComparisons = [
    ...body.matchAll(/cmp -s "\$(?:hdr|hdr_path)" "\$zero"[^\n]*/gu)
  ];
  assert.equal(blockComparisons.length, 2);
  for (const match of blockComparisons) {
    assert.match(match[0]!, /9>&-/);
  }
  // Unambiguous field_text failure sentinel (not an awk backreference).
  assert.match(body, /__BAD_FIELD__/);
  assert.doesNotMatch(body, /return "\\1"/);
  // Full-archive extract and gzip extract-from-download are no longer accepted.
  assert.doesNotMatch(body, /tar --no-same-owner -xzf/);
  assert.doesNotMatch(body, /tar -tvzf/);
  // Physical header parse returns only generated numeric member records.
  assert.doesNotMatch(body, /set -- \$parsed/);
  assert.match(body, /case "\$parsed" in/);
  assert.match(body, /print "D:0"/);
  assert.match(body, /print "F:1:" size/);
  assert.match(body, /expected_mask=63/);
  assert.match(body, /m1="\$stem\/1667"/);
  assert.doesNotMatch(body, /assert_safe_member_path/);
});

test(
  "Shell Installer rejects oversized expanded executable and unsafe archive layouts",
  { timeout: 60_000 },
  async (t) => {
    const detectedTarget = hostShellInstallerTarget();
    if (detectedTarget === null) {
      t.skip("Host cannot run the POSIX Shell Installer");
      return;
    }
    const hostTarget: BuiltArtifactTarget = detectedTarget;
    const harness = await createInstallerArchiveHarness(
      t,
      hostTarget,
      "install-extract-sec"
    );
    const { root, archivePath, stem } = harness;

    async function runInstaller(
      label: string,
      mutateArchive: () => Promise<void>,
      pattern: RegExp,
      scriptMutator?: (body: string) => string
    ): Promise<void> {
      await harness.reject(label, async () => mutateArchive(), pattern, scriptMutator);
    }

    // Oversized expanded executable: lower the installer bound so the fixture
    // stays small, then ship a regular 1667 member over that bound.
    await runInstaller(
      "oversize",
      async () => {
        await writeFakeArchive(archivePath, INSTALL_VERSION, hostTarget, INSTALL_VERSION, {
          executableByteLength: 64
        });
      },
      /Release executable size is outside the bound/i,
      (body) => body.replace(/MAX_EXECUTABLE_BYTES=\d+/u, "MAX_EXECUTABLE_BYTES=32")
    );

    // Logical regular payloads stay under a lowered stream bound, but headers,
    // padding, and terminators push the complete decompressed tar over it.
    await runInstaller(
      "oversize-tar-stream",
      async () => {
        const executable = Buffer.alloc(16, 0);
        await writeUstarGzipArchive(
          archivePath,
          canonicalReleaseArchiveEntries(INSTALL_VERSION, hostTarget, executable)
        );
      },
      /Release archive expanded size is outside the bound/i,
      (body) => {
        const raw = ustarArchive(
          canonicalReleaseArchiveEntries(INSTALL_VERSION, hostTarget, Buffer.alloc(16, 0))
        );
        // Bound admits every regular payload (16 + small texts) but not headers.
        const logical =
          16
          + Buffer.byteLength("LICENSE\n")
          + Buffer.byteLength("NOTICE\n")
          + Buffer.byteLength("{}\n")
          + Buffer.byteLength("{}\n");
        assert.ok(logical < 512, "logical payloads fit under one block");
        assert.ok(raw.byteLength > 512, "physical stream includes metadata");
        return body
          .replace(/MAX_TAR_BYTES=\d+/u, "MAX_TAR_BYTES=512")
          .replace(/MAX_EXECUTABLE_BYTES=\d+/u, "MAX_EXECUTABLE_BYTES=256");
      }
    );

    // Oversized regular payload still rejected when the stream bound admits
    // headers but the declared executable size is fine.
    await runInstaller(
      "oversize-tar-total",
      async () => {
        const executable = Buffer.alloc(16, 0);
        const entries = canonicalReleaseArchiveEntries(
          INSTALL_VERSION,
          hostTarget,
          executable
        ).map((entry) => {
          if (entry.name !== `${stem}/LICENSE`) return entry;
          return {
            name: entry.name,
            type: "0" as const,
            mode: 0o644,
            body: Buffer.alloc(128, 0x41)
          };
        });
        await writeUstarGzipArchive(archivePath, entries);
      },
      /Release archive expanded size is outside the bound/i,
      (body) =>
        body
          .replace(/MAX_TAR_BYTES=\d+/u, "MAX_TAR_BYTES=64")
          .replace(/MAX_EXECUTABLE_BYTES=\d+/u, "MAX_EXECUTABLE_BYTES=256")
    );

    // Valid tar bytes under a gzip stream with a bad CRC must not pass.
    await runInstaller(
      "gzip-bad-crc",
      async () => {
        const executable = Buffer.from(releaseStub(INSTALL_VERSION, hostTarget));
        await writeUstarGzipArchive(
          archivePath,
          canonicalReleaseArchiveEntries(INSTALL_VERSION, hostTarget, executable)
        );
        const raw = Buffer.from(await readFile(archivePath));
        assert.ok(raw.byteLength > 8, "gzip trailer present");
        const corrupt = Buffer.from(raw);
        const crcByte = corrupt.byteLength - 5;
        corrupt[crcByte] = (corrupt[crcByte] ?? 0) ^ 0xff;
        await writeFile(archivePath, corrupt);
      },
      /Archive decompression failed/i
    );

    // Physical directory header with whitespace after the stem: parser line is
    // not exactly "dir $stem". Must reject and leave prefix empty.
    await runInstaller(
      "dir-whitespace",
      async () => {
        const executable = Buffer.from(releaseStub(INSTALL_VERSION, hostTarget));
        const entries = canonicalReleaseArchiveEntries(
          INSTALL_VERSION,
          hostTarget,
          executable
        ).map((entry) => {
          if (entry.type !== "5") return entry;
          return {
            name: `${stem} anything/`,
            type: "5" as const,
            mode: 0o755
          };
        });
        await writeUstarGzipArchive(archivePath, entries);
      },
      /Archive (?:contains|layout)/i
    );
    const whitespacePrefix = path.join(root, "prefix-dir-whitespace");
    await assert.rejects(
      readFile(path.join(whitespacePrefix, "1667")),
      /ENOENT/i,
      "dir-whitespace must not install the executable"
    );
  }
);

test(
  "Shell Installer accepts host system tar packed with workflow ustar flags",
  { timeout: 60_000 },
  async (t) => {
    const detectedTarget = hostShellInstallerTarget();
    if (detectedTarget === null) {
      t.skip("Host cannot run the POSIX Shell Installer");
      return;
    }
    const hostTarget: BuiltArtifactTarget = detectedTarget;
    const harness = await createInstallerArchiveHarness(
      t,
      hostTarget,
      "install-host-ustar"
    );
    const { root, stem } = harness;

    // Exact six-member layout the release workflows stage before packing.
    const stage = path.join(root, "stage");
    const stemDir = path.join(stage, stem);
    await mkdir(stemDir, { recursive: true, mode: 0o755 });
    await writeFile(
      path.join(stemDir, "1667"),
      releaseStub(INSTALL_VERSION, hostTarget),
      { mode: 0o755 }
    );
    await writeFile(path.join(stemDir, "LICENSE"), "LICENSE\n", { mode: 0o644 });
    await writeFile(path.join(stemDir, "NOTICE"), "NOTICE\n", { mode: 0o644 });
    await writeFile(path.join(stemDir, "build-manifest.json"), "{}\n", { mode: 0o644 });
    await writeFile(path.join(stemDir, "sbom.spdx.json"), "{}\n", { mode: 0o644 });

    const { stdout, prefix } = await harness.run(
      "host-ustar",
      async (archivePath) => {
        // Exact producer flags from release-npm.yml.
        await execFileAsync(
          "tar",
          ["--format=ustar", "-czf", archivePath, "-C", stage, stem],
          { env: { ...process.env, COPYFILE_DISABLE: "1" } }
        );
      }
    );
    assert.match(stdout, new RegExp(`Installed 1667 ${INSTALL_VERSION} \\(beta\\)`));
    const installed = await readFile(path.join(prefix, "1667"), "utf8");
    assert.match(installed, /productVersion/);
  }
);

test(
  "Shell Installer rejects huge declared ustar size before extraction",
  { timeout: 60_000 },
  async (t) => {
    const detectedTarget = hostShellInstallerTarget();
    if (detectedTarget === null) {
      t.skip("Host cannot run the POSIX Shell Installer");
      return;
    }
    const hostTarget: BuiltArtifactTarget = detectedTarget;
    const harness = await createInstallerArchiveHarness(
      t,
      hostTarget,
      "install-extract-huge"
    );
    await harness.reject(
      "huge-size",
      async (archivePath) => {
        // Header claims a body larger than the remaining stream: truncated.
        const entries = canonicalReleaseArchiveEntries(
          INSTALL_VERSION,
          hostTarget,
          Buffer.from(releaseStub(INSTALL_VERSION, hostTarget))
        );
        const raw = Buffer.from(ustarArchive(entries));
        const noticeName = `${harness.stem}/NOTICE`;
        let noticeHeader = -1;
        for (let offset = 0; offset + 512 <= raw.byteLength; offset += 512) {
          const name = raw
            .subarray(offset, offset + 100)
            .toString("utf8")
            .replace(/\0.*$/u, "");
          if (name === noticeName) {
            noticeHeader = offset;
            break;
          }
        }
        assert.ok(noticeHeader >= 0, "NOTICE header present");
        const header = Buffer.from(raw.subarray(noticeHeader, noticeHeader + 512));
        // 200000 octal = 65536 decimal body claim; archive has only a few blocks left.
        header.write("00000200000\0", 124, 12, "ascii");
        header.fill(0x20, 148, 156);
        let checksum = 0;
        for (const byte of header) checksum += byte;
        header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
        header.copy(raw, noticeHeader);
        const { gzipSync } = await import("node:zlib");
        await writeFile(archivePath, gzipSync(raw));
      },
      /truncated or not block-aligned|expanded size is outside the bound/i
    );
  }
);
