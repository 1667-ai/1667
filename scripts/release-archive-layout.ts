/** Canonical file and physical member inventory for GitHub Release Archives. */
import {
  PUBLISHED_ARTIFACT_TARGETS,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import {
  assertPublishedReleaseTarget,
  releaseArchiveStem
} from "./release-archive.js";
import {
  releaseContentFileSet,
  type ReleaseContentEntry
} from "./release-content.js";
import { RELEASE_LICENSE_FILES } from "./release-package-manifests.js";

export function releaseArchiveFileSet(
  target: BuiltArtifactTarget,
  version: string
): readonly ReleaseContentEntry[] {
  assertPublishedReleaseTarget(target);
  const entries = releaseContentFileSet(target, version);
  for (const entry of entries) {
    if (entry.path.includes("/")) {
      throw new Error(`Release archive entry ${entry.path} is not at the top level`);
    }
  }
  for (const licenceFile of RELEASE_LICENSE_FILES) {
    const entry = entries.find((candidate) => candidate.path === licenceFile);
    if (entry === undefined || entry.source.kind !== "repository-file") {
      throw new Error(`Release archive for ${target} would ship without ${licenceFile}`);
    }
  }
  return entries;
}

/** Stem-relative physical member paths. Index 0 is the directory member. */
export function releaseArchiveMemberRelPaths(
  target: BuiltArtifactTarget,
  version: string
): readonly string[] {
  return Object.freeze([
    "",
    ...releaseArchiveFileSet(target, version).map((entry) => entry.path)
  ]);
}

/** Full paths of all physical ustar members, with the directory first. */
export function releaseArchiveMemberPaths(
  target: BuiltArtifactTarget,
  version: string
): readonly string[] {
  const stem = releaseArchiveStem(version, target);
  return Object.freeze(
    releaseArchiveMemberRelPaths(target, version).map((relativePath) => {
      return relativePath.length === 0 ? stem : `${stem}/${relativePath}`;
    })
  );
}

/** The uniform member layout embedded into the portable Shell Installer. */
export function publishedReleaseArchiveMemberRelLayout(
  version: string
): readonly string[] {
  const firstTarget = PUBLISHED_ARTIFACT_TARGETS[0];
  if (firstTarget === undefined) throw new Error("No published release targets");
  const expected = releaseArchiveMemberRelPaths(firstTarget, version);
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const layout = releaseArchiveMemberRelPaths(target, version);
    if (
      layout.length !== expected.length
      || layout.some((relativePath, index) => relativePath !== expected[index])
    ) {
      throw new Error(`Published release archive member layout differs for ${target}`);
    }
  }
  return expected;
}
