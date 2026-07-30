#!/usr/bin/env -S node --import tsx

import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallChannel } from "../shared/install-ownership-record.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";
import { isSemVer, parseSemVer } from "../shared/semver.js";
import { releaseArchiveFileName } from "./release-archive.js";
import { sha256Digest } from "./release-boundary-validation.js";
import { publishedReleaseArchiveMemberRelLayout } from "./release-archive-layout.js";
import { shellInstallerBody } from "./release-install-script-body.js";

export const INSTALL_SCRIPT_CHANNELS = ["stable", "beta"] as const;
export type InstallScriptChannel = InstallChannel;

export interface ReleaseArchiveDigest {
  readonly target: PublishedArtifactTarget;
  readonly fileName: string;
  readonly sha256: string;
}

export interface RenderInstallScriptInput {
  readonly version: string;
  readonly channel: InstallScriptChannel;
  readonly repository: string;
  readonly archives: readonly ReleaseArchiveDigest[];
  readonly assetBaseUrl?: string;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/;

export function installScriptChannelsForVersion(version: string): readonly InstallScriptChannel[] {
  if (!isSemVer(version)) throw new Error(`Install script needs a SemVer version, not ${version}`);
  const parsed = parseSemVer(version)!;
  return parsed.prerelease.length === 0 ? ["beta", "stable"] : ["beta"];
}

export function installScriptFileName(channel: InstallScriptChannel): string {
  return `install-${channel}.sh`;
}

export function normalizeArchiveDigests(
  version: string,
  digests: Readonly<Record<string, string>>
): readonly ReleaseArchiveDigest[] {
  if (!isSemVer(version)) throw new Error(`Install script needs a SemVer version, not ${version}`);
  const archives: ReleaseArchiveDigest[] = [];
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const fileName = releaseArchiveFileName(version, target);
    const sha256 = digests[fileName] ?? digests[target];
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
      throw new Error(`Install script is missing a SHA-256 digest for ${fileName}`);
    }
    archives.push(Object.freeze({
      target,
      fileName,
      sha256: sha256Digest(sha256, fileName)
    }));
  }
  const byName = archives.every((archive) => digests[archive.fileName] !== undefined);
  const byTarget = archives.every((archive) => digests[archive.target] !== undefined);
  if (!byName && !byTarget) {
    throw new Error("Install script digest map has unexpected keys");
  }
  if (byName && Object.keys(digests).some((key) => !archives.some((a) => a.fileName === key))) {
    throw new Error("Install script digest map has unexpected keys");
  }
  if (byTarget && Object.keys(digests).some((key) => !archives.some((a) => a.target === key))) {
    throw new Error("Install script digest map has unexpected keys");
  }
  return Object.freeze(archives);
}

export function renderInstallScript(input: RenderInstallScriptInput): string {
  if (!isSemVer(input.version)) {
    throw new Error(`Install script needs a SemVer version, not ${input.version}`);
  }
  if (input.channel !== "stable" && input.channel !== "beta") {
    throw new Error("Install script channel must be stable or beta");
  }
  if (input.channel === "stable" && parseSemVer(input.version)!.prerelease.length > 0) {
    throw new Error("install-stable.sh is only valid for a non-prerelease version");
  }
  if (!REPOSITORY.test(input.repository)) {
    throw new Error("Install script repository is invalid");
  }
  if (input.archives.length !== PUBLISHED_ARTIFACT_TARGETS.length) {
    throw new Error("Install script must cover every published release target");
  }
  const byTarget = new Map(input.archives.map((archive) => [archive.target, archive]));
  const digestLines: string[] = [];
  const nameLines: string[] = [];
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const archive = byTarget.get(target);
    if (archive === undefined) throw new Error(`Install script is missing ${target}`);
    if (archive.fileName !== releaseArchiveFileName(input.version, target)) {
      throw new Error(`Install script archive name is wrong for ${target}`);
    }
    sha256Digest(archive.sha256, archive.fileName);
    digestLines.push(`    ${target}) digest='${archive.sha256}' ;;`);
    nameLines.push(`    ${target}) archive='${archive.fileName}' ;;`);
  }
  const defaultBase = `https://github.com/${input.repository}/releases/download/v${input.version}`;
  const assetBase = assertSafeAssetBaseUrl(input.assetBaseUrl ?? defaultBase);
  // One portable installer: every published target must share this layout.
  const memberRelPaths = publishedReleaseArchiveMemberRelLayout(input.version);
  const executableMemberId = memberRelPaths.indexOf("1667");
  if (executableMemberId <= 0) {
    throw new Error("Install script archive layout is missing the 1667 executable");
  }
  return shellInstallerBody({
    version: input.version,
    channel: input.channel,
    repository: input.repository,
    assetBase,
    nameLines: nameLines.join("\n"),
    digestLines: digestLines.join("\n"),
    extractLayout: Object.freeze({
      memberRelPaths,
      executableMemberId
    })
  });
}

