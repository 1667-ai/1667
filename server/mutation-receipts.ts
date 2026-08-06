import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { uuidFromDigestHex } from "./deterministic-uuid.js";
import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  MUTATION_INPUT_PROTOCOL_VERSION,
  MUTATION_ID_CLOCK_SKEW_MS,
  MUTATION_ID_RETRY_WINDOW_MS,
  canonicalWorkerInputProtocolVersion,
  type MutatingWorkerMethod,
  type WorkerMethod
} from "../shared/worker-protocol.js";
import {
  type StoryPayload
} from "../shared/types.js";
import {
  durableMutationTimestampMs,
  isDurableMutationId
} from "../shared/durable-mutation-id.js";
import {
  chapterBreakRemovalFingerprint
} from "./chapter-breaks.js";
import {
  isTerminalGenerationFailure,
  ProviderRecoveryRequiredError,
  ServiceError
} from "./errors.js";
import {
  MutationReceiptFailureTerminalizer,
  MutationReceiptPersistenceError,
  isMutationReceiptPersistenceError,
  type MutationReceiptFailureReporter
} from "./mutation-receipt-failure.js";
import {
  corruptMutationReceipt,
  encodeMutationResult,
  importPlanFingerprint,
  loadVerifiedChapterBreakRemoval,
  parseMutationReceipt,
  requireChapterBreakRemovalFingerprint,
  requireImportPlanArtifact,
  requireRemovalArtifact,
  restoreMutationReceiptFailure,
  type MutationReceipt,
  type StoredImportPlan
} from "./mutation-receipt-codec.js";
import {
  createMutationPlan,
  mutationPreflightPlan,
  type MutationPlan,
  type MutationPreflightPlan,
  type MutationRecoveryMode
} from "./mutation-plan.js";
import {
  unknownOutcomeFromDurabilityFailure
} from "./mutation-recovery.js";
import {
  isProviderMutationMethod
} from "./mutation-ledger-types.js";
import { isProviderMutationId } from "../shared/provider-recovery.js";
import { mkdirDurable, requireDurableCommit, writeDurableAtomic } from "./story-lifecycle.js";
import { exactStringPattern } from "./story-wire-patterns.js";

const LEGACY_MUTATION_ID_PATTERN = exactStringPattern("m1-([0-9a-z]+)-([0-9a-f]{32})");
// Receipts written before protocolVersion was persisted were all emitted by
// the first embedded-worker protocol shipped on this branch.

export {
  MutationReceiptPersistenceError,
  isMutationReceiptPersistenceError
};

