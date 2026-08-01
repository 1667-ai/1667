/**
 * Dual conformance corpus for the canonical TypeScript ustar parser and the
 * generated POSIX Shell Installer parser.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { releaseArchiveMemberPaths } from "../scripts/release-archive-layout.js";
import {
  MAX_RELEASE_ARTIFACT_ENTRIES,
  MAX_RELEASE_ARTIFACT_TAR_BYTES,
  MAX_RELEASE_TOTAL_FILE_BYTES
} from "../shared/release-artifact-bounds.js";
import {
  UstarStreamParser,
  type UstarEntry,
  type UstarEntryType
} from "../shared/release-ustar.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import {
  INSTALL_VERSION,
  canonicalReleaseArchiveEntries,
  hostShellInstallerTarget,
  releaseStub,
  ustarArchive,
  type UstarFixtureEntry
} from "./release-install-script-fixture.js";
import { createInstallerArchiveHarness } from "./release-install-script-harness.js";
import { writeUstarChecksum } from "./ustar-fixture.js";

interface RejectedCorpusCase {
  readonly name: string;
  readonly raw: Buffer;
  readonly maximumTotalFileBytes?: number;
}

test(
  "TypeScript and Shell Installer ustar parsers accept and reject one physical corpus",
  { timeout: 60_000 },
  async (t) => {
    const detectedTarget = hostShellInstallerTarget();
    if (detectedTarget === null) {
      t.skip("Host cannot run the POSIX Shell Installer");
      return;
    }
    const target: BuiltArtifactTarget = detectedTarget;
    const harness = await createInstallerArchiveHarness(
      t,
      target,
      "install-ustar-conformance"
    );
    const canonicalEntries = canonicalReleaseArchiveEntries(
      INSTALL_VERSION,
      target,
      Buffer.from(releaseStub(INSTALL_VERSION, target))
    );
    const canonical = ustarArchive(canonicalEntries);

    validateCanonicalReleaseUstar(canonical, target);
    const accepted = await harness.run("canonical", async (archivePath) => {
      await writeFile(archivePath, gzipSync(canonical));
    });
    assert.match(accepted.stdout, /Installed 1667 1\.2\.3 \(beta\)/);

    for (const sample of rejectedCorpus(canonicalEntries, canonical)) {
      assert.throws(
        () => validateCanonicalReleaseUstar(
          sample.raw,
          target,
          sample.maximumTotalFileBytes
        ),
        Error,
        `TypeScript parser accepted ${sample.name}`
      );
      await harness.reject(
        sample.name,
        async (archivePath) => writeFile(archivePath, gzipSync(sample.raw)),
        /Archive (?:contains|has|layout|structure)|Release archive/i,
        sample.maximumTotalFileBytes === undefined
          ? undefined
          : (body) => body.replace(
            /MAX_FILE_BYTES=\d+/u,
            `MAX_FILE_BYTES=${sample.maximumTotalFileBytes}`
          )
      );
    }
  }
);

function validateCanonicalReleaseUstar(
  raw: Buffer,
  target: BuiltArtifactTarget,
  maximumTotalFileBytes = MAX_RELEASE_TOTAL_FILE_BYTES
): void {
  const entries: UstarEntry[] = [];
  const parser = new UstarStreamParser({
    maximumExpandedBytes: MAX_RELEASE_ARTIFACT_TAR_BYTES,
    maximumEntries: MAX_RELEASE_ARTIFACT_ENTRIES,
    maximumTotalFileBytes,
    fail: (message, cause) => new Error(message, { cause }),
    onEntryStart: () => {},
    onBody: () => {},
    onEntryEnd: (entry) => entries.push(entry)
  });
  for (let offset = 0; offset < raw.byteLength; offset += 137) {
    parser.consume(raw.subarray(offset, Math.min(offset + 137, raw.byteLength)));
  }
  parser.finish();
  const expectedPaths = releaseArchiveMemberPaths(target, INSTALL_VERSION);
  const expected = expectedPaths.map((path, index) => {
    const type: UstarEntryType = index === 0 ? "directory" : "file";
    return { path, type };
  });
  assert.deepEqual(
    entries.map(({ path, type }) => ({ path, type })),
    expected,
    "archive layout differs from the generated release member inventory"
  );
}

function rejectedCorpus(
  canonicalEntries: readonly UstarFixtureEntry[],
  canonical: Buffer
): readonly RejectedCorpusCase[] {
  const stem = canonicalEntries[0]!.name.replace(/\/$/u, "");
  const executable = canonicalEntries[1]!;
  const noticeName = `${stem}/NOTICE`;
  const extensionBody = Buffer.from("22 mtime=1719792000.0\n");
  const extensions = [
    ["pax-local", "x"],
    ["pax-global", "g"],
    ["gnu-long-name", "L"],
    ["gnu-long-link", "K"]
  ] as const;
  const physicalTypes = [
    ["hard-link", "1"],
    ["symbolic-link", "2"],
    ["character-device", "3"],
    ["block-device", "4"],
    ["fifo", "6"]
  ] as const;
  const cases: RejectedCorpusCase[] = extensions.map(([name, type]) => ({
    name,
    raw: ustarArchive([
      canonicalEntries[0]!,
      {
        name: `PhysicalHeader/${name}`,
        type,
        mode: 0o644,
        body: extensionBody
      },
      ...canonicalEntries.slice(1)
    ])
  }));
  cases.push(...physicalTypes.map(([name, type]) => ({
    name,
    raw: ustarArchive(replaceEntry(canonicalEntries, noticeName, {
      name: noticeName,
      type,
      mode: 0o644,
      linkname: type === "1" || type === "2" ? `${stem}/LICENSE` : undefined,
      devmajor: type === "3" || type === "4" ? 1 : undefined,
      devminor: type === "3" || type === "4" ? 3 : undefined
    }))
  })));
  cases.push(
    {
      name: "traversal-path",
      raw: ustarArchive(replaceEntry(canonicalEntries, noticeName, {
        name: `${stem}/../NOTICE`,
        type: "0",
        mode: 0o644,
        body: Buffer.from("NOTICE\n")
      }))
    },
    {
      name: "duplicate-path",
      raw: ustarArchive([...canonicalEntries, canonicalEntries[2]!])
    },
    {
      name: "extra-path",
      raw: ustarArchive([
        ...canonicalEntries,
        {
          name: `${stem}/EXTRA`,
          type: "0",
          mode: 0o644,
          body: Buffer.from("extra\n")
        }
      ])
    },
    {
      name: "bad-checksum",
      raw: corruptChecksum(canonical)
    },
    {
      name: "base-256-size",
      raw: patchHeader(canonical, noticeName, (header) => {
        header.fill(0, 124, 136);
        header[124] = 0x80;
      })
    },
    {
      name: "base-256-mode",
      raw: patchHeader(canonical, noticeName, (header) => {
        header.fill(0, 100, 108);
        header[100] = 0x80;
      })
    },
    {
      name: "noncanonical-mode",
      raw: patchHeader(canonical, noticeName, (header) => {
        header.write("000644\0x", 100, 8, "ascii");
      })
    },
    {
      name: "truncated-body",
      raw: patchHeader(canonical, noticeName, (header) => {
        header.write("00000200000\0", 124, 12, "ascii");
      })
    },
    {
      name: "nonzero-padding",
      raw: corruptEntryPadding(canonical, executable)
    },
    {
      name: "one-terminator",
      raw: ustarArchive(canonicalEntries, { terminatorBlocks: 1 })
    },
    {
      name: "trailing-junk",
      raw: ustarArchive(canonicalEntries, {
        trailingBytes: Buffer.concat([Buffer.from([1]), Buffer.alloc(511)])
      })
    },
    {
      name: "cumulative-file-bytes",
      raw: canonical,
      maximumTotalFileBytes: 64
    }
  );
  return cases;
}

function replaceEntry(
  entries: readonly UstarFixtureEntry[],
  name: string,
  replacement: UstarFixtureEntry
): UstarFixtureEntry[] {
  return entries.map((entry) => entry.name === name ? replacement : entry);
}

function corruptChecksum(raw: Buffer): Buffer {
  const result = Buffer.from(raw);
  result[0] = result[0]! ^ 1;
  return result;
}

function patchHeader(
  raw: Buffer,
  name: string,
  mutate: (header: Buffer) => void
): Buffer {
  const result = Buffer.from(raw);
  const offset = findHeader(result, name);
  const header = Buffer.from(result.subarray(offset, offset + 512));
  mutate(header);
  writeUstarChecksum(header);
  header.copy(result, offset);
  return result;
}

function corruptEntryPadding(raw: Buffer, entry: UstarFixtureEntry): Buffer {
  const result = Buffer.from(raw);
  const body = entry.body ?? Buffer.alloc(0);
  assert.notEqual(body.byteLength % 512, 0, "fixture entry needs padding");
  const headerOffset = findHeader(result, entry.name);
  result[headerOffset + 512 + body.byteLength] = 1;
  return result;
}

function findHeader(raw: Buffer, name: string): number {
  for (let offset = 0; offset + 512 <= raw.byteLength; offset += 512) {
    const candidate = raw
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/u, "");
    if (candidate === name) return offset;
  }
  throw new Error(`Ustar fixture has no header for ${name}`);
}
