import {
  RELEASE_LAUNCHER_PACKAGE,
  releasePlatformDependencyGraph,
  releaseTargetForArtifact,
  type PackagedArtifactTarget,
  type ReleasePlatformPackage
} from "../shared/release-targets.js";

export interface ReleaseLauncherManifest {
  kind: "launcher";
  name: typeof RELEASE_LAUNCHER_PACKAGE;
  version: string;
  private: false;
  type: "module";
  bin: Readonly<{ "1667": "bin/1667.js" }>;
  files: readonly ["bin/1667.js", "build-manifest.json", "sbom.spdx.json"];
  optionalDependencies: Readonly<Record<ReleasePlatformPackage, string>>;
  publishConfig: Readonly<{ access: "public" }>;
}

export interface ReleasePlatformManifest {
  kind: "platform";
  name: ReleasePlatformPackage;
  version: string;
  private: false;
  os: readonly ["darwin" | "linux" | "win32"];
  cpu: readonly ["arm64" | "x64"];
  files: readonly [string, "build-manifest.json", "sbom.spdx.json"];
  publishConfig: Readonly<{ access: "public" }>;
  target: PackagedArtifactTarget;
}

export type ReleasePackageManifest = ReleaseLauncherManifest | ReleasePlatformManifest;
export type ReleaseLauncherPackageJson = Omit<ReleaseLauncherManifest, "kind">;
export type ReleasePlatformPackageJson = Omit<ReleasePlatformManifest, "kind" | "target">;
export type ReleasePackageJson = ReleaseLauncherPackageJson | ReleasePlatformPackageJson;

export function createReleaseLauncherManifest(version: string): ReleaseLauncherManifest {
  return Object.freeze({
    kind: "launcher" as const,
    name: RELEASE_LAUNCHER_PACKAGE,
    version,
    private: false as const,
    type: "module" as const,
    bin: Object.freeze({ "1667": "bin/1667.js" as const }),
    files: Object.freeze([
      "bin/1667.js",
      "build-manifest.json",
      "sbom.spdx.json"
    ] as const),
    optionalDependencies: releasePlatformDependencyGraph(version),
    publishConfig: Object.freeze({ access: "public" as const })
  });
}

export function createReleasePlatformManifest(
  target: PackagedArtifactTarget,
  version: string
): ReleasePlatformManifest {
  const descriptor = releaseTargetForArtifact(target);
  return Object.freeze({
    kind: "platform" as const,
    name: descriptor.packageName,
    version,
    private: false as const,
    os: Object.freeze([descriptor.platform] as const),
    cpu: Object.freeze([descriptor.arch] as const),
    files: Object.freeze([
      descriptor.executable,
      "build-manifest.json",
      "sbom.spdx.json"
    ] as const),
    publishConfig: Object.freeze({ access: "public" as const }),
    target
  });
}

/** Removes validation-only discriminants from an immutable package.json value. */
export function releasePackageJson(
  manifest: ReleaseLauncherManifest
): ReleaseLauncherPackageJson;
export function releasePackageJson(
  manifest: ReleasePlatformManifest
): ReleasePlatformPackageJson;
export function releasePackageJson(
  manifest: ReleasePackageManifest
): ReleasePackageJson;
export function releasePackageJson(
  manifest: ReleasePackageManifest
): ReleasePackageJson {
  if (manifest.kind === "platform") {
    const { kind: _kind, target: _target, ...packageJson } = manifest;
    return Object.freeze(packageJson);
  }
  const { kind: _kind, ...packageJson } = manifest;
  return Object.freeze(packageJson);
}
