import { randomBytes } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease.js";
import {
  readNpmOperationJournal,
  type NpmOperationJournalRead,
  type NpmOperationReconciliationIdentity
} from "./release-npm-operation-journal-reader.js";
import {
  annotateQuarantinedGitHubRelease,
  type GitHubQuarantineAnnotationEvidence
} from "./release-npm-quarantine-github.js";
import type { NpmQuarantineRequest } from "./release-npm-operations.js";
import {
  proveNpmSupersedingRelease
} from "./release-npm-superseding-release.js";

const DIGEST = /^[0-9a-f]{64}$/u;

export interface NpmQuarantineNoteRequest {
  readonly repository: string;
  readonly token: string;
  readonly claimSecret: string;
  readonly version: string;
  readonly journalPath: string;
  readonly evidencePath: string;
  readonly lease: NpmOperationLeaseRequest;
}

export interface NpmQuarantineNoteLease {
  verifySuccessfulWriter(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void>;
  complete(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void>;
}

export interface NpmQuarantineNoteDependencies {
  readonly lease?: NpmQuarantineNoteLease;
  readonly annotate?: (
    request: NpmQuarantineNoteRequest,
    quarantine: NpmQuarantineRequest
  ) => Promise<GitHubQuarantineAnnotationEvidence>;
  readonly readJournal?: (
    journalPath: string,
    identity: NpmOperationReconciliationIdentity
  ) => NpmOperationJournalRead;
  readonly syncDirectory?: (directory: string) => Promise<void>;
  readonly proveSupersedingRelease?: (
    version: string
  ) => Promise<void>;
}

export async function recordNpmQuarantineNote(
  request: NpmQuarantineNoteRequest,
  dependencies: NpmQuarantineNoteDependencies = {}
): Promise<GitHubQuarantineAnnotationEvidence> {
  if (request.lease.repository !== request.repository
    || request.lease.operation !== "quarantine"
    || request.lease.version !== request.version) {
    throw new Error("npm quarantine note lease coordinates do not match");
  }
  if (!path.isAbsolute(request.evidencePath)) {
    throw new Error("npm quarantine note evidence path must be absolute");
  }
  const journal = (dependencies.readJournal ?? readNpmOperationJournal)(
    request.journalPath,
    request.lease
  );
  if (journal.terminal !== "complete"
    || journal.parameters.operation !== "quarantine") {
    throw new Error("npm quarantine note requires a completed quarantine journal");
  }
  const quarantine = journal.parameters.quarantine;
  const lease = dependencies.lease ?? new GitHubNpmOperationLease({
    repository: request.repository,
    token: request.token
  });
  const syncParent = dependencies.syncDirectory ?? syncDirectory;
  const proveSuperseding = dependencies.proveSupersedingRelease ?? (
    async (supersedingVersion): Promise<void> => {
      await proveNpmSupersedingRelease({
        repository: request.repository,
        token: request.token,
        version: supersedingVersion
      });
    }
  );
  const annotateRelease = dependencies.annotate ?? annotate;
  const existing = await readCompletedEvidence(
    request,
    quarantine,
    journal.sha256,
    syncParent
  );
  if (existing !== null) {
    await proveSuperseding(quarantine.supersedingVersion);
    await requireCurrentEvidence(
      request,
      quarantine,
      existing,
      annotateRelease
    );
    await lease.complete(request.lease, request.claimSecret);
    return existing;
  }
  try {
    await lease.verifySuccessfulWriter(request.lease, request.claimSecret);
  } catch (error) {
    const raced = await readCompletedEvidence(
      request,
      quarantine,
      journal.sha256,
      syncParent
    );
    if (raced === null) throw error;
    await proveSuperseding(quarantine.supersedingVersion);
    await requireCurrentEvidence(
      request,
      quarantine,
      raced,
      annotateRelease
    );
    await lease.complete(request.lease, request.claimSecret);
    return raced;
  }
  await proveSuperseding(quarantine.supersedingVersion);
  const record = await openEvidenceRecord(
    request,
    quarantine,
    journal.sha256,
    syncParent
  );
  const evidence = await annotateRelease(request, quarantine);
  await record.complete(evidence);
  await lease.complete(request.lease, request.claimSecret);
  return evidence;
}

async function requireCurrentEvidence(
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest,
  recorded: GitHubQuarantineAnnotationEvidence,
  annotateRelease: (
    request: NpmQuarantineNoteRequest,
    quarantine: NpmQuarantineRequest
  ) => Promise<GitHubQuarantineAnnotationEvidence>
): Promise<void> {
  const current = await annotateRelease(request, quarantine);
  if (canonicalJson(current) !== canonicalJson(recorded)) {
    throw new Error("GitHub quarantine notice does not match recorded evidence");
  }
}

async function annotate(
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest
): Promise<GitHubQuarantineAnnotationEvidence> {
  return annotateQuarantinedGitHubRelease({
    repository: request.repository,
    token: request.token,
    version: request.version,
    sourceCommit: request.lease.sourceCommit,
    quarantine
  });
}

interface OpenEvidenceRecord {
  complete(evidence: GitHubQuarantineAnnotationEvidence): Promise<void>;
}

async function readCompletedEvidence(
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest,
  journalSha256: string,
  syncParent: (directory: string) => Promise<void>
): Promise<GitHubQuarantineAnnotationEvidence | null> {
  const completed = await readCompleteRecord(
    `${request.evidencePath}.complete`,
    request,
    quarantine
  );
  if (completed === null) return null;
  const started = await readCanonicalRecord(
    request.evidencePath,
    "npm quarantine note started evidence"
  );
  if (started !== startedRecord(request, quarantine, journalSha256)) {
    throw new Error("npm quarantine note evidence has a different operation");
  }
  await syncParent(path.dirname(request.evidencePath));
  return completed.evidence;
}

async function openEvidenceRecord(
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest,
  journalSha256: string,
  syncParent: (directory: string) => Promise<void>
): Promise<OpenEvidenceRecord> {
  const started = startedRecord(request, quarantine, journalSha256);
  const completeFile = `${request.evidencePath}.complete`;
  const existing = await readCanonicalRecord(
    request.evidencePath,
    "npm quarantine note started evidence"
  );
  if (existing === null) {
    await createAtomicRecord(
      request.evidencePath,
      started,
      "npm quarantine note started evidence",
      syncParent
    );
  } else if (existing !== started) {
    throw new Error("npm quarantine note evidence has a different operation");
  } else {
    await syncParent(path.dirname(request.evidencePath));
  }
  const recordedComplete = await readCompleteRecord(
    completeFile,
    request,
    quarantine
  );
  return Object.freeze({
    async complete(evidence: GitHubQuarantineAnnotationEvidence): Promise<void> {
      const completed = `${canonicalJson({
        schemaVersion: 1,
        record: "complete",
        evidence
      })}\n`;
      if (recordedComplete !== null) {
        if (recordedComplete.raw !== completed) {
          throw new Error("npm quarantine note evidence has different evidence");
        }
        await syncParent(path.dirname(completeFile));
        return;
      }
      await createAtomicRecord(
        completeFile,
        completed,
        "npm quarantine note complete evidence",
        syncParent
      );
    }
  });
}

function startedRecord(
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest,
  journalSha256: string
): string {
  return `${canonicalJson({
    schemaVersion: 1,
    record: "started",
    repository: request.repository,
    lease: request.lease,
    version: request.version,
    quarantine,
    journalSha256
  })}\n`;
}

async function readCompleteRecord(
  file: string,
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest
): Promise<{
  readonly raw: string;
  readonly evidence: GitHubQuarantineAnnotationEvidence;
} | null> {
  const value = await readCanonicalRecord(
    file,
    "npm quarantine note complete evidence"
  );
  if (value === null) return null;
  const record = parseJsonRejectingDuplicateKeys(
    value.slice(0, -1)
  ) as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.record !== "complete"
    || record.evidence === null || typeof record.evidence !== "object"
    || Array.isArray(record.evidence) || Object.keys(record).length !== 3) {
    throw new Error("npm quarantine note complete evidence is invalid");
  }
  return Object.freeze({
    raw: value,
    evidence: quarantineEvidence(record.evidence, request, quarantine)
  });
}

function quarantineEvidence(
  value: unknown,
  request: NpmQuarantineNoteRequest,
  quarantine: NpmQuarantineRequest
): GitHubQuarantineAnnotationEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm quarantine note complete evidence is invalid");
  }
  const evidence = value as Record<string, unknown>;
  if (evidence.schemaVersion !== 1
    || evidence.tag !== `v${request.version}`
    || evidence.incidentReference !== quarantine.incidentReference
    || evidence.supersedingVersion !== quarantine.supersedingVersion) {
    throw new Error("npm quarantine note complete evidence is invalid");
  }
  if (evidence.notice === "release-notes") {
    if (Object.keys(evidence).length !== 8
      || !Number.isSafeInteger(evidence.releaseId)
      || Number(evidence.releaseId) < 1
      || typeof evidence.notesSha256 !== "string"
      || !DIGEST.test(evidence.notesSha256)
      || typeof evidence.assetsSha256 !== "string"
      || !DIGEST.test(evidence.assetsSha256)) {
      throw new Error("npm quarantine note complete evidence is invalid");
    }
    return Object.freeze({
      schemaVersion: 1,
      notice: "release-notes",
      releaseId: Number(evidence.releaseId),
      tag: evidence.tag,
      incidentReference: evidence.incidentReference,
      supersedingVersion: evidence.supersedingVersion,
      notesSha256: evidence.notesSha256,
      assetsSha256: evidence.assetsSha256
    });
  }
  if (evidence.notice === "release-absent") {
    const quarantineRef = `refs/tags/released/v${request.version}_quarantined`;
    if (Object.keys(evidence).length !== 10
      || evidence.releaseId !== null
      || evidence.quarantineRef !== quarantineRef
      || evidence.sourceCommit !== request.lease.sourceCommit
      || evidence.notesSha256 !== null
      || evidence.assetsSha256 !== null) {
      throw new Error("npm quarantine note complete evidence is invalid");
    }
    return Object.freeze({
      schemaVersion: 1,
      notice: "release-absent",
      releaseId: null,
      tag: evidence.tag,
      incidentReference: evidence.incidentReference,
      supersedingVersion: evidence.supersedingVersion,
      quarantineRef,
      sourceCommit: request.lease.sourceCommit,
      notesSha256: null,
      assetsSha256: null
    });
  }
  throw new Error("npm quarantine note complete evidence is invalid");
}

async function readCanonicalRecord(
  file: string,
  label: string
): Promise<string | null> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > 64 * 1024) {
    throw new Error(`${label} is invalid`);
  }
  const value = await readFile(file, "utf8");
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new Error(`${label} is truncated`);
  }
  const parsed = parseJsonRejectingDuplicateKeys(value.slice(0, -1));
  if (value !== `${canonicalJson(parsed)}\n`) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
}

async function createAtomicRecord(
  file: string,
  value: string,
  label: string,
  syncParent: (directory: string) => Promise<void>
): Promise<void> {
  const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, file);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (await readCanonicalRecord(file, label) !== value) {
      throw new Error(`${label} has different content`);
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
  await syncParent(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}
