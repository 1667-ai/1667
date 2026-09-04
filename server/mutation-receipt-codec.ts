import { createHash } from "node:crypto";
import {
  decodeFailureEnvelope
} from "../shared/failure-envelope.js";
import type {
  ChapterBreak,
  StoryNode,
  StoryPayload
} from "../shared/types.js";
import type { CardImportPlan } from "../shared/card-import.js";
import type { LorebookImport } from "../shared/lorebook-entry.js";
import {
  isWorkerMethod,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import { canonicalJson } from "./canonical-json.js";
import {
  chapterBreakRemovalFingerprint,
  parseRemovedChapterBreak
} from "./chapter-breaks.js";
import { ServiceError } from "./errors.js";
import {
  restoreStoredServiceFailure,
  type StoredServiceError
} from "./service-error-policy.js";
import { exactStringPattern } from "./story-wire-patterns.js";
import {
  assertFactConsistencyRun,
  hashFactConsistencyRun,
  FACT_CONSISTENCY_HASH_PATTERN,
  type FactConsistencyRun
} from "../shared/fact-consistency-types.js";

const FINGERPRINT_PATTERN = exactStringPattern("[0-9a-f]{64}");
const CONTEXT_KEY_PATTERN = exactStringPattern("[a-z][a-z0-9-]{0,63}");

type StoredResult =
  | { type: "story"; id: string; factStatesRemoved?: number }
  | { type: "aside"; id: string }
  | { type: "fact-consistency"; id: string; runId: string; runHash?: string }
  | { type: "aside-session"; storyId: string; sessionId: string }
  | { type: "chapter-break-created"; id: string; breakId: string }
  | {
      type: "chapter-break-removed";
      id: string;
      /** Compatibility for receipts written before server-side artifacts. */
      removed?: RemovedChapterBreakResult;
    }
  /** An import whose plan lives in the receipt's import-plan artifact. */
  | { type: "import"; id: string }
  | { type: "partial-rewrite"; id: string; nodeId: string }
  | { type: "value"; value: unknown };

export interface RemovedChapterBreakResult {
  break: ChapterBreak;
  summaries: StoryNode[];
}

/** The bounded plan one import mutation applied: what `importLorebook`
 * reports as `importResult`, or what `importCard` reports as `plan`. It is
 * preserved before the story transaction can commit, so a retry answers with
 * the plan the import performed rather than one recomputed from the changed
 * story. */
export type StoredImportPlan = LorebookImport | CardImportPlan;

export interface MutationReceipt {
  format: "1667-mutation";
  schemaVersion: 1;
  mutationId: string;
  /** Worker wire version that defined the canonical request fingerprint. */
  protocolVersion?: number;
  fingerprint: string;
  method: WorkerMethod;
  state: "pending" | "provider_started" | "completed" | "failed";
  createdAt: string;
  context?: Record<string, string>;
  artifact?:
    | {
        kind: "chapter-break-removal";
        fingerprint: string;
        /** Story ownership for object-liveness scans. Receipts written before
         *  Generation Records infer it from their completed result instead. */
        storyId?: string;
        value: RemovedChapterBreakResult;
      }
    | {
        kind: "import-plan";
        fingerprint: string;
        value: StoredImportPlan;
      }
    | {
        /** Compact pre-publication lease for a Fact consistency leaf. */
        kind: "fact-consistency-run";
        storyId: string;
        runId: string;
        runHash: string;
      };
  result?: StoredResult;
  failure?: StoredServiceError;
}

export function encodeMutationResult(
  value: unknown,
  artifact: MutationReceipt["artifact"],
  method?: WorkerMethod,
  input?: unknown
): StoredResult {
  if (isV2AsideMutation(method, input)) {
    if (value === null) return { type: "value", value: null };
    const storyId = storyIdFromInput(input);
    const sessionId = asideSessionIdOfResult(value);
    if (storyId === null || sessionId === null) {
      throw new ServiceError(
        500,
        "V2 Aside mutation receipt has no session target",
        "internal"
      );
    }
    return { type: "aside-session", storyId, sessionId };
  }
  if (method === "askAside") {
    // Aside text is private object data. Persist only the story pointer; the
    // resolver reads the current document at replay time, so a later clear or
    // deletion cannot return the old answer from this receipt.
    const storyId = storyIdFromInput(input);
    if (storyId === null) {
      throw new ServiceError(
        500,
        "Aside mutation receipt has no story target",
        "internal"
      );
    }
    if (value === null) return { type: "value", value: null };
    return { type: "aside", id: storyId };
  }
  if (method === "checkFactConsistency") {
    const storyId = storyIdFromInput(input);
    if (storyId === null || !isFactConsistencyResult(value)) {
      throw new ServiceError(
        500,
        "Fact consistency mutation receipt has no story target",
        "internal"
      );
    }
    return {
      type: "fact-consistency",
      id: storyId,
      runId: value.run.runId,
      runHash: hashFactConsistencyRun(value.run)
    };
  }
  if (isStoryPayload(value)) {
    return {
      type: "story",
      id: value.id,
      ...(value.factStatesRemoved === undefined
        ? {}
        : { factStatesRemoved: value.factStatesRemoved })
    };
  }
  if (isChapterBreakCreatedResult(value)) {
    return {
      type: "chapter-break-created",
      id: value.payload.id,
      breakId: value.breakId
    };
  }
  if (isChapterBreakRemovedResult(value)) {
    if (artifact !== undefined
      && artifact.kind === "chapter-break-removal"
      && chapterBreakRemovalFingerprint(value.removed)
        === artifact.fingerprint) {
      return { type: "chapter-break-removed", id: value.payload.id };
    }
    return {
      type: "chapter-break-removed",
      id: value.payload.id,
      removed: value.removed
    };
  }
  if (isPartialRewriteResult(value)) {
    return {
      type: "partial-rewrite",
      id: value.payload.id,
      nodeId: value.nodeId
    };
  }
  // An import response repeats the plan the artifact already preserved, so
  // the stored result keeps only the story pointer — the same rule the
  // chapter-break removal above applies — and a replay resolves a fresh
  // payload beside the preserved plan instead of a stale inline snapshot.
  const importPlan = importPlanOfResult(value);
  if (importPlan !== null
    && artifact !== undefined
    && artifact.kind === "import-plan"
    && importPlanFingerprint(importPlan.plan) === artifact.fingerprint) {
    return { type: "import", id: importPlan.payload.id };
  }
  return { type: "value", value };
}

function storyIdFromInput(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const storyId = (input as { readonly storyId?: unknown }).storyId;
  return typeof storyId === "string" && storyId.length > 0 ? storyId : null;
}

function isV2AsideMutation(
  method: WorkerMethod | undefined,
  input: unknown
): boolean {
  if (method === "retakeAside" || method === "asideSessionMutation") return true;
  if (method !== "askAside"
    || input === null
    || typeof input !== "object"
    || Array.isArray(input)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(input, "anchor")
    || Object.prototype.hasOwnProperty.call(input, "sessionId");
}

function asideSessionIdOfResult(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as { readonly schemaVersion?: unknown; readonly id?: unknown };
  return result.schemaVersion === 2
    && typeof result.id === "string"
    && result.id.length > 0
    ? result.id
    : null;
}

/** One canonical hash for an import-plan artifact value, shared by the
 * writer and the parser so a hand-edited receipt cannot smuggle a different
 * plan under a preserved fingerprint. */
export function importPlanFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function importPlanOfResult(
  value: unknown
): { payload: StoryPayload; plan: unknown } | null {
  if (value === null || typeof value !== "object") return null;
  const result = value as { payload?: unknown; importResult?: unknown; plan?: unknown };
  if (!isStoryPayload(result.payload)) return null;
  const plan = result.importResult ?? result.plan;
  if (plan === null || typeof plan !== "object") return null;
  return { payload: result.payload, plan };
}

export function parseMutationReceipt(
  value: unknown,
  mutationId: string
): MutationReceipt {
  if (value === null || typeof value !== "object") {
    throw corruptMutationReceipt(mutationId);
  }
  const receipt = value as Partial<MutationReceipt>;
  if (receipt.format !== "1667-mutation" || receipt.schemaVersion !== 1
    || receipt.mutationId !== mutationId
    || !isMutationFingerprint(receipt.fingerprint)
    || (receipt.protocolVersion !== undefined
      && (!Number.isSafeInteger(receipt.protocolVersion)
        || receipt.protocolVersion < 1))
    || !isWorkerMethod(receipt.method)
    || typeof receipt.createdAt !== "string"
    || !Number.isFinite(Date.parse(receipt.createdAt))
    || !["pending", "provider_started", "completed", "failed"].includes(
      String(receipt.state)
    )) {
    throw corruptMutationReceipt(mutationId);
  }
  if (receipt.state === "completed") {
    if (!isStoredResult(receipt.result) || receipt.failure !== undefined) {
      throw corruptMutationReceipt(mutationId);
    }
    // An Aside terminal is a legacy story pointer, a v2 session pointer, or
    // the null cancellation result. Reject older inline views and every
    // unrelated stored shape so a hand-edited receipt cannot replay a result
    // under the wrong method.
    if (receipt.method === "askAside") {
      const validAsideResult = receipt.result.type === "aside"
        || receipt.result.type === "aside-session"
        || (receipt.result.type === "value" && receipt.result.value === null);
      if (!validAsideResult) throw corruptMutationReceipt(mutationId);
    } else if (receipt.result.type === "aside") {
      throw corruptMutationReceipt(mutationId);
    } else if (receipt.result.type === "aside-session"
      && receipt.method !== "retakeAside"
      && receipt.method !== "asideSessionMutation") {
      throw corruptMutationReceipt(mutationId);
    }
    if (receipt.method === "checkFactConsistency"
      && receipt.result.type !== "fact-consistency") {
      throw corruptMutationReceipt(mutationId);
    }
    if (receipt.result.type === "fact-consistency"
      && receipt.method !== "checkFactConsistency") {
      throw corruptMutationReceipt(mutationId);
    }
    if (receipt.result.type === "fact-consistency"
      && receipt.artifact?.kind === "fact-consistency-run"
      && (receipt.artifact.storyId !== receipt.result.id
        || receipt.artifact.runId !== receipt.result.runId
        || (receipt.result.runHash !== undefined
          && receipt.artifact.runHash !== receipt.result.runHash))) {
      throw corruptMutationReceipt(mutationId);
    }
  }
  const decodedFailure = receipt.state === "failed"
    ? decodeFailureEnvelope(receipt.failure)
    : null;
  if (receipt.state === "failed" && (decodedFailure === null
    || decodedFailure.status === null || receipt.result !== undefined)) {
    throw corruptMutationReceipt(mutationId);
  }
  if (decodedFailure !== null) receipt.failure = decodedFailure;
  if ((receipt.state === "pending" || receipt.state === "provider_started")
    && (receipt.result !== undefined || receipt.failure !== undefined)) {
    throw corruptMutationReceipt(mutationId);
  }
  if (!isStoredContext(receipt.context)
    || !isStoredArtifact(receipt.artifact, receipt.method)) {
    throw corruptMutationReceipt(mutationId);
  }
  if (receipt.state === "completed"
    && receipt.result?.type === "chapter-break-removed"
    && receipt.result.removed === undefined
    && receipt.artifact === undefined) {
    throw corruptMutationReceipt(mutationId);
  }
  if (receipt.state === "completed"
    && receipt.result?.type === "import"
    && receipt.artifact?.kind !== "import-plan") {
    throw corruptMutationReceipt(mutationId);
  }
  return receipt as MutationReceipt;
}

export function isMutationFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

export function requireChapterBreakRemovalFingerprint(
  value: string
): void {
  if (!isMutationFingerprint(value)) {
    throw new ServiceError(400, "Invalid chapter-break removal fingerprint");
  }
}

/**
 * The one home for chapter-break removal conflict semantics: shape-check the
 * expected fingerprint, load a private copy, and require the exact match.
 * Callers own any persistence of the returned value.
 */
export async function loadVerifiedChapterBreakRemoval(
  expectedFingerprint: string,
  load: () => Promise<RemovedChapterBreakResult>
): Promise<RemovedChapterBreakResult> {
  requireChapterBreakRemovalFingerprint(expectedFingerprint);
  const value = structuredClone(await load());
  if (chapterBreakRemovalFingerprint(value) !== expectedFingerprint) {
    throw new ServiceError(
      409,
      "Chapter-break removal input no longer matches the aggregate.",
      "conflict"
    );
  }
  return value;
}

export function requireRemovalArtifact(
  receipt: MutationReceipt
): RemovedChapterBreakResult {
  if (receipt.artifact?.kind !== "chapter-break-removal") {
    throw corruptMutationReceipt(receipt.mutationId);
  }
  return receipt.artifact.value;
}

export function requireImportPlanArtifact(
  receipt: MutationReceipt
): StoredImportPlan {
  if (receipt.artifact?.kind !== "import-plan") {
    throw corruptMutationReceipt(receipt.mutationId);
  }
  return receipt.artifact.value;
}

export function restoreMutationReceiptFailure(
  failure: StoredServiceError | undefined
): unknown {
  const decoded = decodeFailureEnvelope(failure);
  if (decoded === null || decoded.status === null) {
    throw new ServiceError(
      500,
      "Mutation receipt is missing its failure",
      "internal"
    );
  }
  return restoreStoredServiceFailure(decoded);
}

export function corruptMutationReceipt(mutationId: string): ServiceError {
  return new ServiceError(
    500,
    `Mutation receipt is corrupt: ${mutationId}`,
    "internal"
  );
}

function isStoryPayload(value: unknown): value is StoryPayload {
  return value !== null
    && typeof value === "object"
    && typeof (value as StoryPayload).id === "string"
    && Array.isArray((value as StoryPayload).nodes)
    && Array.isArray((value as StoryPayload).path);
}

function isFactConsistencyResult(
  value: unknown
): value is { readonly run: FactConsistencyRun; readonly payload: StoryPayload } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as { readonly run?: unknown; readonly payload?: unknown };
  if (!(result.run !== null
    && typeof result.run === "object"
    && !Array.isArray(result.run)
    && isStoryPayload(result.payload))) return false;
  try {
    assertFactConsistencyRun(result.run);
    return true;
  } catch {
    return false;
  }
}

function isChapterBreakCreatedResult(
  value: unknown
): value is { payload: StoryPayload; breakId: string } {
  if (value === null || typeof value !== "object") return false;
  const result = value as { payload?: unknown; breakId?: unknown };
  return isStoryPayload(result.payload) && typeof result.breakId === "string";
}

function isChapterBreakRemovedResult(
  value: unknown
): value is {
  payload: StoryPayload;
  removed: RemovedChapterBreakResult;
} {
  if (value === null || typeof value !== "object") return false;
  const result = value as { payload?: unknown; removed?: unknown };
  return isStoryPayload(result.payload)
    && result.removed !== null
    && typeof result.removed === "object";
}

function isPartialRewriteResult(
  value: unknown
): value is { payload: StoryPayload; nodeId: string } {
  if (value === null || typeof value !== "object") return false;
  const result = value as { payload?: unknown; nodeId?: unknown };
  return isStoryPayload(result.payload) && typeof result.nodeId === "string";
}

function isStoredResult(value: unknown): value is StoredResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.type === "story") {
    return typeof result.id === "string"
      && (result.factStatesRemoved === undefined
        || (typeof result.factStatesRemoved === "number"
          && Number.isSafeInteger(result.factStatesRemoved)
          && result.factStatesRemoved >= 0));
  }
  if (result.type === "aside") return typeof result.id === "string";
  if (result.type === "fact-consistency") {
    return typeof result.id === "string"
      && typeof result.runId === "string"
      && result.runId.length > 0
      && (result.runHash === undefined
        || (typeof result.runHash === "string"
          && FACT_CONSISTENCY_HASH_PATTERN.test(result.runHash)));
  }
  if (result.type === "aside-session") {
    return typeof result.storyId === "string"
      && result.storyId.length > 0
      && typeof result.sessionId === "string"
      && result.sessionId.length > 0;
  }
  if (result.type === "chapter-break-created") {
    return typeof result.id === "string"
      && typeof result.breakId === "string";
  }
  if (result.type === "chapter-break-removed") {
    return typeof result.id === "string"
      && (result.removed === undefined
        || (result.removed !== null && typeof result.removed === "object"));
  }
  if (result.type === "import") return typeof result.id === "string";
  if (result.type === "partial-rewrite") {
    return typeof result.id === "string" && typeof result.nodeId === "string";
  }
  return result.type === "value" && "value" in result;
}

