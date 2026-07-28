import { isCanonicalTimestamp } from "../shared/build-identity.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  createReleaseIdentitySet,
  type ReleasePackageVersions,
  type ReleaseSourceEvidence
} from "./release-identity.js";

/**
 * Interprets captured Git output. Nothing here runs a subprocess or touches the
 * filesystem, so every refusal below is reachable from a unit test that supplies
 * strings, and the module that actually invokes Git stays thin enough to read.
 * `test/release-evidence.test.ts` drives the structural refusals that way and
 * keeps the fixture repositories as the proof that real signatures verify.
 *
 * `ReleaseSourceEvidence` types `sourceDirty` as `false` and `tagSignature` as
 * `"verified"`, so the document cannot describe a failure. Every bad state is
 * therefore an exception naming what was wrong, never a field.
 */

const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_TAG_NAME = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SIGNATURE_BLOCK = /^-----BEGIN [A-Z0-9 ]{0,32}SIGNATURE-----$/m;
const ALLOWED_SIGNER_KEY_DATA = /^[A-Za-z0-9+/]{32,}={0,2}$/;
/**
 * `ssh-keygen -Y verify` reports a match as
 * `Good "git" signature for <principal> with <type> key SHA256:<fingerprint>`.
 * The `for <principal>` clause appears only when the signing key was found in
 * the allowed-signers file: an untrusted key still prints `Good "git" signature`
 * followed by `No principal matched.`, so matching on the word "Good" alone
 * would accept exactly the forgery this module exists to refuse.
 */
const SSH_GOOD_SIGNATURE = /^Good "git" signature for (\S+) with (\S+) key (SHA256:[A-Za-z0-9+/]{43})$/;
/**
 * Shape of an OpenSSH key algorithm name, used only to tell the key fields of an
 * `allowed_signers` line apart from its option fields (`cert-authority`,
 * `namespaces="git"`). It is deliberately wide — certificate and security-key
 * forms included — because `ssh-keygen` alone decides which algorithms it
 * accepts, and this module is downstream of that decision. A narrow allowlist
 * here could only fail a release over algorithm drift it has no say in.
 */
const ALLOWED_SIGNER_KEY_TYPE =
  /^(?:sk-)?(?:ssh-(?:ed25519|rsa|dss)|rsa-sha2-(?:256|512)|ecdsa-sha2-nistp(?:256|384|521))(?:-cert-v01)?(?:@openssh\.com)?$/;
const MAX_DETAIL_CHARACTERS = 400;

/** One captured Git invocation. Non-zero exits are data, not thrown errors, so
 *  the interpreting half decides which failure the caller is told about. */
export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AllowedSigner {
  readonly principals: readonly string[];
  readonly keyType: string;
  readonly keyData: string;
}

export interface VerifiedTagSignature {
  readonly principal: string;
  readonly keyType: string;
  readonly keyFingerprint: string;
}

export interface ReleaseEvidenceObservations {
  readonly tagName: string;
  readonly buildTimestamp: string;
  readonly signerPolicyRef: string;
  readonly signerPolicyPath: string;
  readonly protectedRef: string;
  readonly headCommit: CommandOutcome;
  readonly workingTreeStatus: CommandOutcome;
  readonly tagObjectType: CommandOutcome;
  readonly tagObject: CommandOutcome;
  readonly tagTargetCommit: CommandOutcome;
  readonly protectedReachability: CommandOutcome;
  readonly signerPolicy: CommandOutcome;
  readonly tagVerification: CommandOutcome;
  readonly rootManifest: CommandOutcome;
  readonly tuiManifest: CommandOutcome;
  readonly rootLock: CommandOutcome;
}

export interface ReleaseEvidenceDocument {
  readonly evidence: ReleaseSourceEvidence;
  readonly signature: VerifiedTagSignature;
}

/**
 * Turns one round of captured Git output into the evidence document, or throws.
 * The order matters: cheap structural refusals run before signature checks so a
 * broken release reports the thing a maintainer can act on first.
 */
