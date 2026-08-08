import {
  GENERATION_METHODS,
  LEGACY_WORKER_PROTOCOL_VERSION,
  PROVIDER_CHECK_METHODS,
  STREAM_METHODS,
  WORKER_BUILD_IDENTITY,
  WORKER_CANCEL_GRACE_MS,
  WORKER_MUTATION_DEADLINE_MS,
  WORKER_PROVIDER_CHECK_TIMEOUT_MS,
  WORKER_PROTOCOL_VERSION,
  WORKER_STREAM_DEADLINE_MS,
  WORKER_UNARY_TIMEOUT_MS,
  isManifestOnlyDurabilityEligible,
  isServiceOwnedSettingsMutation,
  isWorkerMutationMethod,
  type WorkerInput,
  type WorkerMethod,
  type WorkerOperationId,
  type WorkerOutput
} from "../../shared/worker-protocol.js";
import { LifecycleRetry } from "../../shared/lifecycle-retry.js";
import { sameBuildIdentity } from "../../shared/build-identity.js";
import { resolveDataDirectory } from "../../server/data-directory.js";
import { ServiceError } from "../../server/errors.js";
import {
  MutationOutbox,
  providerRecoveryFromArchive,
  storyIdFromMutationIntent,
  type ArchivedMutationOutboxRecord,
  type MutationOutboxRecord
} from "../../server/mutation-outbox.js";
import { validateWorkerRequestSize } from "../../server/worker-request-size.js";
import { WorkerLifecycle, type WorkerLike } from "./worker-lifecycle.js";
import { decodeWorkerMessage } from "./worker-message.js";
import { createMutationId } from "./worker-mutation-id.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { SerializedWorkerOutbox } from "./worker-outbox.js";
import { PendingRequestRegistry } from "./worker-pending.js";
import { loadWorkerRecoveryOutbox, OutboxRecoveryCoordinator } from "./worker-recovery.js";
import { preparePendingWorkerShutdown } from "./worker-shutdown.js";
import {
  BackendRestartRequiredError,
  WorkerApiError,
  workerApiErrorFromFailure
} from "./worker-error.js";
import { settleWorkerTerminal } from "./worker-terminal.js";
import { openPendingWorkerCall } from "./worker-call-allocation.js";
import { prepareWorkerMutationIntent } from "./worker-mutation-publication.js";
import type { WorkerRecoveryWarning, WorkerStoryApiOptions } from "./worker-api-contract.js";
import { embeddedWorkerHostCause } from "./worker-host-diagnostics.js";

declare const __AI_1667_EMBEDDED_WORKER_SOURCE__: string | undefined;

export class WorkerTransport {
  private readonly lifecycle: WorkerLifecycle;
  private readonly recoveryCoordinator: OutboxRecoveryCoordinator<WorkerApiError>;
  private readonly worker: WorkerLike;
  private readonly outbox: SerializedWorkerOutbox;
  private readonly archivedMutationCleanup =
    new LifecycleRetry<string>();
  private readonly archivesDeferredUntilReplay = new Set<string>();
  private archivedMutationCleanupStop: Promise<void> | null = null;
  private restartRequired: BackendRestartRequiredError | null = null;
  private resolveRestartSignal!: (error: BackendRestartRequiredError) => void;
  private readonly restartSignal = new Promise<BackendRestartRequiredError>(
    (resolve) => { this.resolveRestartSignal = resolve; }
  );

  get recoveryWarnings(): readonly WorkerRecoveryWarning[] { return this.recoveryCoordinator.warnings; }
  get recovery(): Promise<readonly WorkerRecoveryWarning[]> { return this.recoveryCoordinator.recovery; }
  get failure(): Promise<Error> { return this.lifecycle.failure; }

