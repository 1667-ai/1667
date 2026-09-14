import { createReadStream } from "node:fs";
import {
  extractPlatformPackageExecutable
} from "../../shared/release-tar-extract.js";
import {
  probeReleaseExecutable
} from "../../shared/executable-probe.js";
import type { PackagedBuildIdentity } from "../../shared/build-identity.js";
import {
  releaseTargetForPackage,
  type BuiltArtifactTarget,
  type PublishedPlatformPackage
} from "../../shared/release-targets.js";
import { UpgradeFailure } from "./upgrade-contract.js";
import { throwUpgradeProbeFailure } from "./upgrade-probe-errors.js";

export interface ValidatedCandidate {
  readonly path: string;
  readonly version: string;
  readonly identity: PackagedBuildIdentity;
}

/**
 * Extracts the platform executable from a downloaded package and proves it
 * with the shared no-data version probe before replacement.
 */
export async function materializeCandidate(options: {
  readonly packagePath: string;
  readonly destinationPath: string;
  readonly packageName: PublishedPlatformPackage;
  readonly version: string;
  readonly signal: AbortSignal;
}): Promise<ValidatedCandidate> {
  const target = releaseTargetForPackage(options.packageName);
  if (target === null || target.heldFromPublication !== null) {
    throw new UpgradeFailure("unsupported_target", "This platform is not supported for releases.");
  }
  if (options.signal.aborted) {
    throw new UpgradeFailure("interrupted", "The update was interrupted.");
  }
  const packageStream = createReadStream(options.packagePath);
  try {
    try {
      await extractPlatformPackageExecutable(
        packageStream,
        {
          packageName: options.packageName,
          version: options.version,
          destinationPath: options.destinationPath,
          signal: options.signal
        }
      );
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) {
        throw new UpgradeFailure("interrupted", "The update was interrupted.");
      }
      throw new UpgradeFailure(
        "verification_failed",
        error instanceof Error ? error.message : "Release package could not be extracted."
      );
    }
  } finally {
    packageStream.destroy();
  }
  if (options.signal.aborted) {
    throw new UpgradeFailure("interrupted", "The update was interrupted.");
  }
  const identity = await probeCandidateVersion(
    options.destinationPath,
    options.version,
    target.artifactTarget,
    options.signal
  );
  return Object.freeze({
    path: options.destinationPath,
    version: options.version,
    identity
  });
}

export async function probeCandidateVersion(
  executablePath: string,
  version: string,
  artifactTarget: BuiltArtifactTarget,
  signal: AbortSignal
): Promise<PackagedBuildIdentity> {
  try {
    return await probeReleaseExecutable(executablePath, {
      version,
      artifactTarget
    }, { signal });
  } catch (error) {
    throwUpgradeProbeFailure(error, signal, "Candidate version probe failed.");
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}
