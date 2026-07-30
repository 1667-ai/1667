export const RELEASE_LAUNCHER_PACKAGE = "@1667-ai/cli" as const;

/** Where a user sent away from the registry gets the source that does build. */
export const RELEASE_SOURCE_URL = "https://github.com/1667-ai/1667" as const;

export interface ReleaseTargetDescriptor {
  readonly artifactTarget: string;
  readonly packageName: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly libc: "glibc" | null;
  readonly executable: "bin/1667" | "bin/1667.exe";
  readonly minimumCpuFeature: "sse4.2" | null;
  readonly minimumMacosVersion: "13.0" | null;
  readonly minimumGlibcVersion: "2.17" | null;
  /**
   * Why this target is not published, or null when it ships. The string is
   * shown to a user of that platform, so it has to say what is true of the
   * target today — including whether anything still builds it.
   */
  readonly heldFromPublication: string | null;
}

/**
 * Canonical ordered package/runtime policy for every native release target.
 *
 * Membership here defines a native release target and nothing more. It does not
 * promise that CI compiles the target on every change: it no longer does for
 * every member, and the `heldFromPublication` string on the target concerned is
 * where that is stated rather than left for a reader to assume. Publication is
 * the narrower question that same field answers, and every consumer has to pick
 * one of the two sets — a target that is not published belongs in the launcher's
 * dependency graph, the package matrix and the registry no more than a target
 * that does not exist.
 */
export const RELEASE_TARGETS = Object.freeze([
  Object.freeze({
    artifactTarget: "darwin-arm64",
    packageName: "@1667-ai/darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    libc: null,
    executable: "bin/1667",
    minimumCpuFeature: null,
    minimumMacosVersion: "13.0",
    minimumGlibcVersion: null,
    heldFromPublication: null
  }),
  Object.freeze({
    artifactTarget: "darwin-x64",
    packageName: "@1667-ai/darwin-x64",
    platform: "darwin",
    arch: "x64",
    libc: null,
    executable: "bin/1667",
    minimumCpuFeature: "sse4.2",
    minimumMacosVersion: "13.0",
    minimumGlibcVersion: null,
    heldFromPublication: null
  }),
  Object.freeze({
    artifactTarget: "linux-arm64",
    packageName: "@1667-ai/linux-arm64",
    platform: "linux",
    arch: "arm64",
    libc: "glibc",
    executable: "bin/1667",
    minimumCpuFeature: null,
    minimumMacosVersion: null,
    minimumGlibcVersion: "2.17",
    heldFromPublication: null
  }),
  Object.freeze({
    artifactTarget: "linux-x64",
    packageName: "@1667-ai/linux-x64",
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    executable: "bin/1667",
    minimumCpuFeature: "sse4.2",
    minimumMacosVersion: null,
    minimumGlibcVersion: "2.17",
    heldFromPublication: null
  }),
  Object.freeze({
    artifactTarget: "windows-x64",
    packageName: "@1667-ai/windows-x64",
    platform: "win32",
    arch: "x64",
    libc: null,
    executable: "bin/1667.exe",
    minimumCpuFeature: null,
    minimumMacosVersion: null,
    minimumGlibcVersion: null,
    heldFromPublication: "CI does not build the Windows platform work at present, "
      + "so it is unverified, and maintainers have not approved it for publication"
  })
] as const satisfies readonly ReleaseTargetDescriptor[]);

export function registryPathForPackage(packageName: string): string {
  return packageName.replaceAll("/", "%2f");
}

export type CanonicalReleaseTarget = typeof RELEASE_TARGETS[number];
/**
 * The targets whose packages the release actually ships. Derived from
 * `heldFromPublication` alone at the type level as well as at runtime, so
 * clearing that one field is the whole of un-holding a target.
 */
export type PublishedReleaseTarget = Extract<
  CanonicalReleaseTarget,
  { heldFromPublication: null }
>;
export type BuiltArtifactTarget = CanonicalReleaseTarget["artifactTarget"];
export type PublishedArtifactTarget = PublishedReleaseTarget["artifactTarget"];
export type ReleasePlatformPackage = CanonicalReleaseTarget["packageName"];
export type PublishedPlatformPackage = PublishedReleaseTarget["packageName"];

export const PUBLISHED_RELEASE_TARGETS: readonly PublishedReleaseTarget[] = Object.freeze(
  RELEASE_TARGETS.filter((descriptor): descriptor is PublishedReleaseTarget => {
    return descriptor.heldFromPublication === null;
  })
);

