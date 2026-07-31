#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  realpathSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import {
  parseBuildIdentity,
  type BuildIdentity
} from "../shared/build-identity.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";
import {
  exactRecord,
  sha256Digest
} from "./release-boundary-validation.js";
import { MAX_RELEASE_TARBALL_FILE_BYTES } from "./release-package-policy.js";

const execFileAsync = promisify(execFile);
const OBSERVATION_KEYS = new Set([
  "schemaVersion",
  "artifactTarget",
  "executable",
  "buildIdentity"
]);
const EXECUTABLE_KEYS = new Set(["sha256", "bytes"]);
const MAX_IDENTITY_BYTES = 64 * 1024;

export interface ReleaseExecutableObservation {
  readonly schemaVersion: 1;
  readonly artifactTarget: PublishedArtifactTarget;
  readonly executable: {
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly buildIdentity: BuildIdentity & { readonly buildKind: "release" };
}

/**
 * Observes the executable on the machine that built it. The digest binds that
 * observation to the bytes that a later job puts in the package.
 */
export async function observeReleaseExecutable(
  artifactTarget: PublishedArtifactTarget,
  executable: string
): Promise<ReleaseExecutableObservation> {
  const file = boundedExecutable(executable, artifactTarget);
  const { stdout, stderr } = await execFileAsync(file, ["--version", "--json"], {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C"
    },
    maxBuffer: MAX_IDENTITY_BYTES,
    timeout: 30_000,
    windowsHide: true
  });
  if (stderr !== "") throw new Error("Release executable wrote diagnostics during observation");
  const buildIdentity = releaseBuildIdentity(
    parseJsonRejectingDuplicateKeys(stdout),
    artifactTarget
  );
  const stat = lstatSync(file);
  return Object.freeze({
    schemaVersion: 1 as const,
    artifactTarget,
    executable: Object.freeze({
      sha256: await sha256File(file),
      bytes: stat.size
    }),
    buildIdentity
  });
}

export function parseReleaseExecutableObservation(
  value: unknown,
  expectedTarget: PublishedArtifactTarget
): ReleaseExecutableObservation {
  const input = exactRecord(value, OBSERVATION_KEYS, "Release executable observation");
  if (input.schemaVersion !== 1) {
    throw new Error("Unsupported release executable observation schema");
  }
  if (input.artifactTarget !== expectedTarget) {
    throw new Error(
      `Release executable observation targets ${String(input.artifactTarget)},`
      + ` expected ${expectedTarget}`
    );
  }
  const executable = exactRecord(
    input.executable,
    EXECUTABLE_KEYS,
    "Observed release executable"
  );
  const bytes = executable.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0
    || bytes > MAX_RELEASE_TARBALL_FILE_BYTES) {
    throw new Error("Observed release executable has an invalid size");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    artifactTarget: expectedTarget,
    executable: Object.freeze({
      sha256: sha256Digest(executable.sha256, "Observed release executable"),
      bytes
    }),
    buildIdentity: releaseBuildIdentity(input.buildIdentity, expectedTarget)
  });
}

function releaseBuildIdentity(
  value: unknown,
  expectedTarget: PublishedArtifactTarget
): ReleaseExecutableObservation["buildIdentity"] {
  const identity = parseBuildIdentity(value);
  if (identity.buildKind !== "release") {
    throw new Error("Observed release executable has a non-release identity");
  }
  if (identity.artifactTarget !== expectedTarget) {
    throw new Error(
      `Observed release executable targets ${identity.artifactTarget}, expected ${expectedTarget}`
    );
  }
  return identity;
}

function boundedExecutable(
  value: string,
  artifactTarget: PublishedArtifactTarget
): string {
  const file = realpathSync(value);
  const stat = lstatSync(file);
  // NTFS does not expose POSIX execute bits through Node. Windows executable
  // identity and the native process launch provide the executable check.
  const requiresExecutableMode = artifactTarget !== "windows-x64";
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_RELEASE_TARBALL_FILE_BYTES
    || (requiresExecutableMode && (stat.mode & 0o111) === 0)) {
    throw new Error("Release executable must be a bounded executable file");
  }
  return file;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function publishedTarget(value: string): PublishedArtifactTarget {
  const target = PUBLISHED_ARTIFACT_TARGETS.find((candidate) => candidate === value);
  if (target === undefined) throw new Error(`Unsupported published release target ${value}`);
  return target;
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const [targetInput, executable] = process.argv.slice(2);
    if (process.argv.length !== 4 || targetInput === undefined || executable === undefined) {
      throw new Error("usage: release-npm-observation.ts <target> <executable>");
    }
    const observation = await observeReleaseExecutable(
      publishedTarget(targetInput),
      executable
    );
    process.stdout.write(`${canonicalJson(observation)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-observation: ${message}\n`);
    process.exitCode = 1;
  }
}
