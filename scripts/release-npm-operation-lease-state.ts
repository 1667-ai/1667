import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import type {
  GitHubAnnotatedTag,
  GitHubRef
} from "./release-github-ref-store.js";
import {
  requireNpmOperationIdentity,
  requireNpmOperationIdentityOperation,
  requireNpmOperationRunNumber,
  requireNpmOperationVersion,
  type NpmOperationIdentity
} from "./release-npm-operation-identity.js";

const SHA = /^[0-9a-f]{40}$/u;
const SECRET = /^[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MARKER_REF =
  /^refs\/tags\/npm-operations\/run-([1-9]\d{0,15})-attempt-([1-9]\d{0,15})\/(promotion|quarantine)\/v([^/]+)\/(active|claimed|writer|writer-terminal|revoking|revoked|terminal)$/u;
const OPEN_REF =
  /^refs\/tags\/npm-operations-open\/run-([1-9]\d{0,15})-attempt-([1-9]\d{0,15})\/(promotion|quarantine)\/v([^/]+)$/u;
export class NpmOperationRefNotYetVisibleError extends Error {}

export type NpmOperationLeaseOperation = NpmOperationIdentity["operation"];
export type NpmOperationLeaseTerminal = "complete" | "failed" | "abandoned";
export type NpmOperationWriterOutcome = "success" | "failed";
export type NpmOperationStoredMarker =
  | "active" | "claimed" | "writer" | "writer-terminal"
  | "revoking" | "revoked" | "terminal";

export interface NpmOperationRevocation {
  readonly revokedAt: string;
  readonly revokingTagSha: string;
  readonly sourceCommit: string;
}

export interface NpmOperationTerminalRecord {
  readonly outcome: NpmOperationLeaseTerminal;
  readonly revocationTagSha: string;
}

export interface NpmOperationLeaseRequest extends NpmOperationIdentity {
  readonly repository: string;
}

export interface NpmOperationLeaseSnapshot {
  readonly key: string;
  readonly request: NpmOperationLeaseRequest;
  readonly refs: ReadonlyMap<NpmOperationStoredMarker, GitHubRef>;
}

export interface NpmOperationOpenState {
  readonly request: NpmOperationLeaseRequest;
  readonly state: "pre-active" | "active" | "terminal";
}

export function parseNpmOperationLeaseSnapshot(
  refs: readonly GitHubRef[],
  repository: string
): readonly NpmOperationLeaseSnapshot[] {
  const validatedRepository = requireRepository(repository);
  const groups = new Map<string, {
    request: Omit<NpmOperationLeaseRequest, "repository" | "sourceCommit">;
    refs: Map<NpmOperationStoredMarker, GitHubRef>;
  }>();
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.ref)) throw new Error("npm operation lease repeats a ref");
    seen.add(ref.ref);
    const parsed = parseRef(ref.ref);
    const key = npmOperationLeaseIdentity(parsed.request);
    const group = groups.get(key) ?? { request: parsed.request, refs: new Map() };
    if (group.refs.has(parsed.marker)) {
      throw new Error(`npm operation lease ${key} repeats ${parsed.marker}`);
    }
    requireRefType(ref, parsed.marker === "active" ? "commit" : "tag");
    group.refs.set(parsed.marker, ref);
    groups.set(key, group);
  }
  return Object.freeze([...groups].map(([key, group]) => {
    const active = group.refs.get("active");
    if (active === undefined) {
      throw new Error(`npm operation lease ${key} has no active marker`);
    }
    const request = requireNpmOperationLeaseRequest({
      ...group.request,
      repository: validatedRepository,
      sourceCommit: active.object.sha
    }, validatedRepository);
    return Object.freeze({
      key,
      request,
      refs: group.refs as ReadonlyMap<NpmOperationStoredMarker, GitHubRef>
    });
  }));
}

export function requireNpmOperationLeaseRequest(
  value: NpmOperationLeaseRequest,
  repository: string
): NpmOperationLeaseRequest {
  if (value.repository !== repository) {
    throw new Error("npm operation lease repository does not match the client");
  }
  const identity = requireNpmOperationIdentity(value);
  return Object.freeze({
    repository: requireRepository(value.repository),
    ...identity
  });
}

export function npmOperationLeaseRef(
  request: NpmOperationLeaseRequest,
  marker: NpmOperationStoredMarker
): string {
  return `${npmOperationLeaseIdentity(request)}/${marker}`;
}

export function npmOperationLeaseIdentity(
  request: Omit<NpmOperationLeaseRequest, "repository" | "sourceCommit">
): string {
  return "refs/tags/npm-operations"
    + `/run-${request.runId}-attempt-${request.runAttempt}`
    + `/${request.operation}/v${request.version}`;
}

