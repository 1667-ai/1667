export const RELEASE_LAUNCHER_PACKAGE = "@1667-ai/cli" as const;

export interface ReleaseTargetDescriptor {
  readonly artifactTarget: string;
  readonly packageName: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly libc: "glibc" | null;
  readonly executable: "bin/1667" | "bin/1667.exe";
}

/** Canonical ordered package/runtime policy for every native release target.
 *
 * windows-x64 is excluded while its native DACL and reparse-safe adapters are
 * incomplete and no Windows CI or developer machine can execute a candidate.
 * The descriptor type keeps win32 so restoring the target is one entry. Until
 * then releaseTargetForRuntime returns null on Windows and the launcher
 * refuses by name rather than shipping something unverifiable. */
export const RELEASE_TARGETS = Object.freeze([
  Object.freeze({
    artifactTarget: "darwin-arm64",
    packageName: "@1667-ai/darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    libc: null,
    executable: "bin/1667"
  }),
  Object.freeze({
    artifactTarget: "darwin-x64",
    packageName: "@1667-ai/darwin-x64",
    platform: "darwin",
    arch: "x64",
    libc: null,
    executable: "bin/1667"
  }),
  Object.freeze({
    artifactTarget: "linux-arm64",
    packageName: "@1667-ai/linux-arm64",
    platform: "linux",
    arch: "arm64",
    libc: "glibc",
    executable: "bin/1667"
  }),
  Object.freeze({
    artifactTarget: "linux-x64",
    packageName: "@1667-ai/linux-x64",
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    executable: "bin/1667"
  })
] as const satisfies readonly ReleaseTargetDescriptor[]);

export type PackagedArtifactTarget = typeof RELEASE_TARGETS[number]["artifactTarget"];
export type ReleasePlatformPackage = typeof RELEASE_TARGETS[number]["packageName"];
export type CanonicalReleaseTarget = typeof RELEASE_TARGETS[number];

export const PACKAGED_ARTIFACT_TARGETS = Object.freeze(
  RELEASE_TARGETS.map((descriptor) => descriptor.artifactTarget)
) as readonly [PackagedArtifactTarget, ...PackagedArtifactTarget[]];
export const RELEASE_PLATFORM_PACKAGES: readonly ReleasePlatformPackage[] = Object.freeze(
  RELEASE_TARGETS.map((descriptor) => descriptor.packageName)
);
export const RELEASE_PACKAGE_COUNT = RELEASE_TARGETS.length + 1;

export function releaseTargetForArtifact(
  artifactTarget: PackagedArtifactTarget
): CanonicalReleaseTarget {
  const descriptor = RELEASE_TARGETS.find((candidate) => {
    return candidate.artifactTarget === artifactTarget;
  });
  if (descriptor === undefined) {
    throw new Error(`Unsupported release artifact target ${artifactTarget}`);
  }
  return descriptor;
}

export function releaseTargetForPackage(
  packageName: string
): CanonicalReleaseTarget | null {
  return RELEASE_TARGETS.find((candidate) => candidate.packageName === packageName) ?? null;
}

export function releaseTargetForRuntime(
  platform: string,
  arch: string
): CanonicalReleaseTarget | null {
  return RELEASE_TARGETS.find((candidate) => {
    return candidate.platform === platform && candidate.arch === arch;
  }) ?? null;
}

export function releasePlatformDependencyGraph(
  version: string
): Readonly<Record<ReleasePlatformPackage, string>> {
  return Object.freeze(Object.fromEntries(
    RELEASE_TARGETS.map((descriptor) => [descriptor.packageName, version])
  ) as Record<ReleasePlatformPackage, string>);
}