export function assembleReleaseSourceEvidence(
  observations: ReleaseEvidenceObservations
): ReleaseEvidenceDocument {
  const tagName = requireReleaseTagName(observations.tagName);
  const buildTimestamp = requireCanonicalTimestamp(observations.buildTimestamp);
  const sourceCommit = requireCommitObjectName(observations.headCommit, "Release source commit");
  requireCleanWorkingTree(observations.workingTreeStatus);
  requireAnnotatedTag(observations.tagObjectType, tagName);
  const tagTargetCommit = requireCommitObjectName(
    observations.tagTargetCommit,
    `Release tag ${tagName} target commit`
  );
  if (tagTargetCommit !== sourceCommit) {
    throw new Error(`Release tag ${tagName} does not point at the release commit ${sourceCommit}`);
  }
  requireProtectedReachability(
    observations.protectedReachability,
    sourceCommit,
    observations.protectedRef
  );

  const policyLabel = `Release signer policy ${observations.signerPolicyRef}:${observations.signerPolicyPath}`;
  if (observations.signerPolicy.exitCode !== 0) {
    throw new Error(`${policyLabel} could not be read: ${commandDetail(observations.signerPolicy)}`);
  }
  // Parsed for the diagnosis, not for the verdict. `ssh-keygen` was handed this
  // exact file and has already ruled on it; parsing it here turns "signature is
  // not from an allowed signer" into "policy names no supported key type" when
  // the policy path points at something that is not a policy at all.
  parseAllowedSigners(observations.signerPolicy.stdout, policyLabel);
  requireSignedTagObject(observations.tagObject, tagName);
  const signature = interpretTagSignature(observations.tagVerification, tagName);

  const packageVersions = parseReleasePackageVersions({
    rootManifest: successfulOutput(observations.rootManifest, "Release root package manifest"),
    tuiManifest: successfulOutput(observations.tuiManifest, "Release tui package manifest"),
    rootLock: successfulOutput(observations.rootLock, "Release root package lock")
  });
  if (tagName !== `v${packageVersions.root}`) {
    throw new Error(`Release tag ${tagName} does not match product version ${packageVersions.root}`);
  }

  // Round-tripping through the validator the release build consumes means the
  // producer cannot emit a document its own consumer would reject.
  const identities = createReleaseIdentitySet({
    schemaVersion: 1,
    productVersion: packageVersions.root,
    sourceCommit,
    sourceDirty: false,
    tagName,
    tagObjectType: "annotated",
    tagSignature: "verified",
    tagTargetCommit,
    buildTimestamp,
    packageVersions
  });
  return Object.freeze({ evidence: identities.evidence, signature });
}

/**
 * Parses an OpenSSH `allowed_signers` policy. The file is handed to `ssh-keygen`
 * verbatim; this parse exists so an empty or unreadable-as-a-policy file fails
 * closed here, with a message naming the real problem, rather than surfacing as
 * a signature that simply would not verify.
 *
 * It is not a membership oracle and must not become one. Under a
 * `cert-authority` line the principal `ssh-keygen` reports is the one carried by
 * the certificate, which appears nowhere in the file it was matched against.
 * Principals here are split on whitespace and commas, so OpenSSH's quoted form —
 * `"Release Bot" ssh-ed25519 …` — yields the literal first field, `"Release`.
 * That is wrong and harmless: nothing compares these principals to anything.
 */
export function parseAllowedSigners(text: string, label: string): readonly AllowedSigner[] {
  if (text.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  const signers: AllowedSigner[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    signers.push(parseAllowedSignerLine(line, label));
  }
  if (signers.length === 0) throw new Error(`${label} lists no allowed signers`);
  return Object.freeze(signers);
}

/**
 * Accepts a tag signature only when Git exited zero, reported exactly one status
 * line, and that line is the OpenSSH "matched a principal" form. Anything else —
 * an extra line, an OpenPGP status block, an unfamiliar phrasing — is a refusal.
 * Unfamiliar output is a refusal on purpose: this parser cannot tell a future
 * status wording from a forged one, so it declines to guess.
 *
 * Deciding *which* principals the policy admits belongs to `ssh-keygen`, which
 * matched against the same file this run supplied and whose verdict is Git's
 * exit code above. Re-checking the reported principal against a parse of that
 * file cannot catch anything the exit code let through, and does refuse the
 * certificate-authority form OpenSSH supports. Do not reinstate it.
 */
export function interpretTagSignature(
  verification: CommandOutcome,
  tagName: string
): VerifiedTagSignature {
  if (verification.exitCode !== 0) {
    throw new Error(
      `Release tag ${tagName} signature is not from an allowed signer: ${commandDetail(verification)}`
    );
  }
  const lines = verification.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const status = lines.length === 1 ? lines[0] : undefined;
  const match = status === undefined ? null : SSH_GOOD_SIGNATURE.exec(status);
  const principal = match?.[1];
  const keyType = match?.[2];
  const keyFingerprint = match?.[3];
  if (principal === undefined || keyType === undefined || keyFingerprint === undefined) {
    throw new Error(
      `Release tag ${tagName} signature verification reported an unrecognised status: ${commandDetail(verification)}`
    );
  }
  return Object.freeze({ principal, keyType, keyFingerprint });
}

export interface ReleaseManifestSources {
  readonly rootManifest: string;
  readonly tuiManifest: string;
  readonly rootLock: string;
}

/** Reads the four product versions and refuses any disagreement between them. */
export function parseReleasePackageVersions(
  sources: ReleaseManifestSources
): ReleasePackageVersions {
  const lock = jsonObject(sources.rootLock, "package-lock.json");
  const lockPackages = jsonRecord(lock.packages, "package-lock.json packages");
  const lockRootPackage = jsonRecord(lockPackages[""], "package-lock.json root package entry");
  const versions = {
    root: versionField(jsonObject(sources.rootManifest, "package.json").version, "package.json"),
    tui: versionField(jsonObject(sources.tuiManifest, "tui/package.json").version, "tui/package.json"),
    rootLock: versionField(lock.version, "package-lock.json"),
    rootLockPackage: versionField(lockRootPackage.version, "package-lock.json root package entry")
  };
  if (new Set(Object.values(versions)).size !== 1) {
    throw new Error(`Release package versions disagree: ${JSON.stringify(versions)}`);
  }
  return Object.freeze(versions);
}

export function requireReleaseTagName(value: string): string {
  if (!RELEASE_TAG_NAME.test(value)) {
    throw new Error(`Release tag name ${JSON.stringify(value)} must be v<semver>`);
  }
  return value;
}

/** The timestamp shared by every target in a release, validated by the same
 *  predicate the build identity it ends up inside is validated with. */
export function requireCanonicalTimestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new Error(
      `Release build timestamp ${JSON.stringify(value)} must be a millisecond-precision UTC instant`
    );
  }
  return value;
}