export function npmOperationOpenRef(
  request: Omit<NpmOperationLeaseRequest, "repository">
): string {
  return "refs/tags/npm-operations-open"
    + `/run-${request.runId}-attempt-${request.runAttempt}`
    + `/${request.operation}/v${request.version}`;
}

export function parseNpmOperationOpenRequest(
  ref: GitHubRef,
  repository: string
): NpmOperationLeaseRequest {
  const match = OPEN_REF.exec(ref.ref);
  if (match === null || ref.object.type !== "commit") {
    throw new Error("npm operation open marker is invalid");
  }
  return requireNpmOperationLeaseRequest({
    repository,
    runId: match[1]!,
    runAttempt: match[2]!,
    operation: operation(match[3]),
    version: match[4]!,
    sourceCommit: ref.object.sha
  }, repository);
}

export function npmOperationTagName(ref: string): string {
  const prefix = "refs/tags/";
  if (!ref.startsWith(prefix)) throw new Error("npm operation lease tag ref is invalid");
  return ref.slice(prefix.length);
}

export function requireNpmOperationMarkerTag(
  ref: GitHubRef,
  tag: GitHubAnnotatedTag,
  request: NpmOperationLeaseRequest,
  marker: Exclude<NpmOperationStoredMarker, "active">
): void {
  if (ref.ref !== npmOperationLeaseRef(request, marker)
    || ref.object.type !== "tag" || tag.sha !== ref.object.sha
    || tag.tag !== npmOperationTagName(ref.ref)
    || tag.object.type !== "commit"
    || tag.object.sha !== request.sourceCommit) {
    throw new Error(`npm operation lease ${marker} tag is invalid`);
  }
}

export function npmOperationClaimMessage(digest: string): string {
  return canonicalJson({ kind: "npm-operation-claim", secretSha256: digest });
}

export function parseNpmOperationClaimMessage(message: string): string {
  return parseSecretMessage(message, "npm-operation-claim", (digest) => {
    return npmOperationClaimMessage(digest);
  });
}

export function npmOperationWriterMessage(
  digest: string,
  claimTagSha: string
): string {
  requireSha(claimTagSha, "claim tag");
  return canonicalJson({
    claimTagSha,
    kind: "npm-operation-writer",
    secretSha256: digest
  });
}

export function parseNpmOperationWriterMessage(message: string): {
  readonly secretSha256: string;
  readonly claimTagSha: string;
} {
  const digest = extract(message, "secretSha256", 64);
  const claimTagSha = extract(message, "claimTagSha", 40);
  if (message !== npmOperationWriterMessage(digest, claimTagSha)) {
    throw new Error("npm operation lease writer tag message is invalid");
  }
  return Object.freeze({ secretSha256: digest, claimTagSha });
}

export function npmOperationWriterTerminalMessage(
  outcome: NpmOperationWriterOutcome,
  writerTagSha: string
): string {
  requireSha(writerTagSha, "writer tag");
  return canonicalJson({
    kind: "npm-operation-writer-terminal",
    outcome,
    writerTagSha
  });
}

export function parseNpmOperationWriterTerminalMessage(message: string): {
  readonly outcome: NpmOperationWriterOutcome;
  readonly writerTagSha: string;
} {
  const writerTagSha = extract(message, "writerTagSha", 40);
  for (const outcome of ["success", "failed"] as const) {
    if (message === npmOperationWriterTerminalMessage(outcome, writerTagSha)) {
      return Object.freeze({ outcome, writerTagSha });
    }
  }
  throw new Error("npm operation lease writer-terminal tag message is invalid");
}

export function npmOperationRevocationMessage(
  revokedAt: string,
  revokingTagSha: string,
  sourceCommit: string
): string {
  requireTimestamp(revokedAt);
  requireSha(revokingTagSha, "revoking tag");
  requireSha(sourceCommit, "revocation source commit");
  return canonicalJson({
    kind: "npm-operation-revocation",
    revokedAt,
    revokingTagSha,
    sourceCommit
  });
}

export function npmOperationRevokingMessage(sourceCommit: string): string {
  requireSha(sourceCommit, "revoking source commit");
  return canonicalJson({ kind: "npm-operation-revoking", sourceCommit });
}

export function parseNpmOperationRevokingMessage(message: string): string {
  const sourceCommit = extract(message, "sourceCommit", 40);
  if (message !== npmOperationRevokingMessage(sourceCommit)) {
    throw new Error("npm operation lease revoking tag message is invalid");
  }
  return sourceCommit;
}

