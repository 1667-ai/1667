import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { uuidFromDigestHex } from "./deterministic-uuid.js";
import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  MUTATION_ID_CLOCK_SKEW_MS,
  MUTATION_ID_RETRY_WINDOW_MS,
  WORKER_PROTOCOL_VERSION,
  isWorkerMethod,
  type MutatingWorkerMethod,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import type { ChapterBreak, StoryNode, StoryPayload } from "../shared/types.js";
import {
  chapterBreakRemovalFingerprint,
  parseRemovedChapterBreak,
  type RemovedChapterBreak
} from "./chapter-breaks.js";
import {
  isDefinitiveProviderFailure,
  ServiceError,
  toPublicServiceError,
  type PublicServiceError
} from "./errors.js";
import {
  createMutationPlan,
  mutationPreflightPlan,
  type MutationPlan,
  type MutationPreflightPlan,
  type MutationRecoveryMode
} from "./mutation-plan.js";
import { generationOutcomeUnknown, mutationOutcomeUnknown } from "./mutation-recovery.js";
import { mkdirDurable, requireDurableCommit, StoryDurabilityError, writeDurableAtomic } from "./story-lifecycle.js";
import { exactStringPattern } from "./story-wire-patterns.js";

const LEGACY_MUTATION_ID_PATTERN = exactStringPattern("m1-([0-9a-z]+)-([0-9a-f]{32})");
const DURABLE_MUTATION_ID_PATTERN = exactStringPattern("m1\\.([0-9]{13})\\.([0-9a-f]{32})");
const FINGERPRINT_PATTERN = exactStringPattern("[0-9a-f]{64}");
const CONTEXT_KEY_PATTERN = exactStringPattern("[a-z][a-z0-9-]{0,63}");
// Receipts written before protocolVersion was persisted were all emitted by
// the first embedded-worker protocol shipped on this branch.

type StoredResult =
  | { type: "story"; id: string }
  | { type: "chapter-break-created"; id: string; breakId: string }
  | {
      type: "chapter-break-removed";
      id: string;
      /** Compatibility for receipts written before server-side artifacts. */
      removed?: RemovedChapterBreakResult;
    }
  | { type: "value"; value: unknown };

interface RemovedChapterBreakResult {
  break: ChapterBreak;
  summaries: StoryNode[];
}

interface MutationReceipt {
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
  artifact?: {
    kind: "chapter-break-removal";
    fingerprint: string;
    value: RemovedChapterBreakResult;
  };
  result?: StoredResult;
  failure?: PublicServiceError;
}

/** The worker must retain the caller outbox because receipt durability is
 * unknown; terminating the worker turns the next launch into reconciliation. */
export class MutationReceiptPersistenceError extends ServiceError {
  constructor(readonly cause: unknown) {
    super(500,
      "Mutation receipt durability could not be confirmed; the backend stopped and retained the request for recovery.",
      "mutation_outcome_unknown");
    this.name = "MutationReceiptPersistenceError";
  }
}

