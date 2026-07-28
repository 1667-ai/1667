#!/usr/bin/env -S node --import tsx

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  BUILT_ARTIFACT_TARGETS,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import { createReleaseIdentitySet, type ReleaseIdentitySet } from "./release-identity.js";
import { MAX_RELEASE_SBOM_BYTES } from "./release-package-policy.js";
import {
  releaseBundledComponents,
  type ReleaseComponentSources
} from "./release-sbom-components.js";
import {
  launcherSbomDocument,
  platformSbomDocument,
  type SpdxDocument
} from "./release-sbom-document.js";
import { createSpdxValidator } from "./release-sbom-schema.js";

const MAX_NPM_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_BUN_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

export interface ReleaseSbom {
  readonly packageName: string;
  readonly artifactTarget: "launcher" | BuiltArtifactTarget;
  readonly document: SpdxDocument;
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ReleaseSbomSet {
  readonly launcher: ReleaseSbom;
  readonly platforms: readonly ReleaseSbom[];
}

/**
 * Produces one SPDX 2.3 document per staged release package from data alone: no
 * build, no extraction, no network, no Git, and no clock. Repeated calls on
 * equal inputs return byte-identical text, and every document is validated
 * against the vendored SPDX schema before it is returned.
 *
 * The platform documents follow **staging**, not publication, so a held target
 * gets one like any other. Its package is still staged, packed and validated —
 * its platform manifest declares `sbom.spdx.json` in `files`, so a tarball
 * without the file is rejected — and withholding the document would break the
 * one thing a hold is supposed to keep exercising. Publication is a separate
 * question, and exactly one thing here answers it: `launcherSbomDocument` lists
 * the published platform packages, because that list *is* the launcher's
 * `optionalDependencies`.
 *
 * Nothing stages `sbom.spdx.json` from this generator yet, so no consumer binds
 * to its bytes. When the staging step lands, the preflight gains the same check
 * it already applies to `build-manifest.json`: regenerate the expected document
 * from the release evidence and reject a tarball whose staged copy disagrees.
 * Determinism is what makes that comparison possible, which is why it is
 * asserted here rather than assumed.
 */
export function createReleaseSboms(
  identities: ReleaseIdentitySet,
  sources: ReleaseComponentSources
): ReleaseSbomSet {
  const validate = createSpdxValidator();
  const launcher = formatSbom(
    RELEASE_LAUNCHER_PACKAGE,
    "launcher",
    launcherSbomDocument(identities),
    validate
  );
  const platforms = BUILT_ARTIFACT_TARGETS.map((target) => {
    return formatSbom(
      releaseTargetForArtifact(target).packageName,
      target,
      platformSbomDocument(identities, target, releaseBundledComponents(sources, target)),
      validate
    );
  });
  return Object.freeze({ launcher, platforms: Object.freeze(platforms) });
}

export function releaseSbomForPackage(set: ReleaseSbomSet, packageName: string): ReleaseSbom {
  if (packageName === set.launcher.packageName) return set.launcher;
  const found = set.platforms.find((entry) => entry.packageName === packageName);
  if (found === undefined) throw new Error(`Unsupported release package ${packageName}`);
  return found;
}

export interface ReleaseSbomInputPaths {
  readonly sourceEvidence: string;
  readonly npmLockfile: string;
  readonly bunLockfile: string;
}

export function defaultReleaseSbomInputs(sourceEvidence: string): ReleaseSbomInputPaths {
  const root = repositoryRoot();
  return Object.freeze({
    sourceEvidence,
    npmLockfile: path.join(root, "package-lock.json"),
    bunLockfile: path.join(root, "tui", "bun.lockb")
  });
}

export function readReleaseSboms(paths: ReleaseSbomInputPaths): ReleaseSbomSet {
  const evidence = parseJsonRejectingDuplicateKeys(
    boundedFile(paths.sourceEvidence, MAX_EVIDENCE_BYTES, "Release source evidence")
      .toString("utf8")
  );
  const npmLockfile = parseJsonRejectingDuplicateKeys(
    boundedFile(paths.npmLockfile, MAX_NPM_LOCKFILE_BYTES, "Release npm lockfile")
      .toString("utf8")
  );
  const bunLockfile = boundedFile(paths.bunLockfile, MAX_BUN_LOCKFILE_BYTES, "Release Bun lockfile");
  return createReleaseSboms(createReleaseIdentitySet(evidence), { npmLockfile, bunLockfile });
}

function formatSbom(
  packageName: string,
  artifactTarget: "launcher" | BuiltArtifactTarget,
  document: SpdxDocument,
  validate: (value: unknown) => void
): ReleaseSbom {
  validate(document);
  const text = canonicalJson(document);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0 || bytes > MAX_RELEASE_SBOM_BYTES) {
    throw new Error(`Release SBOM for ${packageName} is outside its size bound`);
  }
  return Object.freeze({
    packageName,
    artifactTarget,
    document,
    text,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    bytes
  });
}

function boundedFile(value: string, maximumBytes: number, label: string): Buffer {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const bytes = readFileSync(realpathSync(resolved));
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} changed outside its size bound while reading`);
  }
  return bytes;
}

function repositoryRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
    if (process.argv.length !== 4) {
      throw new Error("usage: release-sbom.ts <source-evidence.json> <package-name>");
    }
    const evidencePath = process.argv[2];
    const packageName = process.argv[3];
    if (evidencePath === undefined || packageName === undefined) {
      throw new Error("usage: release-sbom.ts <source-evidence.json> <package-name>");
    }
    const set = readReleaseSboms(defaultReleaseSbomInputs(evidencePath));
    const sbom = releaseSbomForPackage(set, packageName);
    process.stdout.write(sbom.text);
    process.stderr.write(`release-sbom-sha256 ${sbom.sha256} ${sbom.bytes}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-sbom: ${message}\n`);
    process.exitCode = 1;
  }
}
