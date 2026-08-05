import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";

export interface NpmPublicationPackage {
  readonly artifactTarget: "launcher" | PublishedArtifactTarget;
  readonly name: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly sha256: string;
  readonly integrity: string;
}

export interface NpmPublicationRegistry {
  inspect(packageToPublish: NpmPublicationPackage): Promise<"missing" | "present">;
  publish(packageToPublish: NpmPublicationPackage): Promise<void>;
  waitUntilVerified(packages: readonly NpmPublicationPackage[]): Promise<void>;
}

export interface NpmPublicationLedger {
  assertWritable(packageToPublish: NpmPublicationPackage): Promise<void>;
  status(packageToPublish: NpmPublicationPackage): Promise<"fresh" | "attempted">;
  recordAttempt(
    packageToPublish: NpmPublicationPackage
  ): Promise<"created" | "attempted">;
}

export interface NpmPublicationWriteGuard {
  assertWritable(packageToPublish: NpmPublicationPackage): Promise<void>;
}

export class NpmPublicationPendingTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NpmPublicationPendingTimeoutError";
  }
}

export class NpmPublicationAlreadyExistsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NpmPublicationAlreadyExistsError";
  }
}

/**
 * Publishes platform packages first. A present exact version is a resumable
 * success only after the registry adapter validates its bytes.
 */
export async function publishNpmRelease(
  packages: readonly NpmPublicationPackage[],
  registry: NpmPublicationRegistry,
  ledger: NpmPublicationLedger,
  writeGuard: NpmPublicationWriteGuard
): Promise<void> {
  const matrix = validatePublicationMatrix(packages);
  await writeGuard.assertWritable(matrix.launcher);
  for (const platform of matrix.platforms) {
    await publishMissingPackage(platform, registry, ledger, writeGuard);
  }
  await registry.waitUntilVerified(matrix.platforms);
  await publishMissingPackage(matrix.launcher, registry, ledger, writeGuard);
  await registry.waitUntilVerified([matrix.launcher, ...matrix.platforms]);
}

async function publishMissingPackage(
  packageToPublish: NpmPublicationPackage,
  registry: NpmPublicationRegistry,
  ledger: NpmPublicationLedger,
  writeGuard: NpmPublicationWriteGuard
): Promise<void> {
  const ledgerStatus = await ledger.status(packageToPublish);
  if (await registry.inspect(packageToPublish) === "present") {
    await registry.waitUntilVerified([packageToPublish]);
    return;
  }
  let recovering = ledgerStatus === "attempted";
  if (!recovering) {
    await writeGuard.assertWritable(packageToPublish);
    recovering = await ledger.recordAttempt(packageToPublish) === "attempted";
  }
  if (recovering) {
    try {
      await registry.waitUntilVerified([packageToPublish]);
      return;
    } catch (error) {
      if (!(error instanceof NpmPublicationPendingTimeoutError)) throw error;
    }
  }
  try {
    await writeGuard.assertWritable(packageToPublish);
    await ledger.assertWritable(packageToPublish);
    await registry.publish(packageToPublish);
  } catch (error) {
    if (!(error instanceof NpmPublicationAlreadyExistsError)) throw error;
  }
  await registry.waitUntilVerified([packageToPublish]);
}

export function validatePublicationMatrix(
  packages: readonly NpmPublicationPackage[]
): {
  readonly launcher: NpmPublicationPackage;
  readonly platforms: readonly NpmPublicationPackage[];
} {
  if (packages.length !== PUBLISHED_PACKAGE_COUNT) {
    throw new Error(`npm publication requires exactly ${PUBLISHED_PACKAGE_COUNT} packages`);
  }
  const byTarget = new Map(packages.map((entry) => [entry.artifactTarget, entry]));
  if (byTarget.size !== packages.length) throw new Error("npm publication repeats a target");
  const launcher = byTarget.get("launcher");
  if (launcher?.name !== RELEASE_LAUNCHER_PACKAGE) {
    throw new Error(`npm publication is missing ${RELEASE_LAUNCHER_PACKAGE}`);
  }
  const version = launcher.version;
  const platforms = PUBLISHED_ARTIFACT_TARGETS.map((target) => {
    const entry = byTarget.get(target);
    const expectedName = releaseTargetForArtifact(target).packageName;
    if (entry?.name !== expectedName) {
      throw new Error(`npm publication is missing ${expectedName}`);
    }
    if (entry.version !== version) {
      throw new Error("npm publication requires one version");
    }
    return entry;
  });
  return Object.freeze({
    launcher,
    platforms: Object.freeze(platforms)
  });
}