/**
 * Asset base is embedded in a single-quoted shell assignment. Reject credentials,
 * query, fragment, control characters, and single quotes. Allow production
 * HTTPS GitHub URLs and localhost HTTP bases used by installer tests.
 */
export function assertSafeAssetBaseUrl(assetBase: string): string {
  if (assetBase.length === 0 || assetBase.length > 2048) {
    throw new Error("Install script asset base URL is invalid");
  }
  // Control characters and shell single quotes cannot enter ASSET_BASE='...'.
  if (/[\u0000-\u001f\u007f']/.test(assetBase)) {
    throw new Error("Install script asset base URL contains disallowed characters");
  }
  // Explicit rejects before URL parsing so credentials/query/fragment cannot hide.
  if (/^https?:\/\/[^/]*@/u.test(assetBase)) {
    throw new Error("Install script asset base URL must not include credentials");
  }
  if (assetBase.includes("?")) {
    throw new Error("Install script asset base URL must not include a query");
  }
  if (assetBase.includes("#")) {
    throw new Error("Install script asset base URL must not include a fragment");
  }
  let url: URL;
  try {
    url = new URL(assetBase);
  } catch {
    throw new Error("Install script asset base URL is invalid");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Install script asset base URL must not include credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Install script asset base URL is invalid");
  }
  if (url.protocol === "https:") {
    if (!/^[A-Za-z0-9.-]+$/u.test(url.hostname)) {
      throw new Error("Install script asset base URL host is invalid");
    }
  } else if (url.protocol === "http:") {
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("Install script asset base URL is invalid");
    }
  } else {
    throw new Error("Install script asset base URL is invalid");
  }
  return assetBase;
}

export function renderInstallScriptsForVersion(input: {
  readonly version: string;
  readonly repository: string;
  readonly digests: Readonly<Record<string, string>>;
  readonly assetBaseUrl?: string;
}): Readonly<Record<string, string>> {
  const archives = normalizeArchiveDigests(input.version, input.digests);
  const out: Record<string, string> = {};
  for (const channel of installScriptChannelsForVersion(input.version)) {
    out[installScriptFileName(channel)] = renderInstallScript({
      version: input.version,
      channel,
      repository: input.repository,
      archives,
      assetBaseUrl: input.assetBaseUrl
    });
  }
  return Object.freeze(out);
}

export function sha256FileBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const USAGE = [
  "usage: release-install-script.ts render <version> <repository> <digest-json> <out-dir>"
].join("\n");

function runCommand(argv: readonly string[]): void {
  const [command, version, repository, digestJson, outDir] = argv;
  if (command !== "render"
    || version === undefined
    || repository === undefined
    || digestJson === undefined
    || outDir === undefined
    || argv.length !== 5) {
    throw new Error(USAGE);
  }
  const digests = JSON.parse(digestJson) as Record<string, string>;
  if (digests === null || typeof digests !== "object" || Array.isArray(digests)) {
    throw new Error("digest-json must be an object");
  }
  const scripts = renderInstallScriptsForVersion({ version, repository, digests });
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(outDir, name), body, { mode: 0o755 });
    process.stdout.write(`${name} ${sha256FileBytes(body)}\n`);
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    runCommand(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-install-script: ${message}\n`);
    process.exitCode = 1;
  }
}