function isStoredArtifact(
  value: MutationReceipt["artifact"] | undefined,
  method: WorkerMethod | undefined
): boolean {
  if (value === undefined) return true;
  if (value.kind === "fact-consistency-run") {
    return method === "checkFactConsistency"
      && typeof value.storyId === "string"
      && value.storyId.length > 0
      && typeof value.runId === "string"
      && value.runId.length > 0
      && FACT_CONSISTENCY_HASH_PATTERN.test(value.runHash);
  }
  if (value.kind === "import-plan") {
    if ((method !== "importLorebook" && method !== "importCard")
      || !isMutationFingerprint(value.fingerprint)
      || !isStoredImportPlan(value.value, method)) {
      return false;
    }
    try {
      return importPlanFingerprint(value.value) === value.fingerprint;
    } catch {
      return false;
    }
  }
  if (method !== "removeChapterBreak"
    || value.kind !== "chapter-break-removal"
    || !isMutationFingerprint(value.fingerprint)
    || (value.storyId !== undefined && typeof value.storyId !== "string")
    || value.value === null || typeof value.value !== "object") {
    return false;
  }
  try {
    const parsed = parseRemovedChapterBreak(value.value);
    return chapterBreakRemovalFingerprint(parsed) === value.fingerprint;
  } catch {
    return false;
  }
}

/** Structural check for a preserved plan. The Facts inside are re-parsed by
 * `createFacts` whenever a replay applies them, so this only pins the report
 * shape each import method answers with; the fingerprint above pins the
 * exact content. */
function isStoredImportPlan(
  value: unknown,
  method: "importLorebook" | "importCard"
): value is StoredImportPlan {
  if (value === null || typeof value !== "object") return false;
  const plan = value as Partial<CardImportPlan>;
  if (!Array.isArray(plan.facts)
    || !plan.facts.every((fact) => fact !== null && typeof fact === "object" && !Array.isArray(fact))
    || !isStringArray(plan.fidelity)) {
    return false;
  }
  if (method === "importLorebook") return true;
  return typeof plan.name === "string"
    && isStringArray(plan.used)
    && isStringArray(plan.skipped);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string");
}

function isStoredContext(
  value: unknown
): value is Record<string, string> | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([key, fingerprint]) =>
    CONTEXT_KEY_PATTERN.test(key) && isMutationFingerprint(fingerprint)
  );
}
