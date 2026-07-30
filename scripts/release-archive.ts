import {
  releaseTargetForArtifact,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import { isSemVer } from "../shared/semver.js";

/**
 * Refuses a target the release does not distribute.
 *
 * Which targets those are is not decided here. `shared/release-targets.ts` owns
 * that policy in `heldFromPublication`, and this reads it, so un-holding a
 * target is one edit there and none in the archive tooling. A hold is a
 * distribution decision, not a support decision: a held target keeps its place
 * in the release matrix and keeps building in CI; it only has no archive.
 */
export function assertPublishedReleaseTarget(target: BuiltArtifactTarget): void {
  if (releaseTargetForArtifact(target).heldFromPublication !== null) {
    throw new Error(`Release target ${target} is held from publication`);
  }
}

/**
 * Canonical POSIX ustar stores the top-level directory entry as stem plus a
 * trailing slash in the 100-byte name field (no prefix, no PAX). The stem
 * itself must therefore fit in 99 UTF-8 bytes so every release name and
 * workflow path that goes through this function inherits the same bound.
 */
export const MAX_RELEASE_ARCHIVE_STEM_BYTES = 99;

/**
 * The name a downloaded archive carries, and the name of the single directory
 * inside it. They are the same string on purpose: `tar -xzf` then leaves one
 * directory rather than scattering an executable and four files into whatever
 * directory the download happened to land in.
 *
 * Underscores separate the three fields because two of them already contain
 * hyphens: a prerelease version is `0.1.0-rc.1` and a target is `linux-x64`.
 * With hyphens throughout, `1667-0.1.0-rc.1-linux-x64` leaves a reader — and
 * anything parsing the name — guessing where the version ends.
 * `1667_0.1.0-rc.1_linux-x64` does not.
 */
export function releaseArchiveStem(version: string, target: BuiltArtifactTarget): string {
  assertPublishedReleaseTarget(target);
  if (!isSemVer(version)) throw new Error(`Release archive needs a SemVer version, not ${version}`);
  const stem = `1667_${version}_${target}`;
  // Reject before any workflow tars or names assets: directory entry is stem + "/".
  if (Buffer.byteLength(stem, "utf8") > MAX_RELEASE_ARCHIVE_STEM_BYTES) {
    throw new Error(
      `Release archive stem exceeds the ustar name bound of ${MAX_RELEASE_ARCHIVE_STEM_BYTES} bytes: ${stem}`
    );
  }
  return stem;
}

export function releaseArchiveFileName(version: string, target: BuiltArtifactTarget): string {
  return `${releaseArchiveStem(version, target)}.tar.gz`;
}

/** The one asset that lists the others, so it can never list itself. */
export const RELEASE_CHECKSUMS_FILE = "checksums.txt" as const;