  private readonly onMessage = ((event: MessageEvent<unknown>) => {
    void this.receive(event.data).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)), false);
    });
  }) as EventListener;
  private readonly onError = ((event: ErrorEvent) => {
    event.preventDefault?.();
    if (this.lifecycle.unexpectedExitIsFailure) {
      this.fail(new Error(event.message || "Embedded backend worker failed"), false);
    }
  }) as EventListener;
  private readonly onClose = (() => {
    const unexpected = this.lifecycle.unexpectedExitIsFailure;
    this.lifecycle.markExited();
    if (unexpected) this.fail(new Error("Embedded backend worker exited unexpectedly"), false);
  }) as EventListener;

  constructor(
    private readonly options: WorkerStoryApiOptions,
    outbox: MutationOutbox | null = null,
    private readonly pending = new PendingRequestRegistry()
  ) {
    this.outbox = new SerializedWorkerOutbox(outbox);
    this.worker = options.worker ?? createDefaultWorker();
    this.lifecycle = new WorkerLifecycle(this.worker, options, (error) => this.fail(error, false));
    this.recoveryCoordinator = new OutboxRecoveryCoordinator(
      (record) => this.replayMutation(record),
      (warnings) => { options.onRecoveryWarnings?.(warnings); }
    );
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("close", this.onClose);
    if (options.worker === undefined) {
      this.worker.postMessage({
        type: "bootstrap",
        dataDir: resolveDataDirectory(options.dataDir),
        externalDataLock: true,
        ...(options.machineDir === undefined ? {} : { machineDir: options.machineDir }),
        ...(options.printLogs === true ? { printLogs: true } as const : {}),
        ...(options.freshDataDirectory === true ? { freshDataDirectory: true } as const : {})
      });
    }
  }

  async start(): Promise<void> {
    this.lifecycle.start();
    let workerReady = false;
    let recoveryRecords: MutationOutboxRecord[] = [];
    let archivedRecords: ArchivedMutationOutboxRecord[] = [];
    let deferredArchiveMutationIds: string[] = [];
    const outbox = this.outbox.store;
    try {
      await this.lifecycle.ready;
      workerReady = true;
      if (outbox !== null) {
        ({
          recoveryRecords,
          archivedRecords,
          deferredArchiveMutationIds
        } = await loadWorkerRecoveryOutbox(this.outbox, outbox));
      }
    } catch (error) {
      const failure = workerReady
        ? this.requireRestart("Embedded backend startup failed after readiness", error)
        : error;
      await this.lifecycle.stop(false);
      throw failure;
    }
    for (const archived of archivedRecords) {
      const providerRecovery = providerRecoveryFromArchive(archived);
      this.recoveryCoordinator.warn({
        mutationId: archived.intent.mutationId,
        method: archived.intent.method,
        storyId: storyIdFromMutationIntent(archived.intent),
        ...(providerRecovery === undefined
          ? {}
          : { providerRecovery }),
        resolution: "archived",
        error: workerApiErrorFromFailure(archived.resolution)
      });
    }
    deferredArchiveMutationIds.forEach((mutationId) =>
      this.archivesDeferredUntilReplay.add(mutationId));
    this.recoveryCoordinator.start(recoveryRecords);
  }

  call<M extends WorkerMethod>(
    method: M,
    input: WorkerInput<M>,
    options: {
      onDelta?: (text: string) => void;
      /** Receives, exactly once at terminal settlement, the stream text
       * that arrived after `signal` aborted (withheld deltas plus the
       * worker's own reclaimed tail). `onDelta` is never called after the
       * abort. */
      onStopped?: (text: string) => void;
      signal?: AbortSignal;
      expectedAggregateVersion?: StoryAggregateVersion;
    } = {}
  ): Promise<WorkerOutput<M>> {
    return this.beginCall(method, input, options);
  }

  async dismissArchivedMutation(mutationId: string): Promise<void> {
    await this.retireArchivedMutation(mutationId, true);
  }

  private async retireArchivedMutation(
    mutationId: string,
    dismissWarning: boolean
  ): Promise<void> {
    const outbox = this.outbox.store;
    if (outbox === null) return;
    await this.archivedMutationCleanup.start(
      mutationId,
      async () => {
        await this.outbox.run(() => outbox.dismissArchived(mutationId));
        if (dismissWarning) {
          this.recoveryCoordinator.dismissWarning(mutationId);
        }
      }
    );
  }

  private async beginCall<M extends WorkerMethod>(
    method: M,
    input: WorkerInput<M>,
    options: {
      onDelta?: (text: string) => void;
      onStopped?: (text: string) => void;
      signal?: AbortSignal;
      expectedAggregateVersion?: StoryAggregateVersion;
    }
  ): Promise<WorkerOutput<M>> {
    if (!this.lifecycle.acceptingRequests) return Promise.reject(new Error("Embedded backend is not running"));
    if (isAborted(options.signal)) return Promise.resolve(null as WorkerOutput<M>);
    const mutating = isWorkerMutationMethod(method);
    if (mutating
      && this.recoveryCoordinator.warnings.length > 0
      && this.options.onRecoveryWarnings?.(
        this.recoveryCoordinator.warnings
      ) === true) {
      throw workerApiErrorFromFailure(createFailureEnvelope({
        code: "mutation_outcome_unknown",
        message: "1667 is reloading saved state. Try again when the reload is complete.",
        status: 409
      }));
    }
    // Reads may proceed while startup recovery reconciles authoritative state,
    // but a new write must not overtake an older retained intent. In particular,
    // a delete racing replay could otherwise make deterministic absence look
    // like an unsent create and resurrect the deleted entity.
    if (mutating && this.recoveryCoordinator.blocksMutations) await this.recoveryCoordinator.recovery;
    if (!this.lifecycle.acceptingRequests) throw new Error("Embedded backend is not running");
    if (isAborted(options.signal)) return null as WorkerOutput<M>;
    try {
      validateWorkerRequestSize(method, input, WORKER_PROTOCOL_VERSION);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw new WorkerApiError(createFailureEnvelope(error));
      }
      throw error;
    }
    const mutationId = mutating && !isServiceOwnedSettingsMutation(method)
      ? createMutationId()
      : undefined;
    // Single tier decision: a fresh, marker-eligible local mutation on a
    // versioned aggregate gets the manifest-only marker, writes no durable
    // intent, and is never replayed — a crash loses at most one human
    // action. Everything else (provider work, inputs that embed paid or
    // store-absent content, the pre-Q lane without an aggregate version, and
    // every outbox replay, which never carries the marker) keeps the full
    // intent pipeline.
    const durability = mutationId !== undefined
      && options.expectedAggregateVersion !== undefined
      && isManifestOnlyDurabilityEligible(method, input)
      ? "manifest-only" as const
      : undefined;
    const outbox = this.outbox.store;
    const intent = mutationId === undefined
      || durability !== undefined
      || outbox === null
      ? undefined
      : await prepareWorkerMutationIntent({
        mutationId,
        method,
        input,
        ...(options.expectedAggregateVersion === undefined ? {} : {
          expectedAggregateVersion: options.expectedAggregateVersion
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        graceMs: this.options.cancelGraceMs ?? WORKER_CANCEL_GRACE_MS,
        outbox: this.outbox,
        store: outbox,
        hardFence: (message, cause) => this.failForRestart(message, cause)
      });
    if (intent === null) return null as WorkerOutput<M>;
    try {
      if (mutationId !== undefined) {
        if (isAborted(options.signal)) {
          await intent?.cancel();
          return null as WorkerOutput<M>;
        }
        if (!this.lifecycle.acceptingRequests) {
          await intent?.cancel();
          throw new Error("Embedded backend stopped before the mutation was sent");
        }
      }
      const stream = STREAM_METHODS.has(method);
      const readTimeoutMs = PROVIDER_CHECK_METHODS.has(method)
        ? WORKER_PROVIDER_CHECK_TIMEOUT_MS
        : this.options.unaryTimeoutMs ?? WORKER_UNARY_TIMEOUT_MS;
      // Never reject while a live worker can keep committing. A mutation
      // deadline fails the transport, terminates the worker, and retains its outbox.
      const timeoutMs = stream || mutating
        ? null
        : readTimeoutMs;
      const deadlineAfterMs = GENERATION_METHODS.has(method)
        ? this.options.streamDeadlineMs ?? WORKER_STREAM_DEADLINE_MS
        : mutating
          ? this.options.mutationDeadlineMs ?? WORKER_MUTATION_DEADLINE_MS
          : readTimeoutMs;
      const registered = openPendingWorkerCall<WorkerOutput<M>>({
        method,
        stream,
        ...(mutationId === undefined ? {} : { mutationId }),
        durableIntent: intent !== undefined,
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        ...(options.onStopped === undefined ? {} : { onStopped: options.onStopped }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs,
        deadlineAfterMs,
        cancelGraceMs: this.options.cancelGraceMs ?? WORKER_CANCEL_GRACE_MS,
        pendingRequests: this.pending,
        worker: this.worker,
        outbox: this.outbox,
        fail: (error) => this.fail(error, false),
        failForRestart: (message, cause) => this.failForRestart(message, cause),
        allocationFailure: (error) => {
          const restart = this.requireRestart(
            `Embedded backend could not allocate a ${method} operation`,
            error
          );
          this.fail(restart, false);
          throw restart;
        }
      });
      try {
        this.worker.postMessage({
          type: "request",
          id: registered.id,
          method,
          input,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          deadlineMs: Date.now() + deadlineAfterMs,
          ...(mutationId === undefined ? {} : { mutationId }),
          ...(options.expectedAggregateVersion === undefined ? {} : {
            expectedAggregateVersion: options.expectedAggregateVersion
          }),
          ...(durability === undefined ? {} : { durability })
        });
      } catch (error) {
        const pending = this.pending.discard(registered.id);
        const failure = error instanceof Error ? error : new Error(String(error));
        const restart = this.requireRestart(
          `Embedded backend ${method} request delivery failed`,
          failure
        );
        pending?.reject(restart);
        this.fail(restart, false);
      }
      return registered.promise;
    } finally {
      intent?.release();
    }
  }

  async dispose(): Promise<void> {
    if (this.lifecycle.beginDispose()) {
      try {
        await this.stopArchivedMutationCleanup();
        const prepared = preparePendingWorkerShutdown(
          this.pending, this.outbox, this.worker,
          this.options.cancelGraceMs ?? WORKER_CANCEL_GRACE_MS,
          (message, cause) => this.failForRestart(message, cause)
        ).then(() => null);
        const restart = await Promise.race([prepared, this.restartSignal]);
        if (restart !== null) throw restart;
        await this.lifecycle.stop(true);
      } catch (error) {
        try {
          await this.lifecycle.stop(false);
        } catch {
          // The restart-required result below owns shutdown failure reporting.
        }
        throw this.requireRestart(
          "Embedded backend did not confirm a safe shutdown",
          error
        );
      } finally {
        try {
          let restart = this.restartRequired;
          if (restart === null) {
            const drained = this.outbox.drain().then(() => null);
            const signalled = await Promise.race([drained, this.restartSignal]);
            restart = signalled ?? this.restartRequired;
          }
          if (restart !== null) throw restart;
        } finally {
          this.close(this.restartRequired ?? new Error("Embedded backend stopped"));
        }
      }
      return;
    }
    try {
      await this.stopArchivedMutationCleanup();
      await this.lifecycle.awaitTermination();
    } catch (error) {
      if (this.restartRequired !== null) throw this.restartRequired;
      throw error;
    }
    if (this.restartRequired !== null) throw this.restartRequired;
  }

  private async receive(value: unknown): Promise<void> {
    const message = decodeWorkerMessage(value);
    if (message === null) {
      return this.fail(
        new Error("Embedded backend sent a malformed message"),
        false
      );
    }
    if (message.type === "starting" || message.type === "ready") {
      if (message.protocolVersion !== WORKER_PROTOCOL_VERSION
        || !sameBuildIdentity(message.buildIdentity, WORKER_BUILD_IDENTITY)) {
        return this.fail(new Error(
          `Embedded backend build mismatch (worker protocol ${message.protocolVersion})`
        ), false);
      }
      try {
        this.pending.bindWorkerInstance(message.workerInstanceId);
      } catch (error) {
        return this.fail(error instanceof Error ? error : new Error(String(error)), false);
      }
      if (message.type === "starting") {
        if (!this.lifecycle.reportStarting()) {
          return this.fail(new Error("Embedded backend regressed to starting after ready"), false);
        }
      } else {
        if (!this.lifecycle.reportReady()) return this.fail(new Error("Embedded backend sent duplicate readiness"), false);
      }
      return;
    }
    if (message.type === "protocolError") {
      const failure = workerApiErrorFromFailure(message.failure);
      if (this.lifecycle.hasReachedReady) {
        this.failForRestart(failure.message, failure);
        return;
      }
      return this.fail(failure, false);
    }
    if (message.type === "stopped") return;
    const pending = this.pending.get(message.id);
    if (message.type === "delta") {
      if (pending === undefined) {
        this.worker.postMessage({ type: "ack", id: message.id, sequence: message.sequence });
        return;
      }
      if (!pending.stream || message.sequence !== pending.expectedSequence) {
        return this.fail(new Error("Embedded backend stream sequence mismatch"), false);
      }
      pending.expectedSequence += 1;
      pending.receivedDeltaBatches += 1;
      pending.receivedUtf16Units += message.text.length;
      try {
        // After the caller's signal aborts, `onDelta` must never run again.
        // The text still arrived from the server, so it is withheld into
        // the stopped tail (delivered once at terminal settlement) rather
        // than dropped, and the batch is still acknowledged so worker
        // credit keeps flowing toward that terminal.
        if (pending.cancelled) pending.stoppedTail += message.text;
        else pending.onDelta?.(message.text);
        this.worker.postMessage({ type: "ack", id: message.id, sequence: message.sequence });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // A mutating stream may already be between provider completion and its
        // durable story commit. Terminate before rejecting so its outbox stays
        // available for authoritative recovery instead of trusting cancel.
        this.fail(failure, false);
      }
      return;
    }
    if (message.type === "operation") {
      if (pending === undefined || pending.settling || message.state === "running") return;
      if (message.state === "unknown") {
        if (isWorkerMutationMethod(pending.method)) {
          await settleWorkerTerminal({
            message: {
              type: "error",
              id: message.id,
              failure: createFailureEnvelope({
                code: "operation_unknown",
                message: "Something interrupted the last change. You can try again.",
                status: 410
              }),
              mutationOutcome: "uncertain"
            },
            pending,
            pendingRequests: this.pending,
            outbox: this.outbox,
            recovery: this.recoveryCoordinator,
            acknowledge: () => this.acknowledgeTerminal(message.id),
            fail: (error) => this.failForRestart(error.message, error)
          });
          return;
        }
        const error = new WorkerApiError(createFailureEnvelope({
          code: "operation_unknown",
          message: "The requested data is no longer available. Try again.",
          status: 410
        }));
        this.pending.discard(message.id);
        pending.reject(error);
        return;
      }
      return this.fail(new Error(
        "Embedded backend reported terminal operation status without its terminal result"
      ), false);
    }
    if (pending === undefined) {
      this.acknowledgeTerminal(message.id);
      return;
    }
    await settleWorkerTerminal({
      message,
      pending,
      pendingRequests: this.pending,
      outbox: this.outbox,
      recovery: this.recoveryCoordinator,
      acknowledge: () => this.acknowledgeTerminal(message.id),
      fail: (error) => this.failForRestart(error.message, error)
    });
  }

  private async replayMutation(record: MutationOutboxRecord): Promise<void> {
    if (!this.lifecycle.acceptingRequests) return Promise.reject(new Error("Embedded backend stopped during mutation recovery"));
    const stream = STREAM_METHODS.has(record.method);
    const deadlineAfterMs = GENERATION_METHODS.has(record.method)
      ? this.options.streamDeadlineMs ?? WORKER_STREAM_DEADLINE_MS
      : this.options.mutationDeadlineMs ?? WORKER_MUTATION_DEADLINE_MS;
    const registered = this.pending.open<void>({
      method: record.method,
      replay: true,
      stream,
      mutationId: record.mutationId,
      // Replays exist because the intent exists; it must settle durably.
      durableIntent: true,
      timeoutMs: deadlineAfterMs,
      onTimeout: (id) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        try {
          this.worker.postMessage({ type: "cancel", id, reason: "deadline" });
        } catch (error) {
          this.failForRestart(
            `Embedded backend ${record.method} recovery cancellation could not be sent`,
            error
          );
          return;
        }
        const graceMs = this.options.cancelGraceMs ?? WORKER_CANCEL_GRACE_MS;
        pending.startCancellationGrace(graceMs, () => {
          if (!this.pending.isCurrent(pending)) return;
          this.failForRestart(
            `Embedded backend ${record.method} recovery exceeded ${deadlineAfterMs} ms and ${graceMs} ms cancellation grace`
          );
        });
      }
    });
    try {
      this.worker.postMessage({
        type: "request",
        id: registered.id,
        method: record.method,
        input: record.input,
        protocolVersion: record.protocolVersion ?? LEGACY_WORKER_PROTOCOL_VERSION,
        mutationId: record.mutationId,
        ...(record.expectedAggregateVersion === undefined ? {} : {
          expectedAggregateVersion: record.expectedAggregateVersion
        }),
        deadlineMs: Date.now() + deadlineAfterMs
      });
    } catch (error) {
      this.failForRestart(
        `Embedded backend ${record.method} recovery request delivery failed`,
        error
      );
    }
    await registered.promise;
    if (!this.archivesDeferredUntilReplay.delete(record.mutationId)) {
      return;
    }
    const warning = this.recoveryCoordinator.warnings.find(
      ({ mutationId }) => mutationId === record.mutationId
    );
    if (warning?.resolution !== "archived") {
      await this.retireArchivedMutation(record.mutationId, false);
    }
  }

  private fail(error: Error, graceful: boolean): void {
    if (!this.lifecycle.unexpectedExitIsFailure) return;
    const failure = this.restartFailure(error);
    this.lifecycle.signalFailure(failure);
    this.close(failure);
    void this.lifecycle.stop(graceful).catch(() => undefined);
  }
  private failForRestart(message: string, cause?: unknown): BackendRestartRequiredError {
    const failure = this.requireRestart(message, cause);
    if (this.lifecycle.unexpectedExitIsFailure) {
      this.fail(failure, false);
    } else {
      this.lifecycle.signalFailure(failure);
      this.close(failure);
      void this.lifecycle.stop(false).catch(() => undefined);
    }
    return failure;
  }
  private requireRestart(message: string, cause?: unknown): BackendRestartRequiredError {
    if (this.restartRequired === null) {
      const diagnosticRef = cause instanceof WorkerApiError
        ? cause.diagnosticRef
        : null;
      this.restartRequired = new BackendRestartRequiredError(message, {
        cause: embeddedWorkerHostCause(
          cause,
          this.pending.diagnosticSnapshot()
        ),
        diagnosticRef
      });
      this.resolveRestartSignal(this.restartRequired);
    }
    return this.restartRequired;
  }
  private restartFailure(error: Error): Error {
    if (error instanceof BackendRestartRequiredError) {
      this.restartRequired ??= error;
      return this.restartRequired;
    }
    if (!this.lifecycle.hasReachedReady) return error;
    return this.requireRestart(error.message, error);
  }
  private close(error: Error): void {
    void this.stopArchivedMutationCleanup();
    if (!this.lifecycle.close(error)) return;
    this.pending.close(error);
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("close", this.onClose);
  }
  private stopArchivedMutationCleanup(): Promise<void> {
    this.archivedMutationCleanupStop ??=
      this.archivedMutationCleanup.stop();
    return this.archivedMutationCleanupStop;
  }
  private acknowledgeTerminal(id: WorkerOperationId): void {
    try {
      this.worker.postMessage({ type: "terminalAck", id });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), false);
    }
  }
}

function createDefaultWorker(): Worker {
  if (typeof __AI_1667_EMBEDDED_WORKER_SOURCE__ === "string") {
    const workerFile = new File(
      [__AI_1667_EMBEDDED_WORKER_SOURCE__],
      "1667-worker.js",
      { type: "application/javascript" }
    );
    return new Worker(URL.createObjectURL(workerFile), { type: "module" });
  }
  return new Worker(
    new URL("../../server/worker.js", import.meta.url),
    { type: "module" }
  );
}
function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
