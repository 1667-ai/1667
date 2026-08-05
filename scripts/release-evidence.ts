#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  assembleReleaseSourceEvidence,
  requireCanonicalTimestamp,
  requireObjectName,
  requireReleaseTagName,
  type CommandOutcome,
  type ReleaseEvidenceObservations
} from "./release-evidence-inspection.js";
import { type ReleaseSourceEvidence } from "./release-identity.js";

/**
 * Collects the source evidence `scripts/release-preflight.ts` is forbidden to
 * collect. Preflight performs no build, no extraction, no network access and no
 * Git invocation; this module sits outside that boundary and hands it an input.
 *
 * Running Git and interpreting Git are separated deliberately: everything here
 * captures output, and `./release-evidence-inspection.js` decides what the
 * output means.
 *
 * Nothing here reads a file. Every fact about the repository arrives through
 * Git, at an object name or a ref this module chose. That is an invariant, not
 * a habit: `test/release-evidence.test.ts` fails if a read API appears in this
 * source.
 *
 * This module verifies no tag signature. There is no user of this product yet,
 * and the signing-key requirement that once gated a release here returns
 * before there is one — see docs/RELEASING.md. An annotated or a lightweight
 * unsigned tag is accepted equally, and the evidence records which shape it
 * has. A signature-bearing annotated tag is refused because this collector
 * does not verify it.
 */

/** The release commit must be reachable from this ref, so a tag on a side
 *  branch cannot authorise a release. */
export const DEFAULT_PROTECTED_REF = "refs/remotes/origin/main";

const GIT_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export interface ReleaseEvidenceRequest {
  readonly repositoryRoot: string;
  readonly tagName: string;
  readonly protectedRef?: string;
  /** Extra variables merged over the hermetic environment below. Callers extend
   *  it; nothing that matters has to be subtracted from it. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Millisecond-precision UTC instant shared by every target in a release; an
   *  input rather than something this module invents. */
  readonly buildTimestamp: string;
}

export async function collectReleaseEvidence(
  request: ReleaseEvidenceRequest
): Promise<ReleaseSourceEvidence> {
  const buildTimestamp = requireCanonicalTimestamp(request.buildTimestamp);
  const tagName = requireReleaseTagName(request.tagName);
  const protectedRef = gitRefName(
    request.protectedRef ?? DEFAULT_PROTECTED_REF,
    "Release protected ref"
  );
  const repositoryRoot = realpathSync(request.repositoryRoot);
  const tagRef = `refs/tags/${tagName}`;
  // One private scratch directory for the whole collection: the empty
  // configuration the Git children are pinned to.
  const scratchDirectory = await mkdtemp(
    path.join(realpathSync(tmpdir()), "1667-release-evidence-")
  );
  try {
    if (isInside(repositoryRoot, scratchDirectory)) {
      throw new Error("Release evidence scratch directory must sit outside the repository");
    }
    // Git refuses `\\.\nul` as a configuration path on Windows, so the empty
    // configuration is a real empty file rather than the null device. A missing
    // path would also read as empty, but a real file in a private directory
    // cannot be created underneath this process by anyone else.
    const emptyConfig = path.join(scratchDirectory, "empty-gitconfig");
    await writeFile(emptyConfig, "", { mode: 0o600 });
    const environment = hermeticEnvironment(request.environment, emptyConfig);
    const git = (args: readonly string[]): Promise<CommandOutcome> =>
      runGit(repositoryRoot, args, environment);
    return await collectFromPinnedTag({
      git,
      tagName,
      tagRef,
      protectedRef,
      buildTimestamp
    });
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

type GitRunner = (args: readonly string[]) => Promise<CommandOutcome>;

interface EvidenceCollection {
  readonly git: GitRunner;
  readonly tagName: string;
  readonly tagRef: string;
  readonly protectedRef: string;
  readonly buildTimestamp: string;
}

async function collectFromPinnedTag(run: EvidenceCollection): Promise<ReleaseSourceEvidence> {
  const { git, tagName, tagRef, protectedRef, buildTimestamp } = run;

  // Resolved once, then named explicitly by every read below. `HEAD` is
  // symbolic: re-resolving it per command lets a branch that moves mid-run
  // splice one commit's identity onto another's manifests, and every downstream
  // check would still pass because they only compare versions to each other.
  const headCommit = await git(["rev-parse", "--verify", "HEAD"]);
  const sourceCommit = requireObjectName(headCommit, "Release source commit");
  const tagObjectName = await git(["rev-parse", "--verify", tagRef]);
  const resolvedTagObject = requireObjectName(
    tagObjectName,
    `Release tag ${tagName} object`
  );

  const observations: ReleaseEvidenceObservations = {
    tagName,
    protectedRef,
    buildTimestamp,
    headCommit,
    workingTreeStatus: await git(["status", "--porcelain=v1", "--untracked-files=all"]),
    // "tag" for an annotated tag object, "commit" for a lightweight tag. Use
    // the pinned object name for each read so a moving ref cannot splice two
    // objects into one evidence document.
    tagObjectType: await git(["cat-file", "-t", resolvedTagObject]),
    // An annotated tag must contain no supported signature armor before the
    // evidence can state that it is unsigned. This command fails for a
    // lightweight tag, which has no tag object. The interpreter ignores that
    // expected failure after it observes the lightweight shape.
    tagObjectContents: await git(["cat-file", "tag", resolvedTagObject]),
    // Peels either tag form to the commit it names.
    tagTargetCommit: await git(["rev-parse", "--verify", `${resolvedTagObject}^{commit}`]),
    protectedReachability: await git(["merge-base", "--is-ancestor", sourceCommit, protectedRef]),
    // Product facts come from the released commit.
    rootManifest: await git(["show", `${sourceCommit}:package.json`]),
    tuiManifest: await git(["show", `${sourceCommit}:tui/package.json`]),
    rootLock: await git(["show", `${sourceCommit}:package-lock.json`])
  };
  const evidence = assembleReleaseSourceEvidence(observations);
  const finalTagObject = requireObjectName(
    await git(["rev-parse", "--verify", tagRef]),
    `Release tag ${tagName} final object`
  );
  if (finalTagObject !== resolvedTagObject) {
    throw new Error(`Release tag ${tagName} moved while source evidence was collected`);
  }
  return evidence;
}

/**
 * Builds the environment the Git children see, rather than inheriting one.
 * Ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_*` and `GIT_CONFIG_PARAMETERS`
 * can each redirect which repository is read or which configuration wins, so
 * inheriting everything and then pinning one variable is not hermeticity, it is
 * the appearance of it. Anything genuinely needed is listed here; anything a
 * caller needs on top is merged over it.
 */
function hermeticEnvironment(
  extra: NodeJS.ProcessEnv | undefined,
  emptyConfig: string
): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    // Git's output is parsed, so the locale it is phrased in is part of that.
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    ...extra
  };
}

