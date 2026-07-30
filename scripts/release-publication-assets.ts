import { parseSemVer, isSemVer } from "../shared/semver.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import { releaseArchiveFileName } from "./release-archive.js";
import {
  installScriptChannelsForVersion,
  installScriptFileName
} from "./release-install-script.js";

/**
 * Exact npm pack basenames for the five release packages.
 * Scoped names become scope-name-version.tgz (slash replaced by hyphen).
 */
export function expectedNpmTarballNames(version: string): readonly string[] {
  if (!isSemVer(version)) throw new Error(`Publication assets need a SemVer version, not ${version}`);
  const launcher = npmPackBasename(RELEASE_LAUNCHER_PACKAGE, version);
  const platforms = PUBLISHED_ARTIFACT_TARGETS.map((target) => {
    return npmPackBasename(releaseTargetForArtifact(target).packageName, version);
  });
  return Object.freeze([launcher, ...platforms]);
}

export function npmPackBasename(packageName: string, version: string): string {
  // npm pack: @scope/name@version -> scope-name-version.tgz
  const unscoped = packageName.startsWith("@") ? packageName.slice(1) : packageName;
  return `${unscoped.replaceAll("/", "-")}-${version}.tgz`;
}

/**
 * Exact flat GitHub release asset basenames for one release version.
 * Includes npm tarballs, native archives, install scripts, observations,
 * SBOMs, artifact manifest, and checksums.
 */
export function expectedGitHubReleaseAssetNames(version: string): readonly string[] {
  if (!isSemVer(version)) throw new Error(`GitHub release assets need a SemVer version, not ${version}`);
  const installers = installScriptChannelsForVersion(version).map(installScriptFileName);
  const archives = PUBLISHED_ARTIFACT_TARGETS.map((target) => {
    return releaseArchiveFileName(version, target);
  });
  const observations = PUBLISHED_ARTIFACT_TARGETS.map((target) => `${target}.json`);
  const sboms = ["launcher", ...PUBLISHED_ARTIFACT_TARGETS].map((t) => `${t}.spdx.json`);
  return Object.freeze([
    "artifact-manifest.json",
    "artifact-manifest.sha256",
    "checksums.txt",
    ...installers,
    ...observations,
    ...sboms,
    ...expectedNpmTarballNames(version),
    ...archives
  ].sort());
}

/**
 * Exact nested publication directory file count after preflight.
 * Layout: artifact-manifest(+sha256), tarballs/x5, observations/x4, sboms/x5,
 * archives/x4, installers/x1or2.
 */
export function expectedPublicationFileCount(version: string): number {
  return expectedGitHubReleaseAssetNames(version).length - 1; // no checksums.txt in publication
}

/**
 * Exact file count retained under dist/packages after the launcher job
 * (no artifact-manifest files, no checksums.txt).
 */
export function expectedLauncherPackageFileCount(version: string): number {
  // tarballs + observations + sboms + archives + installers
  const installerCount = installScriptChannelsForVersion(version).length;
  const platformCount = PUBLISHED_ARTIFACT_TARGETS.length;
  return 5 + platformCount + (platformCount + 1) + platformCount + installerCount;
}

export function expectedInstallerNames(version: string): readonly string[] {
  return installScriptChannelsForVersion(version).map(installScriptFileName);
}

export function isPrereleaseVersion(version: string): boolean {
  const parsed = parseSemVer(version);
  if (parsed === null) throw new Error(`Invalid SemVer ${version}`);
  return parsed.prerelease.length > 0;
}
