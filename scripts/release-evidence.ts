#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  assembleReleaseSourceEvidence,
  assembleReleaseTagAuthorization,
  requireCanonicalTimestamp,
  requireCommitObjectName,
  requireReleaseTagName,
  type CommandOutcome,
  type ReleaseEvidenceDocument,
  type ReleaseTagAuthorizationDocument,
  type ReleaseTagAuthorizationObservations
} from "./release-evidence-inspection.js";

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
 * Git, at an object name or a ref this module chose, and `writeFile` only ever
 * puts the signer policy somewhere Git can be pointed at. That is an invariant,
 * not a habit: `test/release-evidence.test.ts` fails if a read API appears in
 * this source, and the fixtures fail if the policy comes off disk.
 */

/**
 * The ref carrying the signer policy. It must be protected independently of the
 * branch a release is cut from, and it is deliberately a caller-visible input
 * because the release workflow supplies it.
 */
export const DEFAULT_SIGNER_POLICY_REF = "refs/remotes/origin/release-policy";
export const DEFAULT_SIGNER_POLICY_PATH = "allowed-signers";
/** The release commit must be reachable from this ref, so a tag on a side
 *  branch cannot authorise a release. */
export const DEFAULT_PROTECTED_REF = "refs/remotes/origin/main";
/**
 * Where the signature verifier is looked for when the caller names none.
 * `PATH` is deliberately not consulted: `gpg.ssh.program` accepts a bare name,
 * and a bare name is whatever a release runner put earliest in `PATH`. A
 * substitute that prints one accepting status line and exits zero is believed by
 * Git and then by this module, so the one program whose verdict is trusted here
 * is named by absolute path or the release is refused.
 */
export const DEFAULT_SIGNATURE_VERIFIERS: readonly string[] = Object.freeze([
  "/usr/bin/ssh-keygen",
  "/bin/ssh-keygen"
]);

