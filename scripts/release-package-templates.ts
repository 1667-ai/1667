import {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "../shared/build-identity.js";
import {
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import {
  releaseIdentityForTarget,
  type ReleaseBuildIdentity,
  type ReleaseIdentitySet
} from "./release-identity.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson,
  type ReleaseLauncherPackageJson,
  type ReleasePlatformPackageJson
} from "./release-package-manifests.js";

export interface ReleasePackageBuildManifest<
  ArtifactTarget extends "launcher" | PackagedArtifactTarget
> {
  schemaVersion: 1;
  product: "1667";
  productVersion: string;
  sourceCommit: string;
  buildTimestamp: string;
  packageName: string;
  artifactTarget: ArtifactTarget;
}

export interface ReleasePackageBuildEvidence {
  productVersion: string;
  sourceCommit: string;
  buildTimestamp: string;
}

export interface ReleaseLauncherPackageTemplate {
  kind: "launcher";
  packageManifest: ReleaseLauncherPackageJson;
  buildManifest: ReleasePackageBuildManifest<"launcher">;
  buildIdentity: null;
}

export interface ReleasePlatformPackageTemplate {
  kind: "platform";
  packageManifest: ReleasePlatformPackageJson;
  buildManifest: ReleasePackageBuildManifest<PackagedArtifactTarget>;
  buildIdentity: ReleaseBuildIdentity;
}

export type ReleasePackageTemplate =
  | ReleaseLauncherPackageTemplate
  | ReleasePlatformPackageTemplate;

export interface ReleasePackageTemplates {
  launcher: ReleaseLauncherPackageTemplate;
  platforms: readonly ReleasePlatformPackageTemplate[];
}

/** Deterministic inputs for the pack step; no template contains npm scripts. */
export function createReleasePackageTemplates(
  identities: ReleaseIdentitySet
): ReleasePackageTemplates {
  const version = identities.evidence.productVersion;
  const launcher = Object.freeze({
    kind: "launcher" as const,
    packageManifest: releasePackageJson(createReleaseLauncherManifest(version)),
    buildManifest: createReleasePackageBuildManifest(
      identities.evidence,
      RELEASE_LAUNCHER_PACKAGE,
      "launcher"
    ),
    buildIdentity: null
  });
  const platforms = PACKAGED_ARTIFACT_TARGETS.map((target) => {
    const manifest = createReleasePlatformManifest(target, version);
    return Object.freeze({
      kind: "platform" as const,
      packageManifest: releasePackageJson(manifest),
      buildManifest: createReleasePackageBuildManifest(
        identities.evidence,
        manifest.name,
        target
      ),
      buildIdentity: releaseIdentityForTarget(identities, target)
    });
  });
  return Object.freeze({ launcher, platforms: Object.freeze(platforms) });
}

export function createReleasePackageBuildManifest<
  ArtifactTarget extends "launcher" | PackagedArtifactTarget
>(
  evidence: ReleasePackageBuildEvidence,
  packageName: string,
  artifactTarget: ArtifactTarget
): ReleasePackageBuildManifest<ArtifactTarget> {
  return Object.freeze({
    schemaVersion: 1 as const,
    product: "1667" as const,
    productVersion: evidence.productVersion,
    sourceCommit: evidence.sourceCommit,
    buildTimestamp: evidence.buildTimestamp,
    packageName,
    artifactTarget
  });
}