/** Runs one Git command with `execFile`, never a shell string, and reports a
 *  non-zero exit as data so the interpreting half chooses the message. */
async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<CommandOutcome> {
  return await new Promise<CommandOutcome>((resolve, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(Object.freeze({ exitCode: 0, stdout, stderr }));
        return;
      }
      const code: unknown = (error as { code?: unknown }).code;
      if (typeof code === "number") {
        resolve(Object.freeze({ exitCode: code, stdout, stderr }));
        return;
      }
      // A missing Git, a timeout, or an output-size overrun is a failure to
      // observe the release at all. It never degrades into a warning.
      reject(new Error(`Release evidence could not run git ${args.join(" ")}`, { cause: error }));
    });
  });
}

function gitRefName(value: string, label: string): string {
  if (!GIT_REF_NAME.test(value) || value.includes("..")) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a plain ref name`);
  }
  return value;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length === 0
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const OPTION_KEYS = new Map<string, keyof ReleaseEvidenceRequest>([
  ["--repository", "repositoryRoot"],
  ["--tag", "tagName"],
  ["--build-timestamp", "buildTimestamp"],
  ["--protected-ref", "protectedRef"]
]);

export function parseReleaseEvidenceArguments(
  argv: readonly string[]
): ReleaseEvidenceRequest {
  const parsed = new Map<keyof ReleaseEvidenceRequest, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag === undefined ? undefined : OPTION_KEYS.get(flag);
    if (key === undefined || value === undefined) {
      throw new Error(
        "usage: release-evidence.ts --tag <v1.2.3> --build-timestamp <2026-01-01T00:00:00.000Z>"
        + " [--repository <dir>] [--protected-ref <ref>]"
      );
    }
    if (parsed.has(key)) throw new Error(`Release evidence option ${flag} was given twice`);
    parsed.set(key, value);
  }
  const tagName = parsed.get("tagName");
  const buildTimestamp = parsed.get("buildTimestamp");
  if (tagName === undefined || buildTimestamp === undefined) {
    throw new Error("Release evidence requires --tag and --build-timestamp");
  }
  return Object.freeze({
    repositoryRoot: parsed.get("repositoryRoot") ?? process.cwd(),
    tagName,
    buildTimestamp,
    protectedRef: parsed.get("protectedRef")
  });
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
    const evidence = await collectReleaseEvidence(
      parseReleaseEvidenceArguments(process.argv.slice(2))
    );
    process.stdout.write(`${canonicalJson(evidence)}\n`);
    process.stderr.write(
      `release-tag ${evidence.tagName} ${evidence.tagObjectType} ${evidence.tagSignature}\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-evidence: ${message}\n`);
    process.exitCode = 1;
  }
}