/** A full object name from a successful `rev-parse`, so a short or symbolic
 *  answer never reaches the document or a later command line. */
export function requireCommitObjectName(outcome: CommandOutcome, label: string): string {
  const value = successfulOutput(outcome, label).trim();
  if (!COMMIT.test(value)) throw new Error(`${label} is not a full object name`);
  return value;
}

function parseAllowedSignerLine(line: string, label: string): AllowedSigner {
  const fields = line.split(/[ \t]+/);
  const principalField = fields[0] ?? "";
  const principals = principalField.split(",").filter((principal) => principal.length > 0);
  if (principals.length === 0) throw new Error(`${label} has an entry without a principal`);
  for (const [index, keyType] of fields.entries()) {
    // Field 0 is the principal list; the rest are options until one has the
    // shape of a key algorithm, which is where the key begins.
    if (index === 0 || !ALLOWED_SIGNER_KEY_TYPE.test(keyType)) continue;
    const keyData = fields[index + 1];
    if (keyData === undefined || !ALLOWED_SIGNER_KEY_DATA.test(keyData)) {
      throw new Error(`${label} entry for ${principals.join(",")} has malformed key data`);
    }
    return Object.freeze({ principals: Object.freeze(principals), keyType, keyData });
  }
  throw new Error(`${label} entry for ${principals.join(",")} names no supported key type`);
}

function requireCleanWorkingTree(status: CommandOutcome): void {
  const porcelain = successfulOutput(status, "Release working tree status");
  if (porcelain.trim().length !== 0) {
    throw new Error(`Release source tree is dirty: ${truncate(porcelain.trim())}`);
  }
}

function requireAnnotatedTag(objectType: CommandOutcome, tagName: string): void {
  if (objectType.exitCode !== 0) {
    throw new Error(`Release tag ${tagName} could not be resolved: ${commandDetail(objectType)}`);
  }
  if (objectType.stdout.trim() !== "tag") {
    throw new Error(
      `Release tag ${tagName} is not an annotated tag object but a ${truncate(objectType.stdout.trim())}`
    );
  }
}

function requireSignedTagObject(tagObject: CommandOutcome, tagName: string): void {
  const body = successfulOutput(tagObject, `Release tag ${tagName} object`);
  if (!SIGNATURE_BLOCK.test(body)) throw new Error(`Release tag ${tagName} carries no signature`);
}

function requireProtectedReachability(
  reachability: CommandOutcome,
  sourceCommit: string,
  protectedRef: string
): void {
  if (reachability.exitCode !== 0) {
    throw new Error(
      `Release commit ${sourceCommit} is not reachable from protected ref ${protectedRef}: ${commandDetail(reachability)}`
    );
  }
}

function successfulOutput(outcome: CommandOutcome, label: string): string {
  if (outcome.exitCode !== 0) {
    throw new Error(`${label} could not be read: ${commandDetail(outcome)}`);
  }
  return outcome.stdout;
}

function jsonObject(text: string, label: string): Record<string, unknown> {
  return jsonRecord(parseJsonRejectingDuplicateKeys(text), label);
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function versionField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} has no version string`);
  }
  return value;
}

function commandDetail(outcome: CommandOutcome): string {
  const detail = `${outcome.stderr}\n${outcome.stdout}`.trim().replace(/\s*\n\s*/g, " / ");
  return `exit ${outcome.exitCode}${detail.length === 0 ? "" : ` ${truncate(detail)}`}`;
}

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_CHARACTERS
    ? value
    : `${value.slice(0, MAX_DETAIL_CHARACTERS)}…`;
}
