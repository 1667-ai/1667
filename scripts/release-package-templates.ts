import {
  type BuiltArtifactTarget
} from "../shared/build-identity.js";
import {
  createPackageBuildManifest,
  type PackageBuildEvidence,
  type PackageBuildManifest
} from "../shared/package-build-manifest.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import {
  releaseIdentityForTarget,
  type ReleaseBuildIdentity,
  type ReleaseBuildIdentitySet
} from "./release-identity.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson,
  type ReleaseLauncherPackageJson,
  type ReleasePlatformPackageJson
} from "./release-package-manifests.js";

export type ReleasePackageBuildManifest<
  ArtifactTarget extends "launcher" | BuiltArtifactTarget
> = PackageBuildManifest<ArtifactTarget>;

export type ReleasePackageBuildEvidence = PackageBuildEvidence;

export interface ReleaseLauncherPackageTemplate {
  kind: "launcher";
  packageManifest: ReleaseLauncherPackageJson;
  buildManifest: ReleasePackageBuildManifest<"launcher">;
  buildIdentity: null;
}

export interface ReleasePlatformPackageTemplate {
  kind: "platform";
  packageManifest: ReleasePlatformPackageJson;
  buildManifest: ReleasePackageBuildManifest<BuiltArtifactTarget>;
  buildIdentity: ReleaseBuildIdentity;
}

export type ReleasePackageTemplate =
  | ReleaseLauncherPackageTemplate
  | ReleasePlatformPackageTemplate;

export interface ReleasePackageTemplates {
  launcher: ReleaseLauncherPackageTemplate;
  platforms: readonly ReleasePlatformPackageTemplate[];
}

/**
 * Deterministic inputs for the pack step; no template contains npm scripts.
 * This batch factory excludes held targets. The platform factory below accepts
 * a held target for local verification.
 */
export function createReleasePackageTemplates(
  identities: ReleaseBuildIdentitySet
): ReleasePackageTemplates {
  const launcher = createReleaseLauncherPackageTemplate(identities);
  const platforms = PUBLISHED_ARTIFACT_TARGETS.map((target) => {
    return createReleasePlatformPackageTemplate(identities, target);
  });
  return Object.freeze({ launcher, platforms: Object.freeze(platforms) });
}

export function createReleaseLauncherPackageTemplate(
  identities: ReleaseBuildIdentitySet
): ReleaseLauncherPackageTemplate {
  const version = identities.source.productVersion;
  return Object.freeze({
    kind: "launcher" as const,
    packageManifest: releasePackageJson(createReleaseLauncherManifest(version)),
    buildManifest: createReleasePackageBuildManifest(
      identities.source,
      RELEASE_LAUNCHER_PACKAGE,
      "launcher"
    ),
    buildIdentity: null
  });
}

export function createReleasePlatformPackageTemplate(
  identities: ReleaseBuildIdentitySet,
  target: BuiltArtifactTarget
): ReleasePlatformPackageTemplate {
  const manifest = createReleasePlatformManifest(
    target,
    identities.source.productVersion
  );
  return Object.freeze({
    kind: "platform" as const,
    packageManifest: releasePackageJson(manifest),
    buildManifest: createReleasePackageBuildManifest(
      identities.source,
      manifest.name,
      target
    ),
    buildIdentity: releaseIdentityForTarget(identities, target)
  });
}

export function createReleasePackageBuildManifest<
  ArtifactTarget extends "launcher" | BuiltArtifactTarget
>(
  evidence: ReleasePackageBuildEvidence,
  packageName: string,
  artifactTarget: ArtifactTarget
): ReleasePackageBuildManifest<ArtifactTarget> {
  return createPackageBuildManifest(evidence, packageName, artifactTarget);
}
