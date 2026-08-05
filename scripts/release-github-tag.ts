#!/usr/bin/env -S node --import tsx

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSemVer } from "../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  boundedGhExecutable,
  runReleaseGh,
  type GitHubReleaseEnvironment
} from "./release-github-client.js";

const COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG_RULESET_NAME = "tag: v* immutable";
const REQUIRED_TAG_RULES = new Set(["deletion", "non_fast_forward", "update"]);

export interface VerifyRemoteReleaseTagOptions {
  readonly version: string;
  readonly sourceCommit: string;
  readonly environment: GitHubReleaseEnvironment;
  readonly ghExecutable?: string;
}

/** Verifies the exact remote tag and the rule that prevents later movement. */
export async function verifyRemoteReleaseTag(
  options: VerifyRemoteReleaseTagOptions
): Promise<void> {
  if (!isSemVer(options.version)) throw new Error("GitHub release version is not SemVer");
  if (!COMMIT.test(options.sourceCommit)) {
    throw new Error("GitHub release source commit is not canonical");
  }
  const repository = requiredMatch(
    options.environment.GITHUB_REPOSITORY,
    REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  const gh = boundedGhExecutable(
    options.ghExecutable
      ?? requiredValue(options.environment.RELEASE_GH_PATH, "RELEASE_GH_PATH")
  );
  await requireImmutableTagRuleset(gh, repository, options.environment);
  const tag = `v${options.version}`;
  const commit = await remoteTagCommit(gh, tag, repository, options.environment);
  if (commit !== options.sourceCommit) {
    throw new Error(`Remote release tag ${tag} does not target the dispatch commit`);
  }
}

async function requireImmutableTagRuleset(
  gh: string,
  repository: string,
  environment: GitHubReleaseEnvironment
): Promise<void> {
  const listed = await runReleaseGh(
    gh,
    ["api", `repos/${repository}/rulesets?per_page=100`],
    environment
  );
  const rulesets = jsonArray(listed.stdout, "GitHub repository rulesets");
  const matches = rulesets.filter((value) => {
    return isRecord(value) && value.name === TAG_RULESET_NAME;
  });
  if (matches.length !== 1) {
    throw new Error(`GitHub repository needs one ${TAG_RULESET_NAME} ruleset`);
  }
  const summary = matches[0] as Record<string, unknown>;
  if (!Number.isSafeInteger(summary.id) || summary.target !== "tag"
    || summary.enforcement !== "active") {
    throw new Error(`GitHub ruleset ${TAG_RULESET_NAME} is not active`);
  }
  const detail = await runReleaseGh(
    gh,
    ["api", `repos/${repository}/rulesets/${String(summary.id)}`],
    environment
  );
  validateTagRuleset(jsonObject(detail.stdout, `GitHub ruleset ${TAG_RULESET_NAME}`));
}

function validateTagRuleset(ruleset: Record<string, unknown>): void {
  if (ruleset.name !== TAG_RULESET_NAME || ruleset.target !== "tag"
    || ruleset.enforcement !== "active") {
    throw new Error(`GitHub ruleset ${TAG_RULESET_NAME} is not active`);
  }
  // GitHub omits this field from responses to the workflow token. Repository
  // administration remains trusted because an administrator can also disable
  // the ruleset. Refuse a bypass when the API discloses one.
  if (ruleset.bypass_actors !== undefined) {
    const bypass = arrayValue(ruleset.bypass_actors, "bypass actors");
    if (bypass.length !== 0) {
      throw new Error(`GitHub ruleset ${TAG_RULESET_NAME} permits a bypass`);
    }
  }
  const conditions = recordValue(ruleset.conditions, "conditions");
  const refName = recordValue(conditions.ref_name, "ref-name conditions");
  const includes = arrayValue(refName.include, "included refs");
  const excludes = arrayValue(refName.exclude, "excluded refs");
  if (!includes.includes("refs/tags/v*") || excludes.length !== 0) {
    throw new Error(`GitHub ruleset ${TAG_RULESET_NAME} does not cover release tags`);
  }
  const rules = arrayValue(ruleset.rules, "rules");
  const types = new Set(rules.map((value) => {
    return recordValue(value, "rule").type;
  }));
  if ([...REQUIRED_TAG_RULES].some((type) => !types.has(type))) {
    throw new Error(`GitHub ruleset ${TAG_RULESET_NAME} permits tag movement`);
  }
}

async function remoteTagCommit(
  gh: string,
  tag: string,
  repository: string,
  environment: GitHubReleaseEnvironment
): Promise<string> {
  const refName = `refs/tags/${tag}`;
  const { stdout } = await runReleaseGh(
    gh,
    ["api", `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`],
    environment
  );
  const response = jsonObject(stdout, `Remote release tag ${tag}`);
  if (response.ref !== refName) {
    throw new Error(`Remote release tag ${tag} returned the wrong ref`);
  }
  let object = gitObject(response.object, `Remote release tag ${tag}`);
  const visited = new Set<string>();
  while (object.type === "tag") {
    if (visited.size >= 8 || visited.has(object.sha)) {
      throw new Error(`Remote release tag ${tag} has an invalid tag chain`);
    }
    visited.add(object.sha);
    const tagged = await runReleaseGh(
      gh,
      ["api", `repos/${repository}/git/tags/${object.sha}`],
      environment
    );
    object = gitObject(
      jsonObject(tagged.stdout, `Remote release tag object ${object.sha}`).object,
      `Remote release tag object ${object.sha}`
    );
  }
  if (object.type !== "commit") {
    throw new Error(`Remote release tag ${tag} did not resolve to a commit`);
  }
  return object.sha;
}

function gitObject(value: unknown, label: string): {
  readonly type: string;
  readonly sha: string;
} {
  const object = recordValue(value, "Git object");
  if (typeof object.type !== "string"
    || typeof object.sha !== "string" || !COMMIT.test(object.sha)) {
    throw new Error(`${label} has an invalid Git object`);
  }
  return Object.freeze({ type: object.type, sha: object.sha });
}

function jsonArray(stdout: string, label: string): unknown[] {
  const value = parseJsonRejectingDuplicateKeys(stdout);
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function jsonObject(stdout: string, label: string): Record<string, unknown> {
  return recordValue(parseJsonRejectingDuplicateKeys(stdout), label);
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub ruleset ${label} is not an array`);
  return value;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredMatch(
  value: string | undefined,
  pattern: RegExp,
  name: string
): string {
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
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
    if (command !== "verify-tag" || version === undefined || sourceCommit === undefined
      || process.argv.length !== 5) {
      throw new Error("usage: release-github-tag.ts verify-tag <version> <source-commit>");
    }
    await verifyRemoteReleaseTag({
      version,
      sourceCommit,
      environment: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-github-tag: ${message}\n`);
    process.exitCode = 1;
  }
}
