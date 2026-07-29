import { randomBytes } from "node:crypto";
import {
  readOptionalPrivateFile
} from "../../server/private-file-publication.js";
import {
  recoverPrivateFileReplacement,
  removePrivateFileWithReplacement,
  replacePrivateFile
} from "../../server/private-file-replacement.js";
import { isDurableMutationId } from "../../shared/durable-mutation-id.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";

const CLAIM_ID = /^[0-9a-f]{32}$/;
const MAX_CLAIMANTS = 64;
const MAX_COHORT_MEMBERS = MAX_CLAIMANTS + 1;
const POLICY = {
  label: "1667 HTTP mutation claim cohort",
  maxBytes: 8_192
} as const;

export type HttpMutationClaimOutcome =
  | "active"
  | "confirmed"
  | "uncertain";

interface HttpMutationClaimMember {
  readonly claimId: string;
  readonly outcome: HttpMutationClaimOutcome;
}

export interface HttpMutationClaimCohort {
  readonly format: "1667-http-mutation-claim-cohort";
  readonly schemaVersion: 1;
  readonly mutationId: string;
  readonly unknownActiveClaim: boolean;
  readonly claimants: readonly HttpMutationClaimMember[];
}

export function mutationClaimCohortFile(intentFile: string): string {
  if (!intentFile.endsWith(".json")) {
    throw new Error("1667 HTTP mutation intent file name is invalid");
  }
  return `${intentFile.slice(0, -5)}.claims.json`;
}

export async function readMutationClaimCohort(
  file: string,
  mutationId: string
): Promise<HttpMutationClaimCohort | null> {
  await recoverPrivateFileReplacement(file, POLICY);
  const bytes = await readOptionalPrivateFile(file, POLICY);
  if (bytes === null) return null;
  const value = parseJsonRejectingDuplicateKeys(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corruptCohort();
  }
  const record = value as Partial<HttpMutationClaimCohort>;
  if (Object.keys(record).join(",")
      !== "format,schemaVersion,mutationId,unknownActiveClaim,claimants"
    || record.format !== "1667-http-mutation-claim-cohort"
    || record.schemaVersion !== 1
    || record.mutationId !== mutationId
    || !isDurableMutationId(record.mutationId)
    || typeof record.unknownActiveClaim !== "boolean"
    || !Array.isArray(record.claimants)
    || record.claimants.length === 0
    || record.claimants.length > MAX_COHORT_MEMBERS) {
    throw corruptCohort();
  }
  const claimIds = new Set<string>();
  for (const claimant of record.claimants) {
    if (claimant === null
      || typeof claimant !== "object"
      || Array.isArray(claimant)
      || Object.keys(claimant).join(",") !== "claimId,outcome") {
      throw corruptCohort();
    }
    const member = claimant as Partial<HttpMutationClaimMember>;
    if (typeof member.claimId !== "string"
      || !CLAIM_ID.test(member.claimId)
      || claimIds.has(member.claimId)
      || (member.outcome !== "active"
        && member.outcome !== "confirmed"
        && member.outcome !== "uncertain")) {
      throw corruptCohort();
    }
    claimIds.add(member.claimId);
  }
  return record as HttpMutationClaimCohort;
}

export async function registerMutationClaim(
  file: string,
  mutationId: string,
  cohort: HttpMutationClaimCohort | null,
  unknownActiveClaim: boolean
): Promise<{
  readonly claimId: string;
  readonly cohort: HttpMutationClaimCohort;
}> {
  const retainedClaimants = compactClaimants(cohort?.claimants ?? []);
  if (retainedClaimants.filter(
    ({ outcome }) => outcome === "active"
  ).length >= MAX_CLAIMANTS) {
    throw new Error(
      `1667 HTTP mutation has more than ${MAX_CLAIMANTS} concurrent claimants`
    );
  }
  const claimId = randomBytes(16).toString("hex");
  const next: HttpMutationClaimCohort = {
    format: "1667-http-mutation-claim-cohort",
    schemaVersion: 1,
    mutationId,
    unknownActiveClaim:
      (cohort?.unknownActiveClaim ?? false) || unknownActiveClaim,
    claimants: [
      ...retainedClaimants,
      { claimId, outcome: "active" }
    ]
  };
  await replaceMutationClaimCohort(file, next);
  return { claimId, cohort: next };
}

export async function settleMutationClaim(
  file: string,
  cohort: HttpMutationClaimCohort,
  claimId: string,
  outcome: Exclude<HttpMutationClaimOutcome, "active">
): Promise<HttpMutationClaimCohort | null> {
  let found = false;
  const claimants = cohort.claimants.map((claimant) => {
    if (claimant.claimId !== claimId) return claimant;
    found = true;
    if (claimant.outcome !== "active") return claimant;
    return { ...claimant, outcome };
  });
  if (!found) return null;
  const next = {
    ...cohort,
    claimants: compactClaimants(claimants)
  };
  await replaceMutationClaimCohort(file, next);
  return next;
}

export function mutationClaimCohortIsConfirmed(
  cohort: HttpMutationClaimCohort
): boolean {
  return !cohort.unknownActiveClaim
    && cohort.claimants.every(({ outcome }) => outcome === "confirmed");
}

export async function removeMutationClaimCohort(
  file: string
): Promise<void> {
  await removePrivateFileWithReplacement(file, POLICY);
}

async function replaceMutationClaimCohort(
  file: string,
  cohort: HttpMutationClaimCohort
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(cohort)}\n`, "utf8");
  if (bytes.byteLength > POLICY.maxBytes) {
    throw new Error("1667 HTTP mutation claim cohort exceeds its size limit");
  }
  await replacePrivateFile(file, bytes, POLICY);
}

function corruptCohort(): Error {
  return new Error("1667 HTTP mutation claim cohort is malformed");
}

function compactClaimants(
  claimants: readonly HttpMutationClaimMember[]
): readonly HttpMutationClaimMember[] {
  const active = claimants.filter(({ outcome }) => outcome === "active");
  const uncertain = claimants.find(({ outcome }) => outcome === "uncertain");
  if (active.length > 0) {
    return uncertain === undefined ? active : [...active, uncertain];
  }
  const settled = uncertain
    ?? claimants.find(({ outcome }) => outcome === "confirmed");
  return settled === undefined ? [] : [settled];
}
