import type { Story } from "../shared/types.js";
import type {
  ProviderRecoveryContext
} from "../shared/provider-recovery.js";
import {
  LOCAL_DURABILITY_MUTATION_METHODS,
  type LocalDurabilityMutationMethod
} from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";
import type {
  MutationCoordinator,
  MutationCoordinatorRequest,
  StoryAggregateVersion,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import {
  MutationLedgerStore,
  type StoryMutationReceipt
} from "./mutation-ledger-store.js";
import {
  isPreparedDomainError,
  type MutationId,
  type MutationResult,
  type PreparedUserMutationRecord,
  type ProviderMutationMethod
} from "./mutation-ledger-types.js";
import {
  StoryProviderMutationStore
} from "./story-provider-mutation.js";
import type {
  ProviderStoryMutationCommit,
  ProviderStoryRun
} from "./story-provider-contract.js";
import {
  requireExpectedLocalStoryVersion,
  storyAggregateVersion
} from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import { ActiveProviderStarts } from "./story-provider-active-starts.js";
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
import type { StoryEnvelopeManifest } from "./story-v6-types.js";
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

/** The single source for this set is the shared protocol array; the alias
 * keeps the ledger-side name while guaranteeing both sides cannot drift. */
export type LocalStoryMutationMethod = LocalDurabilityMutationMethod;

const LOCAL_METHODS: ReadonlySet<string> = new Set(
  LOCAL_DURABILITY_MUTATION_METHODS
);

/** The durability tier of one admitted local command. "manifest-only" holds
 * only for a marked request with no durable evidence for its mutation ID:
 * any evidence means an earlier full-tier execution exists — for example a
 * replay retained by a pre-tiering build — and those requests fail closed
 * into the full receipt/ledger semantics. */
type LocalDurabilityTier = "full" | "manifest-only";

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
    warningMutationId: MutationId,
    providerRecovery?: ProviderRecoveryContext
  ) {
    return await this.unknownOutcomes.status(
      storyId,
      {
        mutationId: warningMutationId,
        recovery: providerRecovery
      }
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
    return await this.coordinator.runStory(input, async (request) =>
      await this.withRecoveredStorySession(
        request,
        method,
        async (session, terminal, tier) => {
          if (terminal !== null) {
            return {
              story: await session.loadLive(),
              result: terminal,
              aggregateVersion: storyAggregateVersion(session.snapshot),
              value: replayValue()
            };
          }
          const story = await session.loadLive();
          let value: unknown;
          let replacement;
          try {
            const outcome = await mutate(story, session);
            if (outcome === STORY_UNCHANGED) {
              if (tier === "manifest-only") {
                return {
                  story,
                  result: storyResult(session.snapshot.manifest),
                  aggregateVersion: storyAggregateVersion(session.snapshot),
                  value: replayValue()
                };
              }
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
            // Read straight off `this.stories`, the `StoryStore` this
            // mutation store was built with, rather than taking a second,
            // independently settable activation option: the store already
            // owns the concept (`StoryStore`'s own `imageInputActivation`
            // doc comment), so this is the same gate that decided whether
            // this session could reopen the story in the first place.
            replacement = await session.prepareContent(story, { activation: this.stories.imageInputActivation });
          } catch (error) {
            // A manifest-only mutation has no replay to keep deterministic,
            // so a domain rejection needs no receipt-only record either.
            if (tier === "manifest-only"
              || !(error instanceof ServiceError)
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
          }, tier === "manifest-only"
            ? {
                kind: "local-committed",
                expectedManifestHash: session.snapshot.manifestHash,
                content: replacement.content,
                summary: replacement.summary
              }
            : {
                kind: "local-prepared",
                mutationId: request.mutationId,
                expectedManifestHash: session.snapshot.manifestHash,
                content: replacement.content,
                summary: replacement.summary
              });
          if (manifest === null) {
            throw new Error("Local story mutation produced no aggregate");
          }
          if (tier === "manifest-only") {
            await commitManifestOnlyStoryTransaction(
              session,
              manifest,
              this.hooks
            );
          } else {
            await commitPreparedStoryTransaction({
              session,
              ledger: this.ledger,
              manifest,
              prepared: prepareLocalRecord(
                method,
                request,
                session,
                manifest,
                timestamp(this.now)
              ),
              now: this.now,
              hooks: this.hooks
            });
          }
          return {
            story: replacement.story,
            result: storyResult(manifest),
            aggregateVersion: storyAggregateVersion(session.snapshot),
            value
          };
        }
      ));
  }

  /**
   * Shared admission spine for receipt-backed local commands and deletion:
   * durable evidence lookup, freshness, identity matching, prior-transaction
   * finalization, torn-stage recovery, and the version check with its
   * provider-fence predecessor. The durability tier is resolved here, from
   * evidence rather than trust: the manifest-only marker applies only when
   * this mutation ID has no durable evidence, so a replay of a full-tier
   * execution — however it arrives — takes the full-tier semantics and its
   * recovery, never the receipt-free path.
   */
  private async withRecoveredStorySession<T>(
    request: MutationCoordinatorRequest<StoryMutationTarget>,
    method: LocalStoryMutationMethod | "deleteStory",
    work: (
      session: StoryAggregateSession,
      terminal: Extract<MutationResult, { kind: "story" }> | null,
      tier: LocalDurabilityTier
    ) => Promise<T>
  ): Promise<T> {
    const storyId = storyIdFromScope(request.scope);
    const receipt = await this.ledger.loadStoryReceipt(
      request.scope,
      request.mutationId
    );
    requireFreshStoryMutation(receipt, request.mutationId, this.now);
    if (receipt.prepared !== null) {
      requireMatchingLocalPrepared(receipt, request, method);
    } else if (receipt.started !== null
      || receipt.completed !== null
      || receipt.acknowledged !== null) {
      throw corruptStoryReceipt(request.mutationId);
    }
    const tier: LocalDurabilityTier =
      request.durability === "manifest-only" && receipt.prepared === null
        ? "manifest-only"
        : "full";
    return await this.stories.withAggregateSession(storyId, async (session) => {
      await this.recovery.finalizeAggregateTransaction(
        session,
        request.mutationId
      );
      const terminal = await this.recovery.recover(session, request, receipt);
      if (terminal === null) {
        requireExpectedLocalStoryVersion(
          session.snapshot,
          request.expectedAggregateVersion,
          this.activeProviderStarts.predecessor(
            storyId,
            session.snapshot.manifest.unresolvedProvider?.mutationId ?? null
          )
        );
      }
      return await work(session, terminal, tier);
    });
  }

  async runProviderOperation<
    Method extends ProviderMutationMethod,
    Value
  >(
    input: unknown,
    method: Method,
    operation: ProviderStoryRun<Method, Value>
  ): Promise<ProviderStoryMutationCommit<Value>> {
    return await this.providers.run(input, method, operation);
  }

  async runDelete(input: unknown): Promise<StoryDeletionCommit> {
    return await this.coordinator.runStory(input, async (request) =>
      await this.withRecoveredStorySession(
        request,
        "deleteStory",
        async (session, terminal) => {
          if (terminal !== null) return { result: terminal };
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
        }
      ));
  }

  async runAcknowledge(
    input: unknown,
    warningMutationId: MutationId,
    providerRecovery?: ProviderRecoveryContext
  ): Promise<StoryAcknowledgementCommit> {
    return await this.unknownOutcomes.run(
      input,
      {
        mutationId: warningMutationId,
        recovery: providerRecovery
      }
    );
  }
}

function prepareLocalRecord(
  method: LocalStoryMutationMethod,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  session: StoryAggregateSession,
  manifest: StoryEnvelopeManifest,
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

function requireMatchingLocalPrepared(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: LocalStoryMutationMethod | "deleteStory"
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

function storyIdempotencyConflict(): ServiceError {
  return new ServiceError(
    409,
    "Mutation ID was already used for different story input.",
    "idempotency_conflict"
  );
}