export function parseNpmOperationRevocationMessage(
  message: string
): NpmOperationRevocation {
  const parsed = parseJsonRejectingDuplicateKeys(message);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("npm operation lease revocation tag message is invalid");
  }
  const value = parsed as Record<string, unknown>;
  const revokedAt = requireTimestamp(value.revokedAt);
  const revokingTagSha = value.revokingTagSha;
  if (typeof revokingTagSha !== "string") {
    throw new Error("npm operation lease revocation revoking tag is invalid");
  }
  const sourceCommit = value.sourceCommit;
  if (typeof sourceCommit !== "string") {
    throw new Error("npm operation lease revocation source commit is invalid");
  }
  const canonical = npmOperationRevocationMessage(
    revokedAt,
    revokingTagSha,
    sourceCommit
  );
  if (message !== canonical) {
    throw new Error("npm operation lease revocation tag message is invalid");
  }
  return Object.freeze({ revokedAt, revokingTagSha, sourceCommit });
}

export function npmOperationTerminalMessage(
  outcome: NpmOperationLeaseTerminal,
  revocationTagSha: string
): string {
  requireSha(revocationTagSha, "revocation tag");
  return canonicalJson({
    kind: "npm-operation-terminal",
    outcome,
    revocationTagSha
  });
}

export function parseNpmOperationTerminalMessage(
  message: string
): NpmOperationTerminalRecord {
  const revocationTagSha = extract(message, "revocationTagSha", 40);
  for (const outcome of ["complete", "failed", "abandoned"] as const) {
    if (message === npmOperationTerminalMessage(outcome, revocationTagSha)) {
      return Object.freeze({ outcome, revocationTagSha });
    }
  }
  throw new Error("npm operation lease terminal tag message is invalid");
}

export function npmOperationSecretDigest(secret: string): string {
  return createHash("sha256")
    .update(requireNpmOperationSecret(secret), "utf8")
    .digest("hex");
}

export function requireNpmOperationSecret(secret: string): string {
  if (!SECRET.test(secret)) throw new Error("npm operation lease secret is invalid");
  return secret;
}

export function npmOperationSecretMatches(secret: string, digest: string): boolean {
  const actual = Buffer.from(npmOperationSecretDigest(secret), "hex");
  const expected = Buffer.from(digest, "hex");
  return expected.byteLength === actual.byteLength
    && timingSafeEqual(actual, expected);
}

function parseSecretMessage(
  message: string,
  kind: string,
  canonical: (digest: string) => string
): string {
  const digest = extract(message, "secretSha256", 64);
  if (message !== canonical(digest)) {
    throw new Error(`npm operation lease ${kind} tag message is invalid`);
  }
  return digest;
}

function extract(message: string, name: string, length: 40 | 64): string {
  const match = new RegExp(`"${name}":"([0-9a-f]{${length}})"`, "u").exec(message);
  if (match === null) throw new Error(`npm operation lease ${name} is invalid`);
  return match[1]!;
}

function parseRef(ref: string): {
  request: Omit<NpmOperationLeaseRequest, "repository" | "sourceCommit">;
  marker: NpmOperationStoredMarker;
} {
  const match = MARKER_REF.exec(ref);
  if (match === null) throw new Error(`npm operation lease ref ${ref} is malformed`);
  const [, runId, runAttempt, rawOperation, rawVersion, marker] = match;
  return {
    request: {
      runId: runNumber(runId, "run ID"),
      runAttempt: runNumber(runAttempt, "run attempt"),
      operation: operation(rawOperation),
      version: version(rawVersion)
    },
    marker: marker as NpmOperationStoredMarker
  };
}

function requireRefType(ref: GitHubRef, type: "commit" | "tag"): void {
  if (ref.object.type !== type || !SHA.test(ref.object.sha)) {
    throw new Error(`npm operation lease ref ${ref.ref} does not target a ${type}`);
  }
}

function requireRepository(value: string): string {
  if (!REPOSITORY.test(value)) throw new Error("npm operation lease repository is invalid");
  return value;
}

function runNumber(value: unknown, label: string): string {
  try {
    return requireNpmOperationRunNumber(value);
  } catch {
    throw new Error(`npm operation lease ${label} is invalid`);
  }
}

function operation(value: unknown): NpmOperationLeaseOperation {
  try {
    return requireNpmOperationIdentityOperation(value);
  } catch {
    throw new Error("npm operation lease operation is invalid");
  }
}

function version(value: unknown): string {
  try {
    return requireNpmOperationVersion(value);
  } catch {
    throw new Error("npm operation lease version is invalid");
  }
}

function requireSha(value: string, label: string): void {
  if (!SHA.test(value)) throw new Error(`npm operation lease ${label} is invalid`);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("npm operation lease revocation timestamp is invalid");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)
    || new Date(milliseconds).toISOString() !== value) {
    throw new Error("npm operation lease revocation timestamp is invalid");
  }
  return value;
}
