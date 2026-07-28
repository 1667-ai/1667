import {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "../shared/release-targets.js";
import { isSemVer } from "../shared/semver.js";

/**
 * Targets that are built and verified on every change but are not distributed
 * yet. A hold is a distribution decision, not a support decision: the target
 * keeps its place in the release matrix, keeps building in CI, and returns to
 * the published set by leaving this list. Nothing else in the release tooling
 * may carry a target list of its own, so un-holding a target is one deletion
 * here and no edit anywhere downstream.
 *
 * `windows-x64` is held today. Its compiled prompt-tokenizer smoke hangs often
 * enough on the hosted Windows runners to make a published build a coin flip,
 * and a distributed executable that nothing installs is worse than one a user
 * builds from source with the failure in front of them.
 */
export const PUBLICATION_HOLDS = Object.freeze(["windows-x64"] as const);

export type HeldReleaseTarget = typeof PUBLICATION_HOLDS[number];

export function heldFromPublication(target: PackagedArtifactTarget): boolean {
  return (PUBLICATION_HOLDS as readonly string[]).includes(target);
}

/** Every target this repository distributes, in the canonical matrix order. */
export const PUBLISHED_RELEASE_TARGETS: readonly PackagedArtifactTarget[] = Object.freeze(
  PACKAGED_ARTIFACT_TARGETS.filter((target) => !heldFromPublication(target))
);

/** Every target CI builds, held or not. */
export const BUILT_ARTIFACT_TARGETS: readonly PackagedArtifactTarget[] = PACKAGED_ARTIFACT_TARGETS;

export function assertPublishedReleaseTarget(target: PackagedArtifactTarget): void {
  if (heldFromPublication(target)) {
    throw new Error(`Release target ${target} is held from publication`);
  }
}

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
export function releaseArchiveStem(version: string, target: PackagedArtifactTarget): string {
  assertPublishedReleaseTarget(target);
  if (!isSemVer(version)) throw new Error(`Release archive needs a SemVer version, not ${version}`);
  return `1667_${version}_${target}`;
}

export function releaseArchiveFileName(version: string, target: PackagedArtifactTarget): string {
  return `${releaseArchiveStem(version, target)}.tar.gz`;
}

/** The one asset that lists the others, so it can never list itself. */
export const RELEASE_CHECKSUMS_FILE = "checksums.txt" as const;