export class MutationReceiptStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    private readonly resolveStory: (id: string) => Promise<StoryPayload>
  ) {}

  async init(): Promise<void> {
    await mkdirDurable(this.dir);
  }

  async inspect(
    mutationId: string
  ): Promise<{
    readonly state: MutationReceipt["state"];
    readonly method: WorkerMethod;
    readonly fingerprint: string;
  } | null> {
    const receipt = await this.load(mutationId);
    return receipt === null
      ? null
      : {
          state: receipt.state,
          method: receipt.method,
          fingerprint: receipt.fingerprint
        };
  }

  async run<M extends MutatingWorkerMethod, T>(
    mutationId: string,
    method: M,
    input: unknown,
    work: (plan: MutationPlan<M>) => Promise<T>,
    inputProtocolVersion: number | undefined,
    preflight: (plan: MutationPreflightPlan<M>) => void | Promise<void>
  ): Promise<T> {
    inputProtocolVersion ??= WORKER_PROTOCOL_VERSION;
    if (!Number.isSafeInteger(inputProtocolVersion) || inputProtocolVersion < 1) {
      throw new ServiceError(400, "Invalid mutation input protocol version");
    }
    return await this.withLock(mutationId, async () => {
      const existing = await this.load(mutationId);
      const receiptProtocolVersion = existing?.protocolVersion ?? LEGACY_WORKER_PROTOCOL_VERSION;
      const fingerprint = mutationFingerprint(method, input, inputProtocolVersion);
      let receipt: MutationReceipt;
      let recoveryMode: MutationRecoveryMode = "new";
      let needsInitialSave = false;
      if (existing !== null) {
        const identityMismatch = receiptProtocolVersion !== inputProtocolVersion
          || existing.fingerprint !== fingerprint || existing.method !== method;
        // Once a provider may have seen the original request, no later wire or
        // schema mismatch can prove that request did not complete. Preserve
        // ambiguity so the caller archives and warns instead of clearing it.
        if (identityMismatch && existing.state === "provider_started") throw generationOutcomeUnknown();
        if (identityMismatch) throw idempotencyConflict();
        if (existing.state === "completed") return await this.resolve(existing) as T;
        if (existing.state === "failed") throw storedFailure(existing.failure);
        receipt = existing;
        recoveryMode = existing.state === "provider_started" ? "provider-uncertain" : "pending";
      } else {
        validateUnseenMutationId(mutationId);
        receipt = {
          format: "1667-mutation",
          schemaVersion: 1,
          mutationId,
          protocolVersion: inputProtocolVersion,
          fingerprint,
          method,
          state: "pending",
          createdAt: new Date().toISOString()
        };
        needsInitialSave = true;
      }
      const plan = createMutationPlan(method, recoveryMode, {
        entityId: (namespace, index = 0) => deterministicEntityId(mutationId, namespace, index),
        bindGenerationIntent: async (settings, context) => {
          const namespace = "generation-intent";
          const fingerprint = createHash("sha256")
            // Authentication material is intentionally excluded: receipts
            // persist indefinitely and must not become offline key verifiers.
            .update(canonicalJson({ settings, context }))
            .digest("hex");
          const existing = receipt.context?.[namespace];
          if (existing !== undefined && existing !== fingerprint) {
            throw new ServiceError(
              409,
              "The generation context changed before recovery; the retained request was not sent.",
              "idempotency_conflict"
            );
          }
          if (existing === fingerprint) return;
          receipt.context = { ...receipt.context, [namespace]: fingerprint };
          await this.save(receipt);
        },
        preserveChapterBreakRemoval: async (expectedFingerprint, load) => {
          if (!FINGERPRINT_PATTERN.test(expectedFingerprint)) {
            throw new ServiceError(400, "Invalid chapter-break removal fingerprint");
          }
          const existingArtifact = receipt.artifact;
          if (existingArtifact !== undefined) {
            if (existingArtifact.kind !== "chapter-break-removal"
              || existingArtifact.fingerprint !== expectedFingerprint
              || chapterBreakRemovalFingerprint(existingArtifact.value)
                !== expectedFingerprint) {
              throw corruptReceipt(mutationId);
            }
            return structuredClone(existingArtifact.value);
          }
          const value = structuredClone(await load());
          if (chapterBreakRemovalFingerprint(value) !== expectedFingerprint) {
            throw new ServiceError(
              409,
              "Chapter-break removal input no longer matches the aggregate.",
              "conflict"
            );
          }
          receipt.artifact = {
            kind: "chapter-break-removal",
            fingerprint: expectedFingerprint,
            value
          };
          await this.save(receipt);
          return structuredClone(value);
        },
        providerStarted: async () => {
          if (receipt.state === "provider_started") return;
          receipt.state = "provider_started";
          await this.save(receipt);
        }
      });
      // A predecessor compatibility check must be able to refuse a future
      // aggregate without creating a legacy receipt that would poison the same
      // mutation ID for a capable successor. Exact existing receipts are still
      // resolved above before current code or aggregate compatibility is tested.
      await preflight(mutationPreflightPlan(plan));
      if (needsInitialSave) await this.save(receipt);
      let value: T;
      try {
        value = await work(plan);
      } catch (error) {
        if (error instanceof MutationReceiptPersistenceError) throw error;
        if (error instanceof StoryDurabilityError) throw mutationOutcomeUnknown();
        if (receipt.state === "provider_started" && !isDefinitiveGenerationFailure(error)) {
          throw generationOutcomeUnknown();
        }
        receipt.state = "failed";
        receipt.failure = toPublicServiceError(error);
        await this.save(receipt);
        throw error;
      }
      receipt.state = "completed";
      receipt.result = storedResult(value, receipt.artifact);
      await this.save(receipt);
      return value;
    });
  }

  private async resolve(receipt: MutationReceipt): Promise<unknown> {
    const result = receipt.result;
    if (result === undefined) throw new ServiceError(500, "Mutation receipt is missing its result", "internal");
    switch (result.type) {
      case "story": return await this.resolveStory(result.id);
      case "chapter-break-created": return {
        payload: await this.resolveStory(result.id),
        breakId: result.breakId
      };
      case "chapter-break-removed": return {
        payload: await this.resolveStory(result.id),
        removed: result.removed ?? requireRemovalArtifact(receipt)
      };
      case "value": return result.value;
    }
  }

  private async load(mutationId: string): Promise<MutationReceipt | null> {
    validateMutationIdSyntax(mutationId);
    try {
      const value: unknown = JSON.parse(await readFile(this.file(mutationId), "utf8"));
      return parseReceipt(value, mutationId);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async save(receipt: MutationReceipt): Promise<void> {
    try {
      const commit = await writeDurableAtomic(this.file(receipt.mutationId), `${JSON.stringify(receipt)}\n`);
      requireDurableCommit(commit, `Saving mutation receipt ${receipt.mutationId}`);
    } catch (error) {
      if (error instanceof MutationReceiptPersistenceError) throw error;
      throw new MutationReceiptPersistenceError(error);
    }
  }

  private file(mutationId: string): string {
    validateMutationIdSyntax(mutationId);
    return path.join(this.dir, `${mutationId}.json`);
  }

  private async withLock<T>(mutationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(mutationId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    this.queues.set(mutationId, settled);
    try {
      return await run;
    } finally {
      if (this.queues.get(mutationId) === settled) this.queues.delete(mutationId);
    }
  }
}

export function mutationFingerprint(
  method: WorkerMethod,
  input: unknown,
  protocolVersion = WORKER_PROTOCOL_VERSION
): string {
  const canonical = canonicalJson({ protocolVersion, method, input });
  return createHash("sha256").update(canonical).digest("hex");
}

export function validateUnseenMutationId(mutationId: string, now = Date.now()): void {
  const durable = DURABLE_MUTATION_ID_PATTERN.exec(mutationId);
  const legacy = durable === null ? LEGACY_MUTATION_ID_PATTERN.exec(mutationId) : null;
  const match = durable ?? legacy;
  if (match === null) throw invalidMutationId();
  const createdAt = Number.parseInt(match[1]!, durable === null ? 36 : 10);
  if (!Number.isSafeInteger(createdAt)) throw invalidMutationId();
  if (createdAt < now - MUTATION_ID_RETRY_WINDOW_MS || createdAt > now + MUTATION_ID_CLOCK_SKEW_MS) {
    throw new ServiceError(409, "Mutation ID is outside its retry window", "mutation_expired");
  }
}

function validateMutationIdSyntax(mutationId: string): void {
  if (!LEGACY_MUTATION_ID_PATTERN.test(mutationId)
    && !DURABLE_MUTATION_ID_PATTERN.test(mutationId)) throw invalidMutationId();
}

function storedResult(
  value: unknown,
  artifact: MutationReceipt["artifact"]
): StoredResult {
  if (isStoryPayload(value)) return { type: "story", id: value.id };
  if (isChapterBreakCreatedResult(value)) {
    return { type: "chapter-break-created", id: value.payload.id, breakId: value.breakId };
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
  return { type: "value", value };
}

function isStoryPayload(value: unknown): value is StoryPayload {
  return value !== null && typeof value === "object" && typeof (value as StoryPayload).id === "string"
    && Array.isArray((value as StoryPayload).nodes) && Array.isArray((value as StoryPayload).path);
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
): value is { payload: StoryPayload; removed: RemovedChapterBreakResult } {
  if (value === null || typeof value !== "object") return false;
  const result = value as { payload?: unknown; removed?: unknown };
  return isStoryPayload(result.payload) && result.removed !== null && typeof result.removed === "object";
}

function isStoredResult(value: unknown): value is StoredResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.type === "story") return typeof result.id === "string";
  if (result.type === "chapter-break-created") {
    return typeof result.id === "string" && typeof result.breakId === "string";
  }
  if (result.type === "chapter-break-removed") {
    return typeof result.id === "string"
      && (result.removed === undefined
        || (result.removed !== null && typeof result.removed === "object"));
  }
  return result.type === "value" && "value" in result;
}

function parseReceipt(value: unknown, mutationId: string): MutationReceipt {
  if (value === null || typeof value !== "object") throw corruptReceipt(mutationId);
  const receipt = value as Partial<MutationReceipt>;
  if (receipt.format !== "1667-mutation" || receipt.schemaVersion !== 1
    || receipt.mutationId !== mutationId || !FINGERPRINT_PATTERN.test(receipt.fingerprint ?? "")
    || (receipt.protocolVersion !== undefined
      && (!Number.isSafeInteger(receipt.protocolVersion) || receipt.protocolVersion < 1))
    || !isWorkerMethod(receipt.method) || typeof receipt.createdAt !== "string"
    || !Number.isFinite(Date.parse(receipt.createdAt))
    || !["pending", "provider_started", "completed", "failed"].includes(String(receipt.state))) {
    throw corruptReceipt(mutationId);
  }
  if (receipt.state === "completed" && (!isStoredResult(receipt.result) || receipt.failure !== undefined)) {
    throw corruptReceipt(mutationId);
  }
  if (receipt.state === "failed" && (!isPublicFailure(receipt.failure) || receipt.result !== undefined)) {
    throw corruptReceipt(mutationId);
  }
  if ((receipt.state === "pending" || receipt.state === "provider_started")
    && (receipt.result !== undefined || receipt.failure !== undefined)) throw corruptReceipt(mutationId);
  if (!isStoredContext(receipt.context)
    || !isStoredArtifact(receipt.artifact, receipt.method)) {
    throw corruptReceipt(mutationId);
  }
  if (receipt.state === "completed"
    && receipt.result?.type === "chapter-break-removed"
    && receipt.result.removed === undefined
    && receipt.artifact === undefined) {
    throw corruptReceipt(mutationId);
  }
  return receipt as MutationReceipt;
}

function isStoredArtifact(
  value: MutationReceipt["artifact"] | undefined,
  method: WorkerMethod | undefined
): boolean {
  if (value === undefined) return true;
  if (method !== "removeChapterBreak"
    || value.kind !== "chapter-break-removal"
    || !FINGERPRINT_PATTERN.test(value.fingerprint)
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

function requireRemovalArtifact(
  receipt: MutationReceipt
): RemovedChapterBreakResult {
  if (receipt.artifact?.kind !== "chapter-break-removal") {
    throw corruptReceipt(receipt.mutationId);
  }
  return receipt.artifact.value;
}

function isStoredContext(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, fingerprint]) =>
    CONTEXT_KEY_PATTERN.test(key) && typeof fingerprint === "string" && FINGERPRINT_PATTERN.test(fingerprint)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ServiceError(400, "Mutation input contains a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ServiceError(400, "Mutation input is not serializable");
}

function invalidMutationId(): ServiceError {
  return new ServiceError(400, "Invalid mutation ID");
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(409, "Mutation ID was already used with different input", "idempotency_conflict");
}

function storedFailure(failure: PublicServiceError | undefined): ServiceError {
  if (!isPublicFailure(failure)) throw new ServiceError(500, "Mutation receipt is missing its failure", "internal");
  return new ServiceError(failure.status, failure.message, failure.code);
}

function isDefinitiveGenerationFailure(error: unknown): boolean {
  return isDefinitiveProviderFailure(error);
}

function isPublicFailure(value: unknown): value is PublicServiceError {
  return value !== null && typeof value === "object"
    && typeof (value as PublicServiceError).code === "string"
    && typeof (value as PublicServiceError).message === "string"
    && Number.isSafeInteger((value as PublicServiceError).status);
}

function deterministicEntityId(mutationId: string, namespace: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Mutation entity index must be a non-negative integer");
  return uuidFromDigestHex(
    createHash("sha256").update(`${mutationId}\0${namespace}\0${index}`).digest("hex")
  );
}

function corruptReceipt(mutationId: string): ServiceError {
  return new ServiceError(500, `Mutation receipt is corrupt: ${mutationId}`, "internal");
}
