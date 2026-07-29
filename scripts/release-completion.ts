#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compareSemVer,
  isSemVer
} from "../shared/semver.js";
import {
  PUBLISHED_ARTIFACT_TARGETS
} from "../shared/release-targets.js";

const COMMIT = /^[0-9a-f]{40}$/;
const COMPLETION_PREFIX = "refs/tags/released/v";
const DIGEST = /^[0-9a-f]{64}$/u;
const PUBLICATION_TARGETS = new Set(["launcher", ...PUBLISHED_ARTIFACT_TARGETS]);

export interface ReleaseCompletionRef {
  readonly ref: string;
  readonly objectType: string;
  readonly objectName: string;
  readonly peeledType: string;
  readonly peeledName: string;
}

/** This gate records whether all prepublication controls passed. */
export const NPM_PUBLICATION_READY = true;

export function requireNpmPublicationReady(): void {
  if (!NPM_PUBLICATION_READY) {
    throw new Error(
      "npm publication is disabled until all prepublication release controls pass"
    );
  }
}

/**
 * A completion tag exists only after a whole publication succeeds. The
 * candidate tag is deliberately absent from this comparison.
 */
export function validateReleaseCandidate(
  version: string,
  sourceCommit: string,
  refs: readonly ReleaseCompletionRef[]
): void {
  const completed = completedReleases(version, sourceCommit, refs);
  if (completed.some((entry) => entry.version === version)) {
    throw new Error(`Release ${version} is already complete`);
  }
  requireAfterCompleted(version, completed);
}

export function validateReleaseReplay(
  version: string,
  sourceCommit: string,
  refs: readonly ReleaseCompletionRef[]
): "missing" | "present" {
  const completed = completedReleases(version, sourceCommit, refs);
  const current = completed.find((entry) => entry.version === version);
  if (current !== undefined && current.sourceCommit !== sourceCommit) {
    throw new Error(`Release ${version} completed from a different commit`);
  }
  requireAfterCompleted(
    version,
    completed.filter((entry) => entry.version !== version)
  );
  return current === undefined ? "missing" : "present";
}

interface CompletedRelease {
  readonly version: string;
  readonly sourceCommit: string;
}

function completedReleases(
  version: string,
  sourceCommit: string,
  refs: readonly ReleaseCompletionRef[]
): readonly CompletedRelease[] {
  if (!isSemVer(version)) throw new Error(`Release candidate ${version} is not SemVer`);
  if (!COMMIT.test(sourceCommit)) throw new Error("Release candidate commit is not canonical");
  const completed: CompletedRelease[] = [];
  const versions = new Set<string>();
  for (const entry of refs) {
    if (!entry.ref.startsWith(COMPLETION_PREFIX)) {
      throw new Error(`Unexpected release completion ref ${entry.ref}`);
    }
    const suffix = entry.ref.slice(COMPLETION_PREFIX.length);
    const targetName = resolvedCommit(entry);
    const marker = publicationMarker(suffix);
    if (marker !== null) {
      if (marker.version === version && targetName !== sourceCommit) {
        throw new Error(`Release ${version} publication marker targets a different commit`);
      }
      if (marker.version === version && marker.kind === "quarantined") {
        throw new Error(`Release ${version} is quarantined`);
      }
      continue;
    }
    const completedVersion = suffix;
    if (!isSemVer(completedVersion)) {
      throw new Error(`Malformed release completion ref ${entry.ref}`);
    }
    if (versions.has(completedVersion)) {
      throw new Error(`Release completion refs repeat ${completedVersion}`);
    }
    versions.add(completedVersion);
    completed.push(Object.freeze({
      version: completedVersion,
      sourceCommit: targetName
    }));
  }
  return Object.freeze(completed);
}

function resolvedCommit(entry: ReleaseCompletionRef): string {
  const targetType = entry.objectType === "tag" ? entry.peeledType : entry.objectType;
  const targetName = entry.objectType === "tag" ? entry.peeledName : entry.objectName;
  if (targetType !== "commit" || !COMMIT.test(targetName)) {
    throw new Error(`Release completion ref ${entry.ref} does not resolve to a commit`);
  }
  return targetName;
}

function publicationMarker(
  suffix: string
): { readonly kind: "attempted" | "quarantined"; readonly version: string } | null {
  if (suffix.endsWith("_quarantined")) {
    const version = suffix.slice(0, -"_quarantined".length);
    if (!isSemVer(version)) throw new Error("Malformed release quarantine ref");
    return Object.freeze({ kind: "quarantined", version });
  }
  const separator = suffix.indexOf("_attempt_");
  if (separator === -1) return null;
  const version = suffix.slice(0, separator);
  const attempt = suffix.slice(separator + "_attempt_".length);
  const digestSeparator = attempt.lastIndexOf("_");
  const target = attempt.slice(0, digestSeparator);
  const digest = attempt.slice(digestSeparator + 1);
  if (!isSemVer(version) || digestSeparator <= 0
    || !PUBLICATION_TARGETS.has(target) || !DIGEST.test(digest)) {
    throw new Error("Malformed release publication attempt ref");
  }
  return Object.freeze({ kind: "attempted", version });
}

function requireAfterCompleted(
  version: string,
  completed: readonly CompletedRelease[]
): void {
  const newerOrEqual = completed.find((entry) => {
    return compareSemVer(version, entry.version) <= 0;
  });
  if (newerOrEqual !== undefined) {
    throw new Error(
      `Release ${version} does not follow completed release ${newerOrEqual.version}`
    );
  }
}

export function repositoryCompletionRefs(): readonly ReleaseCompletionRef[] {
  const output = execFileSync("git", [
    "for-each-ref",
    "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)",
    "refs/tags/released/"
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0"
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000
  });
  if (output === "") return Object.freeze([]);
  return Object.freeze(output.trimEnd().split("\n").map((line) => {
    const [ref, objectType, objectName, peeledType, peeledName, extra] = line.split("\0");
    if (ref === undefined || objectType === undefined || objectName === undefined
      || peeledType === undefined || peeledName === undefined || extra !== undefined) {
      throw new Error("Git returned a malformed release completion record");
    }
    return Object.freeze({ ref, objectType, objectName, peeledType, peeledName });
  }));
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
    const [command, version, sourceCommit] = process.argv.slice(2);
    if (command === "ready" && process.argv.length === 3) {
      requireNpmPublicationReady();
    } else if (command === "gate" && process.argv.length === 5
      && version !== undefined && sourceCommit !== undefined) {
      validateReleaseCandidate(version, sourceCommit, repositoryCompletionRefs());
    } else if (command === "replay" && process.argv.length === 5
      && version !== undefined && sourceCommit !== undefined) {
      validateReleaseReplay(version, sourceCommit, repositoryCompletionRefs());
    } else if (command === "status" && process.argv.length === 5
      && version !== undefined && sourceCommit !== undefined) {
      process.stdout.write(
        `${validateReleaseReplay(version, sourceCommit, repositoryCompletionRefs())}\n`
      );
    } else {
      throw new Error(
        "usage: release-completion.ts ready"
        + " | release-completion.ts <gate|replay|status> <version> <source-commit>"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-completion: ${message}\n`);
    process.exitCode = 1;
  }
}