/**
 * Every target a release build produces an executable and an identity for, and
 * therefore also stages, packs and smoke-tests. Anything that follows *staging*
 * — a `sbom.spdx.json` sidecar, a build identity, a tarball inspection — uses
 * this list. Anything that follows *publication* uses the `PUBLISHED_*` family.
 */
export const BUILT_ARTIFACT_TARGETS = Object.freeze(
  RELEASE_TARGETS.map((descriptor) => descriptor.artifactTarget)
) as readonly [BuiltArtifactTarget, ...BuiltArtifactTarget[]];

/** String Set membership boundary for BuiltArtifactTarget (no array cast). */
const BUILT_ARTIFACT_TARGET_SET: ReadonlySet<string> = new Set(BUILT_ARTIFACT_TARGETS);

/** Type guard for a BuiltArtifactTarget via Set membership. */
export function isBuiltArtifactTarget(value: unknown): value is BuiltArtifactTarget {
  return typeof value === "string" && BUILT_ARTIFACT_TARGET_SET.has(value);
}

/** The subset of those targets whose package is published. */
export const PUBLISHED_ARTIFACT_TARGETS: readonly PublishedArtifactTarget[] = Object.freeze(
  PUBLISHED_RELEASE_TARGETS.map((descriptor) => descriptor.artifactTarget)
);
export const PUBLISHED_PLATFORM_PACKAGES: readonly PublishedPlatformPackage[] = Object.freeze(
  PUBLISHED_RELEASE_TARGETS.map((descriptor) => descriptor.packageName)
);
/** One launcher package plus one package per published platform. */
export const PUBLISHED_PACKAGE_COUNT = PUBLISHED_RELEASE_TARGETS.length + 1;

export type ReleaseTargetForArtifact<Target extends BuiltArtifactTarget> =
  Extract<CanonicalReleaseTarget, { artifactTarget: Target }>;

/**
 * Naming one target literally yields that target's descriptor, so a caller
 * asking for a published target gets a type that says so and cannot silently
 * feed a held package name into a publication path.
 */
export function releaseTargetForArtifact<Target extends BuiltArtifactTarget>(
  artifactTarget: Target
): ReleaseTargetForArtifact<Target> {
  const descriptor = RELEASE_TARGETS.find((candidate) => {
    return candidate.artifactTarget === artifactTarget;
  });
  if (descriptor === undefined) {
    throw new Error(`Unsupported release artifact target ${artifactTarget}`);
  }
  // The find matched on the discriminant the return type selects on.
  return descriptor as ReleaseTargetForArtifact<Target>;
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

/**
 * What a user on a held target is told. Their platform is supported and the
 * source builds an executable for it; the package is what is withheld, and the
 * hold reason above says whether anything still verifies that build. Reporting
 * an unsupported platform instead would send them looking for support that is
 * already there, so this names the reason and the route that does work.
 */
export function heldTargetRefusal(descriptor: CanonicalReleaseTarget): string {
  if (descriptor.heldFromPublication === null) {
    throw new Error(`${descriptor.artifactTarget} is published and holds no refusal`);
  }
  return `${descriptor.packageName} is not published yet: ${descriptor.heldFromPublication}. `
    + `The ${descriptor.artifactTarget} target is supported and builds from source: `
    + RELEASE_SOURCE_URL;
}

/**
 * The launcher's exact optional dependencies. Held targets are absent: npm
 * fails an optional dependency soft, so pinning a package that was never
 * published would install cleanly and then throw on first launch, and npm does
 * not allow replacing a published version to correct it.
 *
 * Each pin is typed as a published package before it is collected, so sourcing
 * this from `RELEASE_TARGETS` — the one edit that would publish a held package
 * irreversibly — stops compiling here rather than relying on a test to notice.
 * The remaining assertion narrows nothing but totality: `Object.fromEntries`
 * hands back a string-keyed record, so the compiler cannot see that every
 * published package is present exactly once. Tests cover that half.
 */
export function releasePlatformDependencyGraph(
  version: string
): Readonly<Record<PublishedPlatformPackage, string>> {
  const pins: readonly (readonly [PublishedPlatformPackage, string])[] =
    PUBLISHED_RELEASE_TARGETS.map((descriptor) => [descriptor.packageName, version]);
  return Object.freeze(Object.fromEntries(pins) as Record<PublishedPlatformPackage, string>);
}