const GIT_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;
const REPOSITORY_PATH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export interface ReleaseTagAuthorizationRequest {
  readonly repositoryRoot: string;
  readonly tagName: string;
  readonly signerPolicyRef?: string;
  readonly signerPolicyPath?: string;
  readonly protectedRef?: string;
  /** Absolute path to the `ssh-keygen` that verifies the tag signature.
   *  Defaults to the first of `DEFAULT_SIGNATURE_VERIFIERS` that exists. */
  readonly sshKeygenPath?: string;
  /** Extra variables merged over the hermetic environment below. Callers extend
   *  it; nothing that matters has to be subtracted from it. */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ReleaseEvidenceRequest extends ReleaseTagAuthorizationRequest {
  /** Millisecond-precision UTC instant shared by every target in a release; an
   *  input rather than something this module invents. */
  readonly buildTimestamp: string;
}

export async function collectReleaseEvidence(
  request: ReleaseEvidenceRequest
): Promise<ReleaseEvidenceDocument> {
  const buildTimestamp = requireCanonicalTimestamp(request.buildTimestamp);
  return collectWithTagAuthorization(
    request,
    async (authorization, git, sourceCommit) => {
      return assembleReleaseSourceEvidence({
        ...authorization,
        buildTimestamp,
        // Product facts come from the released commit. Only the signer policy
        // must be anchored outside the artifact that it admits.
        rootManifest: await git(["show", `${sourceCommit}:package.json`]),
        tuiManifest: await git(["show", `${sourceCommit}:tui/package.json`]),
        rootLock: await git(["show", `${sourceCommit}:package-lock.json`])
      });
    }
  );
}

export async function collectReleaseTagAuthorization(
  request: ReleaseTagAuthorizationRequest
): Promise<ReleaseTagAuthorizationDocument> {
  return collectWithTagAuthorization(
    request,
    (observations) => assembleReleaseTagAuthorization(observations)
  );
}

type GitRunner = (args: readonly string[]) => Promise<CommandOutcome>;

async function collectWithTagAuthorization<T>(
  request: ReleaseTagAuthorizationRequest,
  consume: (
    observations: ReleaseTagAuthorizationObservations,
    git: GitRunner,
    sourceCommit: string
  ) => Promise<T> | T
): Promise<T> {
  const tagName = requireReleaseTagName(request.tagName);
  const signerPolicyRef = gitRefName(
    request.signerPolicyRef ?? DEFAULT_SIGNER_POLICY_REF,
    "Release signer policy ref"
  );
  const signerPolicyPath = repositoryPath(
    request.signerPolicyPath ?? DEFAULT_SIGNER_POLICY_PATH,
    "Release signer policy path"
  );
  const protectedRef = gitRefName(
    request.protectedRef ?? DEFAULT_PROTECTED_REF,
    "Release protected ref"
  );
  const verifier = resolveSignatureVerifier(request.sshKeygenPath);
  const repositoryRoot = realpathSync(request.repositoryRoot);
  const tagRef = `refs/tags/${tagName}`;
  const environment = hermeticEnvironment(request.environment);
  const git = (args: readonly string[]): Promise<CommandOutcome> =>
    runGit(repositoryRoot, args, environment);

  // Resolved once, then named explicitly by every read below. `HEAD` is
  // symbolic: re-resolving it per command lets a branch that moves mid-run
  // splice one commit's identity onto another's manifests, and every downstream
  // check would still pass because they only compare versions to each other.
  const headCommit = await git(["rev-parse", "--verify", "HEAD"]);
  const sourceCommit = requireCommitObjectName(headCommit, "Release source commit");

  // The signer set is read out of the object database at an independently
  // protected ref, never off disk and never out of the commit being released.
  // Anyone who can push a tag can also add their own key to a working-tree or
  // in-commit allowed-signers file and then produce a signature that verifies
  // against it, so a candidate checked against its own key list authorises
  // itself and the check proves nothing. Do not "simplify" this into a direct
  // read of path.join(repositoryRoot, signerPolicyPath); that is the defect, not
  // a shortcut, and it looks correct in every test whose attacker key is absent
  // from the working tree.
  //
  // What the protection is: an operational precondition, not something this
  // module can establish. `refs/remotes/origin/*` are ordinary local refs that
  // any local process may write, and nothing here can tell an authenticated
  // fetch from a hand-crafted `update-ref`. The guarantee comes from running
  // this against a fresh clone whose refs were fetched from the forge, with no
  // untrusted process touching `.git` in between.
  const signerPolicy = await git(["show", `${signerPolicyRef}:${signerPolicyPath}`]);

  const signersDirectory = await mkdtemp(
    path.join(realpathSync(tmpdir()), "1667-release-signers-")
  );
  try {
    if (isInside(repositoryRoot, signersDirectory)) {
      throw new Error("Release signer policy scratch directory must sit outside the repository");
    }
    // Git needs the policy as a file. It goes to a private scratch path outside
    // the repository so verification never depends on, and never leaves, a file
    // in the tree being released.
    const signersFile = path.join(signersDirectory, "allowed-signers");
    await writeFile(signersFile, signerPolicy.stdout, { mode: 0o600 });

    const observations: ReleaseTagAuthorizationObservations = {
      tagName,
      signerPolicyRef,
      signerPolicyPath,
      protectedRef,
      signerPolicy,
      headCommit,
      workingTreeStatus: await git(["status", "--porcelain=v1", "--untracked-files=all"]),
      tagObjectType: await git(["cat-file", "-t", tagRef]),
      tagObject: await git(["cat-file", "tag", tagRef]),
      tagTargetCommit: await git(["rev-parse", "--verify", `${tagRef}^{commit}`]),
      protectedReachability: await git(["merge-base", "--is-ancestor", sourceCommit, protectedRef]),
      // `-c` outranks system, global and repository configuration, so no
      // `.git/config` on the release runner can redirect the allowed-signers
      // file. What `-c` does not do is decide which program `gpg.ssh.program`
      // names: a bare `ssh-keygen` is resolved through `PATH` at spawn time, and
      // a planted one that prints an accepting status line and exits zero is
      // believed. `verifier` is therefore an absolute path this process checked.
      // `--raw` keeps the tag message off the stream that is parsed.
      tagVerification: await git([
        "-c",
        "gpg.format=ssh",
        "-c",
        `gpg.ssh.program=${verifier}`,
        "-c",
        `gpg.ssh.allowedSignersFile=${signersFile}`,
        "verify-tag",
        "--raw",
        tagRef
      ])
    };
    return await consume(observations, git, sourceCommit);
  } finally {
    await rm(signersDirectory, { recursive: true, force: true });
  }
}

/**
 * Builds the environment the Git children see, rather than inheriting one.
 * Ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_*` and `GIT_CONFIG_PARAMETERS`
 * can each redirect which repository is read or which configuration wins —
 * `GIT_CONFIG_PARAMETERS` carries the same weight as the `-c` pins above — so
 * inheriting everything and then pinning one variable is not hermeticity, it is
 * the appearance of it. Anything genuinely needed is listed here; anything a
 * caller needs on top is merged over it.
 */
function hermeticEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    // Git itself is still found on `PATH`; the signature verifier is not.
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    // Git's output is parsed, so the locale it is phrased in is part of that.
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    ...extra
  };
}

/** Resolves the signature verifier to an absolute regular file, or refuses.
 *  There is no fall back to the bare name: that is the hole being closed. */
function resolveSignatureVerifier(requested: string | undefined): string {
  if (requested !== undefined && !path.isAbsolute(requested)) {
    throw new Error(
      `Release signature verifier ${JSON.stringify(requested)} must be an absolute path`
    );
  }
  const candidates = requested === undefined ? DEFAULT_SIGNATURE_VERIFIERS : [requested];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `Release signature verifier was not found at ${candidates.join(" or ")};`
    + " name one with --ssh-keygen"
  );
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

function repositoryPath(value: string, label: string): string {
  if (!REPOSITORY_PATH.test(value) || value.includes("..")) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a plain repository path`);
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
  ["--signer-policy-ref", "signerPolicyRef"],
  ["--signer-policy-path", "signerPolicyPath"],
  ["--protected-ref", "protectedRef"],
  ["--ssh-keygen", "sshKeygenPath"]
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
        + " [--repository <dir>] [--signer-policy-ref <ref>] [--signer-policy-path <path>]"
        + " [--protected-ref <ref>] [--ssh-keygen <absolute path>]"
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
    signerPolicyRef: parsed.get("signerPolicyRef"),
    signerPolicyPath: parsed.get("signerPolicyPath"),
    protectedRef: parsed.get("protectedRef"),
    sshKeygenPath: parsed.get("sshKeygenPath")
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
    const document = await collectReleaseEvidence(
      parseReleaseEvidenceArguments(process.argv.slice(2))
    );
    process.stdout.write(`${canonicalJson(document.evidence)}\n`);
    process.stderr.write(
      `release-tag-signer ${document.signature.principal} ${document.signature.keyFingerprint}\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-evidence: ${message}\n`);
    process.exitCode = 1;
  }
}