export class MutationReceiptStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly failureTerminalizer: MutationReceiptFailureTerminalizer;

  constructor(
    private readonly dir: string,
    private readonly resolveStory: (id: string) => Promise<StoryPayload>,
    reportFailure?: MutationReceiptFailureReporter
  ) {
    this.failureTerminalizer = new MutationReceiptFailureTerminalizer(
      reportFailure
    );
  }

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
    inputProtocolVersion = canonicalWorkerInputProtocolVersion(
      inputProtocolVersion ?? MUTATION_INPUT_PROTOCOL_VERSION
    );
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
        if (identityMismatch && existing.state === "provider_started") {
          throw providerRecoveryRequired(mutationId);
        }
        if (identityMismatch) throw idempotencyConflict();
        if (existing.state === "completed") return await this.resolve(existing) as T;
        if (existing.state === "failed") {
          if (!isRecoverableProviderWarningFailure(existing)) {
            throw restoreMutationReceiptFailure(existing.failure);
          }
          // Builds before exact provider-target transfer could persist a
          // blocked outer receipt B as failed. Current IDs can re-enter the
          // story resolver to identify the authoritative provider receipt A.
          // A pre-Q ID has no story-ledger proof, so it remains uncertain and
          // cannot dispatch another provider request.
          delete existing.failure;
          const exactRecovery = isProviderMutationId(mutationId);
          existing.state = exactRecovery ? "pending" : "provider_started";
          receipt = existing;
          recoveryMode = exactRecovery ? "pending" : "provider-uncertain";
        } else {
          receipt = existing;
          recoveryMode = existing.state === "provider_started"
            ? "provider-uncertain"
            : "pending";
        }
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
        entityId: (namespace, index = 0) => deterministicMutationEntityId(mutationId, namespace, index),
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
          requireChapterBreakRemovalFingerprint(expectedFingerprint);
          const existingArtifact = receipt.artifact;
          if (existingArtifact !== undefined) {
            if (existingArtifact.kind !== "chapter-break-removal"
              || existingArtifact.fingerprint !== expectedFingerprint
              || chapterBreakRemovalFingerprint(existingArtifact.value)
                !== expectedFingerprint) {
              throw corruptMutationReceipt(mutationId);
            }
            return structuredClone(existingArtifact.value);
          }
          const value = await loadVerifiedChapterBreakRemoval(
            expectedFingerprint,
            load
          );
          receipt.artifact = {
            kind: "chapter-break-removal",
            fingerprint: expectedFingerprint,
            value
          };
          await this.save(receipt);
          return structuredClone(value);
        },
        storedImportPlan: () => receipt.artifact?.kind === "import-plan"
          ? structuredClone(receipt.artifact.value)
          : null,
        // Durable before the caller's story transaction can reach its commit
        // point: the service records the plan inside the canonical mutation
        // callback, before any prepared record or manifest publish, so every
        // receipt whose import committed carries the plan that import applied.
        recordImportPlan: async (value) => {
          const preserved = structuredClone(value) as StoredImportPlan;
          receipt.artifact = {
            kind: "import-plan",
            fingerprint: importPlanFingerprint(preserved),
            value: preserved
          };
          await this.save(receipt);
        },
        providerStarted: async () => {
          if (receipt.state === "provider_started") return;
          receipt.state = "provider_started";
          await this.save(receipt);
        },
        providerRecoveryRequired: () => {
          throw providerRecoveryRequired(mutationId);
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
        if (isMutationReceiptPersistenceError(error)) {
          throw error;
        }
        // Keep exact provider ambiguity replayable. This is either an outer
        // pending receipt blocked by another request or this receipt's own
        // provider-started recovery.
        if (error instanceof ProviderRecoveryRequiredError) {
          throw error;
        }
        const durabilityLoss = unknownOutcomeFromDurabilityFailure(error);
        if (durabilityLoss !== null) {
          return await this.failureTerminalizer.reject(durabilityLoss);
        }
        if (receipt.state === "provider_started"
          && !isTerminalGenerationReceiptFailure(error)) {
          throw new ProviderRecoveryRequiredError(
            mutationId,
            { diagnostic: true }
          );
        }
        return await this.failureTerminalizer.persist(
          error,
          async (failure) => {
            receipt.state = "failed";
            receipt.failure = failure;
            await this.save(receipt);
          }
        );
      }
      receipt.state = "completed";
      receipt.result = encodeMutationResult(value, receipt.artifact);
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
      case "import": {
        const plan = structuredClone(requireImportPlanArtifact(receipt));
        const payload = await this.resolveStory(result.id);
        if (receipt.method === "importLorebook") {
          return { payload, importResult: plan };
        }
        if (receipt.method === "importCard") return { payload, plan };
        throw corruptMutationReceipt(receipt.mutationId);
      }
      case "partial-rewrite": return {
        payload: await this.resolveStory(result.id),
        nodeId: result.nodeId
      };
      case "value": return result.value;
    }
  }

  private async load(mutationId: string): Promise<MutationReceipt | null> {
    validateMutationIdSyntax(mutationId);
    try {
      const value: unknown = JSON.parse(await readFile(this.file(mutationId), "utf8"));
      return parseMutationReceipt(value, mutationId);
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
      throw await this.failureTerminalizer.persistenceFailure(
        error
      );
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
  protocolVersion = MUTATION_INPUT_PROTOCOL_VERSION
): string {
  protocolVersion = canonicalWorkerInputProtocolVersion(protocolVersion);
  const canonical = canonicalJson({
    protocolVersion,
    method,
    input: digestByteArrays(input)
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Replace byte arrays with a digest of their contents.
 *
 * An archive or card import carries its whole file as a Uint8Array. Canonical
 * JSON has no typed-array case, so such a value falls to the object branch and
 * every byte index becomes a sorted string key: a 20 MB file builds twenty
 * million keys and hundreds of megabytes of string before any import limit is
 * read. The digest keeps what a fingerprint needs — the same bytes give the
 * same fingerprint, different bytes do not — at a fixed size. */
function digestByteArrays(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );
    return {
      byteDigest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: value.byteLength
    };
  }
  if (Array.isArray(value)) return value.map(digestByteArrays);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, digestByteArrays(entry)])
    );
  }
  return value;
}

export function validateUnseenMutationId(mutationId: string, now = Date.now()): void {
  const durableTimestamp = durableMutationTimestampMs(mutationId);
  const legacy = durableTimestamp === null
    ? LEGACY_MUTATION_ID_PATTERN.exec(mutationId)
    : null;
  if (durableTimestamp === null && legacy === null) {
    throw invalidMutationId();
  }
  const createdAt = durableTimestamp
    ?? Number.parseInt(legacy![1]!, 36);
  if (!Number.isSafeInteger(createdAt)) throw invalidMutationId();
  if (createdAt < now - MUTATION_ID_RETRY_WINDOW_MS || createdAt > now + MUTATION_ID_CLOCK_SKEW_MS) {
    throw new ServiceError(409, "Mutation ID is outside its retry window", "mutation_expired");
  }
}

function validateMutationIdSyntax(mutationId: string): void {
  if (!LEGACY_MUTATION_ID_PATTERN.test(mutationId)
    && !isDurableMutationId(mutationId)) throw invalidMutationId();
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

function isTerminalGenerationReceiptFailure(error: unknown): boolean {
  return isTerminalGenerationFailure(error)
    || (error instanceof ServiceError
      && error.code === "generation_outcome_unknown_acknowledged");
}

function isRecoverableProviderWarningFailure(
  receipt: MutationReceipt
): boolean {
  return receipt.state === "failed"
    && receipt.failure?.code === "generation_outcome_unknown"
    && isProviderMutationMethod(receipt.method);
}

function providerRecoveryRequired(
  mutationId: string
): ProviderRecoveryRequiredError {
  return new ProviderRecoveryRequiredError(mutationId);
}

export function deterministicMutationEntityId(
  mutationId: string,
  namespace: string,
  index: number
): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Mutation entity index must be a non-negative integer");
  return uuidFromDigestHex(
    createHash("sha256").update(`${mutationId}\0${namespace}\0${index}`).digest("hex")
  );
}
