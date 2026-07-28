import type { Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import type {
  MutationCoordinator,
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import {
  MutationLedgerStore,
  type StoryMutationReceipt
} from "./mutation-ledger-store.js";
import {
  PROVIDER_MUTATION_METHODS,
  isPreparedDomainError,
  type MutationId,
  type MutationResult,
  type PreparedUserMutationRecord,
  type ProviderMutationMethod,
  type StoryMutationMethod
} from "./mutation-ledger-types.js";
import {
  StoryProviderMutationStore
} from "./story-provider-mutation.js";
import type { ProviderStoryMutationCommit } from "./story-provider-contract.js";
import {
  requireExpectedLocalStoryVersion,
  storyAggregateVersion
} from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import { ActiveProviderStarts } from "./story-provider-active-starts.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { requireFreshUnseenMutationId } from "./mutation-id-policy.js";
import {
  commitManifestOnlyStoryTransaction,
  commitPreparedStoryTransaction,
  commitReceiptOnlyStoryTransaction,
  corruptStoryReceipt,
  hashStoryManifest,
  InjectedStoryMutationCrash,
  requireFreshStoryMutation,
  prepareReceiptOnlyStoryError,
  prepareReceiptOnlyStorySuccess,
  storyIdFromScope,
  StoryMutationRecovery,
  storyResult,
  timestamp,
  type StoryMutationClock,
  type StoryMutationHooks
} from "./story-mutation-transaction.js";
import {
  StoryUnknownOutcomeStore,
  type StoryAcknowledgementCommit
} from "./story-unknown-outcome.js";
import { reduceStoryV6 } from "./story-v6-reducer.js";
import type { StoryManifestV6 } from "./story-v6-types.js";
import {
  STORY_UNCHANGED,
  type StoryStore
} from "./stories.js";

export { InjectedStoryMutationCrash };
export type {
  ProviderStoryMutationCommit,
  StoryAcknowledgementCommit
};
export type StoryMutationStoreHooks = StoryMutationHooks;

export type LocalStoryMutationMethod = Exclude<
  StoryMutationMethod,
  | "createStory"
  | "importSillyTavern"
  | "deleteStory"
  | "acknowledgeUnknownOutcomes"
  | typeof PROVIDER_MUTATION_METHODS[number]
>;

const LOCAL_METHODS: ReadonlySet<string> = new Set<LocalStoryMutationMethod>([
  "renameStory",
  "switchLine",
  "createNode",
  "editNode",
  "deleteNode",
  "pruneUnusedTakes",
  "takeFromCut",
  "putBookmark",
  "deleteBookmark",
  "createFact",
  "patchFact",
  "deleteFact",
  "createChapterBreak",
  "renameChapterBreak",
  "removeChapterBreak",
  "restoreChapterBreak"
]);

// The local durability tier in shared/worker-protocol.ts must cover exactly
// the methods runLocal accepts; on drift this constant fails to typecheck.
type LocalTierMethod =
  import("../shared/worker-protocol.js").LocalDurabilityMutationMethod;
type MutuallyAssignable<A, B> =
  [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const LOCAL_TIER_MATCHES_RUN_LOCAL:
  MutuallyAssignable<LocalStoryMutationMethod, LocalTierMethod> = true;
void LOCAL_TIER_MATCHES_RUN_LOCAL;

/** A local-tier mutation ID that reaches the store is fresh by construction:
 * no receipt exists, so recovery evidence for it is always empty. */
const UNRECORDED_STORY_RECEIPT: StoryMutationReceipt = Object.freeze({
  started: null,
  prepared: null,
  completed: null,
  acknowledged: null
});

export interface StoryMutationCommit<Value = void> {
  readonly story: Story;
  readonly result: Extract<MutationResult, { kind: "story" }>;
  readonly aggregateVersion: Exclude<
    ReturnType<typeof storyAggregateVersion>,
    { kind: "absent" }
  >;
  readonly value: Value;
}

export interface StoryDeletionCommit {
  readonly result: Extract<MutationResult, { kind: "story" }>;
}

export interface StoryMutationStoreOptions {
  readonly ledger?: MutationLedgerStore;
  readonly now?: StoryMutationClock;
  readonly hooks?: StoryMutationStoreHooks;
}

/** Successor-Q façade for local, provider, acknowledgement, and deletion
 * transactions over one receipt/recovery authority. */
export class StoryMutationStore {
  private readonly ledger: MutationLedgerStore;
  private readonly now: StoryMutationClock;
  private readonly hooks: StoryMutationStoreHooks;
  private readonly recovery: StoryMutationRecovery;
  private readonly activeProviderStarts: ActiveProviderStarts;
  private readonly providers: StoryProviderMutationStore;
  private readonly unknownOutcomes: StoryUnknownOutcomeStore;

  constructor(
    private readonly stories: StoryStore,
    private readonly coordinator: MutationCoordinator,
    dataDir: string,
    options: StoryMutationStoreOptions = {}
  ) {
    this.ledger = options.ledger ?? new MutationLedgerStore(dataDir);
    this.now = options.now ?? (() => new Date());
    this.hooks = options.hooks ?? {};
    this.recovery = new StoryMutationRecovery(this.ledger, this.now);
    this.activeProviderStarts = new ActiveProviderStarts();
    this.providers = new StoryProviderMutationStore(
      stories,
      coordinator,
      this.ledger,
      this.recovery,
      this.activeProviderStarts,
      this.now,
      this.hooks
    );
    this.unknownOutcomes = new StoryUnknownOutcomeStore(
      stories,
      coordinator,
      this.ledger,
      this.recovery,
      this.now,
      this.hooks
    );
  }

  async init(): Promise<void> {
    await this.ledger.init();
  }

  async getUnknownOutcomeStatus(
    storyId: string,
    originalProviderMutationId: MutationId
  ) {
    return await this.unknownOutcomes.status(
      storyId,
      originalProviderMutationId
    );
  }

  async runLocal(
    input: unknown,
    method: LocalStoryMutationMethod,
    mutate: (
      story: Story,
      session: StoryAggregateSession
    ) => void | typeof STORY_UNCHANGED
      | Promise<void | typeof STORY_UNCHANGED>
  ): Promise<StoryMutationCommit<void>>;
  async runLocal<Value>(
    input: unknown,
    method: LocalStoryMutationMethod,
    mutate: (
      story: Story,
      session: StoryAggregateSession
    ) => Value | typeof STORY_UNCHANGED
      | Promise<Value | typeof STORY_UNCHANGED>,
    replayValue: () => Value
  ): Promise<StoryMutationCommit<Value>>;
  async runLocal(
    input: unknown,
    method: LocalStoryMutationMethod,
    mutate: (
      story: Story,
      session: StoryAggregateSession
    ) => unknown | typeof STORY_UNCHANGED
      | Promise<unknown | typeof STORY_UNCHANGED>,
    replayValue: () => unknown = () => undefined
  ): Promise<StoryMutationCommit<unknown>> {
    if (!LOCAL_METHODS.has(method)) {
      throw new Error(`Unsupported local story method: ${method}`);
    }
    return await this.coordinator.runStory(input, async (request) => {
      const storyId = storyIdFromScope(request.scope);
      if (request.durability === "manifest-only") {
        return await this.runManifestOnlyLocal(
          storyId,
          request,
          mutate,
          replayValue
        );
      }
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      requireFreshStoryMutation(receipt, request.mutationId, this.now);
      if (receipt.prepared !== null) {
        requireMatchingPrepared(receipt, request, method);
      } else if (receipt.started !== null
        || receipt.completed !== null
        || receipt.acknowledged !== null) {
        throw corruptStoryReceipt(request.mutationId);
      }
      return await this.stories.withAggregateSession(storyId, async (session) => {
        await this.recovery.finalizeAggregateTransaction(
          session,
          request.mutationId
        );
        const terminal = await this.recovery.recover(
          session,
          request,
          receipt
        );
        if (terminal !== null) {
          return {
            story: await session.loadLive(),
            result: terminal,
            aggregateVersion: storyAggregateVersion(session.snapshot),
            value: replayValue()
          };
        }
        requireExpectedLocalStoryVersion(
          session.snapshot,
          request.expectedAggregateVersion,
          this.activeProviderStarts.predecessor(
            storyId,
            session.snapshot.manifest.unresolvedProvider?.mutationId ?? null
          )
        );
        const story = await session.loadLive();
        let value: unknown;
        let replacement;
        try {
          const outcome = await mutate(story, session);
          if (outcome === STORY_UNCHANGED) {
            const prepared = prepareReceiptOnlyStorySuccess(
              method,
              request,
              session,
              timestamp(this.now)
            );
            await commitReceiptOnlyStoryTransaction(
              this.ledger,
              prepared,
              this.now,
              this.hooks
            );
            return {
              story,
              result: prepared.result,
              aggregateVersion: storyAggregateVersion(session.snapshot),
              value: replayValue()
            };
          }
          value = outcome;
          replacement = await session.prepareContent(story);
        } catch (error) {
          if (!(error instanceof ServiceError)
            || !isPreparedDomainError(error.code)) {
            throw error;
          }
          const prepared = prepareReceiptOnlyStoryError(
            method,
            request,
            session,
            error.code,
            timestamp(this.now)
          );
          await commitReceiptOnlyStoryTransaction(
            this.ledger,
            prepared,
            this.now,
            this.hooks
          );
          throw error;
        }
        const manifest = reduceStoryV6({
          kind: "present",
          manifest: session.snapshot.manifest,
          manifestHash: session.snapshot.manifestHash
        }, {
          kind: "local-prepared",
          mutationId: request.mutationId,
          expectedManifestHash: session.snapshot.manifestHash,
          content: replacement.content,
          summary: replacement.summary
        });
        if (manifest === null) {
          throw new Error("Local story mutation produced no aggregate");
        }
        const prepared = prepareLocalRecord(
          method,
          request,
          session,
          manifest,
          timestamp(this.now)
        );
        await commitPreparedStoryTransaction({
          session,
          ledger: this.ledger,
          manifest,
          prepared,
          now: this.now,
          hooks: this.hooks
        });
        return {
          story: replacement.story,
          result: storyResult(manifest),
          aggregateVersion: storyAggregateVersion(session.snapshot),
          value
        };
      });
    });
  }

  /**
   * Local durability tier: one atomic manifest publish, no receipt or ledger
   * records. The caller sends a fresh mutation ID with no replay source, so a
   * crash loses at most this mutation and can never duplicate it. Recovery of
   * an earlier transaction still runs first: a retained transaction pointer
   * is finalized and a torn staged manifest is discarded before this
   * mutation may stage its own replacement.
   */
  private async runManifestOnlyLocal(
    storyId: string,
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    mutate: (
      story: Story,
      session: StoryAggregateSession
    ) => unknown | typeof STORY_UNCHANGED
      | Promise<unknown | typeof STORY_UNCHANGED>,
    replayValue: () => unknown
  ): Promise<StoryMutationCommit<unknown>> {
    requireFreshUnseenMutationId(request.mutationId, this.now().getTime());
    return await this.stories.withAggregateSession(storyId, async (session) => {
      await this.recovery.finalizeAggregateTransaction(
        session,
        request.mutationId
      );
      await this.recovery.recover(
        session,
        request,
        UNRECORDED_STORY_RECEIPT
      );
      requireExpectedLocalStoryVersion(
        session.snapshot,
        request.expectedAggregateVersion,
        this.activeProviderStarts.predecessor(
          storyId,
          session.snapshot.manifest.unresolvedProvider?.mutationId ?? null
        )
      );
      const story = await session.loadLive();
      const outcome = await mutate(story, session);
      if (outcome === STORY_UNCHANGED) {
        return {
          story,
          result: storyResult(session.snapshot.manifest),
          aggregateVersion: storyAggregateVersion(session.snapshot),
          value: replayValue()
        };
      }
      const replacement = await session.prepareContent(story);
      const manifest = reduceStoryV6({
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: session.snapshot.manifestHash
      }, {
        kind: "local-committed",
        expectedManifestHash: session.snapshot.manifestHash,
        content: replacement.content,
        summary: replacement.summary
      });
      if (manifest === null) {
        throw new Error("Local story mutation produced no aggregate");
      }
      await commitManifestOnlyStoryTransaction(session, manifest, this.hooks);
      return {
        story: replacement.story,
        result: storyResult(manifest),
        aggregateVersion: storyAggregateVersion(session.snapshot),
        value: outcome
      };
    });
  }

  async runProvider<Method extends ProviderMutationMethod, Value>(
    input: unknown,
    method: Method,
    work: (
      stories: ProviderStoryRuntime<Method>,
      providerStarted: () => Promise<void>
    ) => Promise<Value>,
    replayValue: () => Value
  ): Promise<ProviderStoryMutationCommit<Value>> {
    return await this.providers.run(input, method, work, replayValue);
  }

  async runDelete(input: unknown): Promise<StoryDeletionCommit> {
    return await this.coordinator.runStory(input, async (request) => {
      const receipt = await this.ledger.loadStoryReceipt(
        request.scope,
        request.mutationId
      );
      requireFreshStoryMutation(receipt, request.mutationId, this.now);
      if (receipt.prepared !== null) {
        requireMatchingDeleteReceipt(receipt, request);
      } else if (receipt.started !== null || receipt.completed !== null
        || receipt.acknowledged !== null) {
        throw corruptStoryReceipt(request.mutationId);
      }
      const storyId = storyIdFromScope(request.scope);
      return await this.stories.withAggregateSession(storyId, async (session) => {
        await this.recovery.finalizeAggregateTransaction(
          session,
          request.mutationId
        );
        const terminal = await this.recovery.recover(
          session,
          request,
          receipt
        );
        if (terminal !== null) return { result: terminal };
        requireExpectedLocalStoryVersion(
          session.snapshot,
          request.expectedAggregateVersion,
          this.activeProviderStarts.predecessor(
            storyId,
            session.snapshot.manifest.unresolvedProvider?.mutationId ?? null
          )
        );
        const oldStateHash = session.snapshot.manifestHash;
        const manifest = reduceStoryV6({
          kind: "present",
          manifest: session.snapshot.manifest,
          manifestHash: oldStateHash
        }, {
          kind: "delete-prepared",
          mutationId: request.mutationId,
          expectedManifestHash: oldStateHash,
          deletedAt: timestamp(this.now)
        });
        if (manifest === null) {
          throw new Error("Delete transition removed its recovery tombstone");
        }
        await session.ensureCleanupPending();
        const prepared: PreparedUserMutationRecord = {
          schema: 1,
          kind: "prepared",
          purpose: "mutation",
          aggregateKey: request.scope,
          key: request.mutationId,
          fingerprintHash: request.fingerprint,
          method: "deleteStory",
          oldStateHash,
          newStateHash: hashStoryManifest(manifest),
          startedRecordHash: null,
          result: storyResult(manifest),
          preparedAt: timestamp(this.now)
        };
        await commitPreparedStoryTransaction({
          session,
          ledger: this.ledger,
          manifest,
          prepared,
          now: this.now,
          hooks: this.hooks
        });
        return { result: storyResult(manifest) };
      });
    });
  }

  async runAcknowledge(
    input: unknown,
    originalProviderMutationId: MutationId
  ): Promise<StoryAcknowledgementCommit> {
    return await this.unknownOutcomes.run(
      input,
      originalProviderMutationId
    );
  }
}

function prepareLocalRecord(
  method: LocalStoryMutationMethod,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  session: StoryAggregateSession,
  manifest: StoryManifestV6,
  preparedAt: string
): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: request.scope,
    key: request.mutationId,
    fingerprintHash: request.fingerprint,
    method,
    oldStateHash: session.snapshot.manifestHash,
    newStateHash: hashStoryManifest(manifest),
    startedRecordHash: null,
    result: storyResult(manifest),
    preparedAt
  };
}

function requireMatchingPrepared(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: LocalStoryMutationMethod
): void {
  const prepared = receipt.prepared;
  if (prepared === null || prepared.purpose !== "mutation"
    || prepared.aggregateKey !== request.scope
    || prepared.key !== request.mutationId
    || prepared.method !== method
    || prepared.fingerprintHash !== request.fingerprint
    || prepared.startedRecordHash !== null) {
    throw storyIdempotencyConflict();
  }
}

function requireMatchingDeleteReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>
): void {
  const prepared = receipt.prepared;
  if (prepared === null || prepared.purpose !== "mutation"
    || prepared.aggregateKey !== request.scope
    || prepared.key !== request.mutationId
    || prepared.method !== "deleteStory"
    || prepared.fingerprintHash !== request.fingerprint
    || prepared.startedRecordHash !== null) {
    throw storyIdempotencyConflict();
  }
}

function storyIdempotencyConflict(): ServiceError {
  return new ServiceError(
    409,
    "Mutation ID was already used for different story input.",
    "idempotency_conflict"
  );
}
