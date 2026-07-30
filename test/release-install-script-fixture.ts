/** Shared fixtures for Shell Installer end-to-end tests. */
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import { releaseArchiveFileName, releaseArchiveStem } from "../scripts/release-archive.js";

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
    apiProtocolVersion: 9,
    minClientProtocolVersion: 9,
    maxClientProtocolVersion: 9
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

export async function writeFakeArchive(
  archivePath: string,
  version: string,
  target: BuiltArtifactTarget,
  embeddedVersion = version,
  options: { readonly extraEntry?: boolean; readonly symlinkEntry?: boolean } = {}
): Promise<void> {
  const stage = await mkdtemp(path.join(path.dirname(archivePath), "stage-"));
  try {
    const stem = releaseArchiveStem(version, target);
    const dir = path.join(stage, stem);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "1667"), releaseStub(embeddedVersion, target), { mode: 0o755 });
    await writeFile(path.join(dir, "LICENSE"), "LICENSE\n");
    await writeFile(path.join(dir, "NOTICE"), "NOTICE\n");
    await writeFile(path.join(dir, "build-manifest.json"), "{}\n");
    await writeFile(path.join(dir, "sbom.spdx.json"), "{}\n");
    if (options.extraEntry) {
      await writeFile(path.join(dir, "EXTRA"), "extra\n");
    }
    if (options.symlinkEntry) {
      await symlink("LICENSE", path.join(dir, "LICENSE.link"));
    }
    await execFileAsync("tar", ["-czf", archivePath, "-C", stage, stem]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
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
