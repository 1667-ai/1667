#!/usr/bin/env -S node --import tsx

import {
  createReadStream,
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import { PUBLISHED_PACKAGE_COUNT } from "../shared/release-targets.js";
import {
  createReleaseArtifactManifest,
  type FormattedReleaseArtifactManifest,
  type ReleasePackageArtifactInput
} from "./release-artifact-manifest.js";
import { exactRecord } from "./release-boundary-validation.js";
import { createReleaseIdentitySet } from "./release-identity.js";
import { createReleasePackageTemplates } from "./release-package-templates.js";
import {
  MAX_RELEASE_TARBALL_GZIP_BYTES,
  readReleaseTarball
} from "./release-tar-reader.js";

const MAX_PLAN_BYTES = 1024 * 1024;
const PLAN_KEYS = new Set(["schemaVersion", "sourceEvidence", "artifacts"]);
const ARTIFACT_KEYS = new Set(["tarballPath", "buildIdentity"]);

export interface ReleasePreflightPlan {
  schemaVersion: 1;
  sourceEvidence: unknown;
  artifacts: readonly {
    tarballPath: string;
    buildIdentity: unknown | null;
  }[];
}

/**
 * Validates the already-packed npm tarballs — one per published package —
 * without extracting, building, publishing, or accessing the network.
 */
export async function runReleasePreflight(
  value: unknown,
  baseDirectory: string
): Promise<FormattedReleaseArtifactManifest> {
  const plan = parsePlan(value);
  const identities = createReleaseIdentitySet(plan.sourceEvidence);
  const templates = createReleasePackageTemplates(identities);
  const templatesByName = new Map([
    templates.launcher,
    ...templates.platforms
  ].map((template) => [
    stringProperty(template.packageManifest, "name"),
    template
  ]));
  const seenPaths = new Set<string>();
  const artifacts: ReleasePackageArtifactInput[] = [];
  for (const artifact of plan.artifacts) {
    const tarballPath = boundedRegularFile(
      path.resolve(baseDirectory, artifact.tarballPath),
      MAX_RELEASE_TARBALL_GZIP_BYTES,
      "Release tarball"
    );
    if (seenPaths.has(tarballPath)) throw new Error("Preflight repeats a tarball path");
    seenPaths.add(tarballPath);
    const parsed = await readReleaseTarball(createReadStream(tarballPath));
    const packageName = stringProperty(parsed.packageManifest, "name");
    const template = templatesByName.get(packageName);
    if (template === undefined) throw new Error(`Unsupported release package ${packageName}`);
    if (canonicalJson(parsed.buildManifest) !== canonicalJson(template.buildManifest)) {
      throw new Error(`${packageName} build manifest disagrees with release evidence`);
    }
    artifacts.push({
      packageJson: parsed.packageManifest,
      tarball: {
        sha256: parsed.gzip.sha256,
        bytes: parsed.gzip.bytes
      },
      tarEntries: parsed.inspection,
      buildIdentity: artifact.buildIdentity
    });
  }
  return createReleaseArtifactManifest(identities, artifacts);
}

export async function runReleasePreflightFile(
  planPath: string
): Promise<FormattedReleaseArtifactManifest> {
  const resolvedPlan = boundedRegularFile(
    path.resolve(planPath),
    MAX_PLAN_BYTES,
    "Release preflight plan"
  );
  const bytes = readFileSync(resolvedPlan);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLAN_BYTES) {
    throw new Error("Release preflight plan changed outside its size bound while reading");
  }
  const value = parseJsonRejectingDuplicateKeys(decodeUtf8(bytes, "Release preflight plan"));
  return runReleasePreflight(value, path.dirname(resolvedPlan));
}

function parsePlan(value: unknown): ReleasePreflightPlan {
  const input = exactRecord(value, PLAN_KEYS, "Release preflight plan");
  if (input.schemaVersion !== 1) throw new Error("Unsupported release preflight plan schema");
  if (!Array.isArray(input.artifacts) || input.artifacts.length !== PUBLISHED_PACKAGE_COUNT) {
    throw new Error(
      `Release preflight plan must contain exactly ${PUBLISHED_PACKAGE_COUNT} artifacts`
    );
  }
  const artifacts = input.artifacts.map((value) => {
    const artifact = exactRecord(value, ARTIFACT_KEYS, "Release preflight artifact");
    if (typeof artifact.tarballPath !== "string"
      || artifact.tarballPath.length === 0
      || Buffer.byteLength(artifact.tarballPath) > 4096
      || artifact.tarballPath.includes("\0")) {
      throw new Error("Release preflight tarball path is invalid");
    }
    return Object.freeze({
      tarballPath: artifact.tarballPath,
      buildIdentity: artifact.buildIdentity
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceEvidence: input.sourceEvidence,
    artifacts: Object.freeze(artifacts)
  });
}

function boundedRegularFile(value: string, maximumBytes: number, label: string): string {
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return realpathSync(value);
}

function stringProperty(value: unknown, key: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || typeof (value as Record<string, unknown>)[key] !== "string") {
    throw new Error(`Release package manifest has no ${key}`);
  }
  return (value as Record<string, string>)[key]!;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
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
    if (process.argv.length !== 3) {
      throw new Error("usage: release-preflight.ts <plan.json>");
    }
    const result = await runReleasePreflightFile(process.argv[2]!);
    process.stdout.write(result.text);
    process.stderr.write(`release-manifest-sha256 ${result.sha256}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-preflight: ${message}\n`);
    process.exitCode = 1;
  }
}
