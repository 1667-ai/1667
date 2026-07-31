#!/usr/bin/env -S node --import tsx

import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";
import { createReleaseIdentitySet } from "./release-identity.js";
import {
  parseReleaseExecutableObservation,
  type ReleaseExecutableObservation
} from "./release-npm-observation.js";
import {
  parseReleasePackageManifest,
  tarballFile,
  validateReleaseTarballInspection,
  type ReleaseTarballInspection
} from "./release-package-policy.js";
import {
  type ReleasePreflightPlan
} from "./release-preflight.js";
import {
  MAX_RELEASE_TARBALL_GZIP_BYTES,
  readReleaseTarball
} from "./release-tar-reader.js";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_OBSERVATION_BYTES = 128 * 1024;

/**
 * Binds observations made on native runners to the executable bytes in the
 * release tarballs, then writes the exact plan consumed by release preflight.
 */
export async function createReleasePreflightPlan(
  sourceEvidence: unknown,
  tarballDirectory: string,
  observationDirectory: string,
  planDirectory: string
): Promise<ReleasePreflightPlan> {
  const identities = createReleaseIdentitySet(sourceEvidence);
  const tarballs = await releaseTarballs(
    tarballDirectory,
    identities.evidence.productVersion
  );
  const observations = releaseObservations(observationDirectory);
  const artifacts: {
    tarballPath: string;
    buildIdentity: unknown | null;
  }[] = [];

  const launcher = tarballs.get(RELEASE_LAUNCHER_PACKAGE);
  if (launcher === undefined) throw new Error(`Release plan is missing ${RELEASE_LAUNCHER_PACKAGE}`);
  artifacts.push(Object.freeze({
    tarballPath: portableRelativePath(planDirectory, launcher.path),
    buildIdentity: null
  }));

  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const descriptor = releaseTargetForArtifact(target);
    const tarball = tarballs.get(descriptor.packageName);
    const observation = observations.get(target);
    if (tarball === undefined) throw new Error(`Release plan is missing ${descriptor.packageName}`);
    if (observation === undefined) throw new Error(`Release plan is missing ${target} observation`);
    const executable = tarballFile(tarball.inspection, descriptor.executable);
    if (executable.sha256 !== observation.executable.sha256
      || executable.size !== observation.executable.bytes) {
      throw new Error(`${target} observation does not describe the packaged executable`);
    }
    artifacts.push(Object.freeze({
      tarballPath: portableRelativePath(planDirectory, tarball.path),
      buildIdentity: observation.buildIdentity
    }));
  }

  if (tarballs.size !== PUBLISHED_PACKAGE_COUNT) {
    throw new Error("Release plan contains an unsupported tarball");
  }
  if (observations.size !== PUBLISHED_ARTIFACT_TARGETS.length) {
    throw new Error("Release plan contains an unsupported observation");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceEvidence: identities.evidence,
    artifacts: Object.freeze(artifacts)
  });
}

interface InspectedTarball {
  readonly path: string;
  readonly inspection: ReleaseTarballInspection;
}

async function releaseTarballs(
  directory: string,
  version: string
): Promise<ReadonlyMap<string, InspectedTarball>> {
  const root = boundedDirectory(directory, "Release tarball directory");
  const files = regularDirectoryFiles(root, ".tgz", PUBLISHED_PACKAGE_COUNT);
  const entries = await Promise.all(files.map(async (file) => {
    const parsed = await readReleaseTarball(createReadStream(file));
    const manifest = parseReleasePackageManifest(parsed.packageManifest, version);
    const inspection = validateReleaseTarballInspection(parsed.inspection, manifest);
    return [manifest.name, Object.freeze({
      path: file,
      inspection
    })] as const;
  }));
  const result = new Map(entries);
  if (result.size !== entries.length) throw new Error("Release plan repeats a package tarball");
  return result;
}

function releaseObservations(
  directory: string
): ReadonlyMap<PublishedArtifactTarget, ReleaseExecutableObservation> {
  const root = boundedDirectory(directory, "Release observation directory");
  const files = regularDirectoryFiles(root, ".json", PUBLISHED_ARTIFACT_TARGETS.length);
  const byBasename = new Map(files.map((file) => [path.basename(file), file]));
  const observations = new Map<PublishedArtifactTarget, ReleaseExecutableObservation>();
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const name = `${target}.json`;
    const file = byBasename.get(name);
    if (file === undefined) throw new Error(`Release plan is missing ${target} observation`);
    const value = readStrictJson(file, MAX_OBSERVATION_BYTES, `${target} observation`);
    observations.set(target, parseReleaseExecutableObservation(value, target));
  }
  if (byBasename.size !== observations.size) {
    throw new Error("Release observation directory contains an unsupported file");
  }
  return observations;
}

function regularDirectoryFiles(
  directory: string,
  suffix: string,
  expectedCount: number
): readonly string[] {
  const names = readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  if (names.length !== expectedCount) {
    throw new Error(
      `${directory} must contain exactly ${expectedCount} ${suffix} files`
    );
  }
  return Object.freeze(names.map((name) => {
    if (!name.endsWith(suffix) || path.basename(name) !== name) {
      throw new Error(`${directory} contains unsupported entry ${name}`);
    }
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    const maximum = suffix === ".tgz"
      ? MAX_RELEASE_TARBALL_GZIP_BYTES
      : MAX_OBSERVATION_BYTES;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum) {
      throw new Error(`${file} must be a bounded regular file`);
    }
    const resolved = realpathSync(file);
    if (path.dirname(resolved) !== directory) {
      throw new Error(`${file} escaped its release directory`);
    }
    return resolved;
  }));
}

function readStrictJson(file: string, maximumBytes: number, label: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return parseJsonRejectingDuplicateKeys(readFileSync(realpathSync(file), "utf8"));
}

function boundedDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(resolved);
}

function portableRelativePath(base: string, file: string): string {
  const relative = path.relative(path.resolve(base), file);
  if (relative.length === 0 || path.isAbsolute(relative)
    || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Release plan tarball is outside its plan directory");
  }
  return relative.split(path.sep).join("/");
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
    const [evidencePath, tarballs, observations, planPath] = process.argv.slice(2);
    if (process.argv.length !== 6 || evidencePath === undefined || tarballs === undefined
      || observations === undefined || planPath === undefined) {
      throw new Error(
        "usage: release-npm-plan.ts <source-evidence.json> <tarballs>"
        + " <observations> <plan.json>"
      );
    }
    const output = path.resolve(planPath);
    const plan = await createReleasePreflightPlan(
      readStrictJson(evidencePath, MAX_EVIDENCE_BYTES, "Release source evidence"),
      tarballs,
      observations,
      path.dirname(output)
    );
    writeFileSync(output, `${canonicalJson(plan)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-plan: ${message}\n`);
    process.exitCode = 1;
  }
}
