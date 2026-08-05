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
import {
  createReleaseSbomSource,
  type ReleaseSbomSource
} from "./release-sbom-source.js";
import {
  collectRepositoryReleaseSbomSource
} from "./release-source-facts.js";

const MAX_NPM_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_BUN_LOCKFILE_BYTES = 8 * 1024 * 1024;

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
 * The generator validates the document. The release content assembler stages
 * its exact text as `sbom.spdx.json`. Preflight requires the SBOM entry and
 * binds it through the tarball digest. Preflight does not compare the SBOM
 * text with a regenerated document.
 */
export function createReleaseSboms(
  sourceInput: ReleaseSbomSource,
  sources: ReleaseComponentSources
): ReleaseSbomSet {
  const source = createReleaseSbomSource(sourceInput);
  const validate = createSpdxValidator();
  const launcher = formatSbom(
    RELEASE_LAUNCHER_PACKAGE,
    "launcher",
    launcherSbomDocument(source),
    validate
  );
  const platforms = BUILT_ARTIFACT_TARGETS.map((target) => {
    return formatSbom(
      releaseTargetForArtifact(target).packageName,
      target,
      platformSbomDocument(source, target, releaseBundledComponents(sources, target)),
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

/**
 * The two lockfiles in this checkout, which are the only dependency sources an
 * SBOM is built from. Paths rather than parameters: the SBOM describes the
 * commit the job checked out, so there is nothing to configure and nothing for
 * a caller to point somewhere else.
 */
export function repositoryReleaseComponentSources(): ReleaseComponentSources {
  const root = repositoryRoot();
  return Object.freeze({
    npmLockfile: parseJsonRejectingDuplicateKeys(
      boundedFile(path.join(root, "package-lock.json"), MAX_NPM_LOCKFILE_BYTES, "Release npm lockfile")
        .toString("utf8")
    ),
    bunLockfile: boundedFile(
      path.join(root, "tui", "bun.lockb"),
      MAX_BUN_LOCKFILE_BYTES,
      "Release Bun lockfile"
    )
  });
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

// The three source facts become only the four fields an SBOM uses.
const USAGE = "usage: release-sbom.ts <version> <commit> <timestamp> <package-name>";

if (isMainModule()) {
  try {
    const [version, sourceCommit, buildTimestamp, packageName] = process.argv.slice(2);
    if (process.argv.length !== 6 || version === undefined || sourceCommit === undefined
      || buildTimestamp === undefined || packageName === undefined) {
      throw new Error(USAGE);
    }
    const set = createReleaseSboms(
      collectRepositoryReleaseSbomSource({ version, sourceCommit, buildTimestamp }),
      repositoryReleaseComponentSources()
    );
    const sbom = releaseSbomForPackage(set, packageName);
    process.stdout.write(sbom.text);
    process.stderr.write(`release-sbom-sha256 ${sbom.sha256} ${sbom.bytes}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-sbom: ${message}\n`);
    process.exitCode = 1;
  }
}
