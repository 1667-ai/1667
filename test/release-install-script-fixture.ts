/** Shared fixtures for Shell Installer end-to-end tests. */
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import { releaseArchiveFileName, releaseArchiveStem } from "../scripts/release-archive.js";
import { releaseArchiveMemberPaths } from "../scripts/release-archive-layout.js";
import {
  ustarArchive,
  writeUstarGzipArchive,
  type UstarFixtureEntry
} from "./ustar-fixture.js";

export {
  ustarArchive,
  writeUstarGzipArchive,
  type UstarFixtureEntry,
  type UstarTypeFlag
} from "./ustar-fixture.js";

export const execFileAsync = promisify(execFile);
export const INSTALL_VERSION = "1.2.3";
export const INSTALL_PRE_VERSION = "1.2.3-rc.1";
export const INSTALL_REPO = "1667-ai/1667";

export function hostPublishedTarget(): BuiltArtifactTarget | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  return null;
}

/**
 * Runs a command with a real terminal on its output, so a test can exercise a
 * branch that only an interactive run reaches.
 *
 * `script(1)` cannot do this from a test: it reads terminal attributes from its
 * own stdin, which a captured child process does not have. Python's `pty`
 * module allocates the terminal itself, and needs no new dependency. The child
 * writes both streams into the terminal, so the caller reads one merged stream.
 */
export const PTY_RUNNER =
  "import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))";

export function ptyCommand(
  argv: readonly string[]
): { readonly file: string; readonly args: readonly string[] } | null {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  return { file: "python3", args: ["-c", PTY_RUNNER, ...argv] };
}

export function digestsFor(version: string) {
  return PUBLISHED_ARTIFACT_TARGETS.map((target) => Object.freeze({
    target,
    fileName: releaseArchiveFileName(version, target),
    sha256: createHash("sha256").update(`${version}:${target}`).digest("hex")
  }));
}

export function sha256File(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function releaseStub(version: string, target: BuiltArtifactTarget): string {
  const identity = {
    schemaVersion: 1,
    product: "1667",
    productVersion: version,
    buildKind: "release",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    sourceDirty: false,
    buildTimestamp: "2026-07-29T00:00:00.000Z",
    artifactTarget: target,
    apiProtocolVersion: 10,
    minClientProtocolVersion: 10,
    maxClientProtocolVersion: 10
  };
  return `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${JSON.stringify(identity)}
EOF
  exit 0
fi
echo stub
`;
}

/**
 * Canonical one-line Transaction Record bytes produced by the Shell Installer
 * renderer. Acceptance is exact byte equality against this form.
 */
export function canonicalTxnBytes(input: {
  readonly phase: string;
  readonly version: string;
  readonly channel: string;
  readonly target: string;
  readonly digest: string;
  readonly root: string;
}): string {
  return (
    `{"kind":"shell-installer","schemaVersion":1,"phase":"${input.phase}",` +
    `"version":"${input.version}","channel":"${input.channel}",` +
    `"artifactTarget":"${input.target}","archiveSha256":"${input.digest}",` +
    `"installRoot":"${input.root}","executable":"${input.root}/1667"}\n`
  );
}

export type FakeArchiveOptions = {
  readonly extraEntry?: boolean;
  readonly symlinkEntry?: boolean;
  /** When set, the 1667 member is this many zero bytes (not a probe stub). */
  readonly executableByteLength?: number;
};

export async function writeFakeArchive(
  archivePath: string,
  version: string,
  target: BuiltArtifactTarget,
  embeddedVersion = version,
  options: FakeArchiveOptions = {}
): Promise<void> {
  // Pure POSIX ustar only. System tar on macOS injects PAX and AppleDouble
  // members that the Shell Installer physical validator correctly refuses.
  const stem = releaseArchiveStem(version, target);
  const executable = options.executableByteLength === undefined
    ? Buffer.from(releaseStub(embeddedVersion, target))
    : Buffer.alloc(options.executableByteLength, 0);
  const entries: UstarFixtureEntry[] = [
    ...canonicalReleaseArchiveEntries(version, target, executable)
  ];
  if (options.extraEntry) {
    entries.push({
      name: `${stem}/EXTRA`,
      type: "0",
      mode: 0o644,
      body: Buffer.from("extra\n")
    });
  }
  if (options.symlinkEntry) {
    entries.push({
      name: `${stem}/LICENSE.link`,
      type: "2",
      mode: 0o644,
      linkname: "LICENSE"
    });
  }
  await writeUstarGzipArchive(archivePath, entries);
}

/** Canonical Release Archive entries from the production member inventory. */
export function canonicalReleaseArchiveEntries(
  version: string,
  target: BuiltArtifactTarget,
  executableBody: Buffer
): UstarFixtureEntry[] {
  const stem = releaseArchiveStem(version, target);
  const bodies = new Map<string, Buffer>([
    ["1667", executableBody],
    ["LICENSE", Buffer.from("LICENSE\n")],
    ["NOTICE", Buffer.from("NOTICE\n")],
    ["build-manifest.json", Buffer.from("{}\n")],
    ["sbom.spdx.json", Buffer.from("{}\n")]
  ]);
  return releaseArchiveMemberPaths(target, version).map((member, index) => {
    if (index === 0) return { name: `${member}/`, type: "5", mode: 0o755 };
    const relPath = member.slice(stem.length + 1);
    const body = bodies.get(relPath);
    if (body === undefined) throw new Error(`No fixture body for ${relPath}`);
    return {
      name: member,
      type: "0",
      mode: relPath === "1667" ? 0o755 : 0o644,
      body
    };
  });
}

export async function writePublishedArchives(
  archivesDir: string,
  version: string
): Promise<Record<string, string>> {
  await mkdir(archivesDir, { recursive: true });
  const digests: Record<string, string> = {};
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const fileName = releaseArchiveFileName(version, target);
    const archivePath = path.join(archivesDir, fileName);
    await writeFakeArchive(archivePath, version, target);
    digests[fileName] = sha256File(await readFile(archivePath));
  }
  return digests;
}
