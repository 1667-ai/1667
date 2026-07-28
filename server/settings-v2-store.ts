import {
  SETTINGS_ROUTE_PURPOSE_VALUES,
  type SettingsActivationOutcomeV2,
  type SettingsDocumentV2,
  type SettingsMutationResult,
  type SettingsStateV2,
  type SettingsRoutePurpose,
  type SettingsView
} from "../shared/settings-v2-types.js";
import { selectSettingsRoute } from "../shared/settings-route.js";
import type { GenerationSettings } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import {
  createMutationCoordinator,
  MutationCoordinator,
  type MutationCoordinatorRequest,
  type SettingsMutationTarget
} from "./mutation-coordinator.js";
import { hashPreparedMutationRecord } from "./mutation-ledger-codec.js";
import { MutationLedgerStore } from "./mutation-ledger-store.js";
import type {
  PreparedUserMutationRecord
} from "./mutation-ledger-types.js";
import {
  hashSettingsDocumentV2,
  hashSettingsStateV2
} from "./settings-v2-codec.js";
import {
  effectiveGenerationRuntime,
  effectiveApiKeyEnv,
  providerForProtocol
} from "./settings-v2-conversion.js";
import { providerRuntimeFromV2 } from "./provider-runtime.js";
import { defaultModelCapabilities } from "../shared/settings-provider-defaults.js";
import {
  isExactSettingsActivationSuccessor,
  recoveryEventForSettingsStateV2,
  reduceSettingsStateV2,
  SETTINGS_SAVE_ADMISSIBLE_RELATIONS,
  settingsStateRelation
} from "./settings-v2-reducer.js";
import {
  completeSettingsMutation,
  corruptSettingsStateReceipt,
  invalidSettingsMutation,
  parseDiscardPendingSettingsCommand,
  parseSaveSettingsCommandEnvelope,
  parseSaveSettingsConnectionSecrets,
  parseSaveSettingsDocument,
  prepareSettingsMutation,
  requireExactSettingsReceiptState,
  requireMatchingSettingsPrepared,
  requireSettingsPrepared,
  requireSettingsReceiptNotAhead,
  settingsCoordinatorAdmissionRequest,
  settingsCoordinatorRequest,
  settingsMutationFingerprint,
  type SettingsMutationOperation
} from "./settings-v2-mutation.js";
import {
  deleteProviderSecret,
  pruneProviderSecrets,
  readProviderSecrets,
  removeProviderSecretsScratch,
  writeProviderSecret
} from "./provider-secret-store.js";
import {
  activeSettingsDocument,
  assertRuntimeDocumentSupported,
  credentialReferencesResolve,
  defaultCandidateValidator,
  assertRuntimeGenerationSettingsSupported,
  pendingSettingsDocument,
  providerRequestTransportAvailable,
  settingsViewFromState
} from "./settings-v2-runtime.js";
import {
  discardStagedSettingsState,
  publishStagedSettingsState,
  readSettingsState,
  readSettingsStateFiles,
  stageSettingsState
} from "./settings-state-file.js";
import { requireFreshUnseenMutationId } from "./mutation-id-policy.js";
import { parseSettingsDocumentV2 } from "./settings-v2-codec.js";
import { storedCredentialSecretId } from "../shared/settings-stored-credential.js";

type Clock = () => Date;
export type SettingsActivationMode = "activation-capable" | "recover-only";

/** IDs minted by this project's sidecar: a crypto-UUID suffix that cannot
 * predate the mint-per-key change and cannot arise from another writer's
 * connection-derived or caller-selected naming. Only these ever qualify for
 * targeted supersession deletion in the shared machine tier. */
const MINTED_SECRET_ID_PATTERN =
  /\.k[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SettingsV2StoreOptions {
  readonly coordinator?: MutationCoordinator;
  readonly ledger?: MutationLedgerStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Clock;
  readonly validateCandidate?: (settings: GenerationSettings) => Promise<boolean>;
  readonly activationMode?: SettingsActivationMode;
  /** The machine tier. Absent means this directory is its own machine tier. */
  readonly secretsDir?: string;
}

/** Format-2 settings authority: admission, receipts, aggregate replacement,
 * bounded recovery, and activation all meet at this one boundary. A staged
 * save activates in-process inside the save request; init() activation is
 * crash recovery plus retry for a staged document an earlier run left behind. */
export class SettingsV2Store {
  private readonly coordinator: MutationCoordinator;
  private readonly ledger: MutationLedgerStore;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: Clock;
  private readonly validateCandidate: (settings: GenerationSettings) => Promise<boolean>;
  private readonly activationMode: SettingsActivationMode;
  private readonly secretsDir: string;
  private readonly prunesSecrets: boolean;

  constructor(
    private readonly dataDir: string,
    options: SettingsV2StoreOptions = {}
  ) {
    this.secretsDir = options.secretsDir ?? dataDir;
    // A shared machine tier holds every project's keys, and this store only
    // knows the IDs one project references. Pruning against that view would
    // delete another project's credentials, so garbage collection is confined
    // to the case where the secret store belongs to this directory alone.
    this.prunesSecrets = this.secretsDir === dataDir;
    this.coordinator = options.coordinator ?? createMutationCoordinator();
    this.ledger = options.ledger ?? new MutationLedgerStore(dataDir);
    this.environment = { ...(options.environment ?? process.env) };
    this.now = options.now ?? (() => new Date());
    this.validateCandidate = options.validateCandidate ?? defaultCandidateValidator;
    this.activationMode = options.activationMode ?? "activation-capable";
  }

  async init(): Promise<void> {
    await this.ledger.init();
    let state = await this.recoverReceiptTransaction();
    const preActivation = state;
    state = await this.recoverActivation(state);
    await this.deleteSupersededSecrets([preActivation], state);
    if (this.prunesSecrets) {
      await removeProviderSecretsScratch(this.secretsDir);
      await pruneProviderSecrets(this.secretsDir, storedSecretIdsInState(state));
    }
    assertRuntimeDocumentSupported(activeSettingsDocument(state));
    settingsViewFromState(state);
  }

  async loadView(): Promise<SettingsView> {
    return settingsViewFromState(await readSettingsState(this.dataDir));
  }

  async loadRuntime(purpose: SettingsRoutePurpose = "default") {
    const { state, storedSecrets } = await this.readRuntimeSnapshot();
    const runtime = effectiveGenerationRuntime(
      activeSettingsDocument(state),
      purpose,
      {},
      this.environment,
      {},
      storedSecrets
    );
    assertRuntimeGenerationSettingsSupported(runtime.settings);
    return runtime;
  }

  /** One coherent (state, secrets) pair. Secrets are written before the state
   * that references them is published, and pruned only after the state that
   * unreferences them is published — so the only torn pair a reader can see
   * is an old effective revision next to a secret file that already lost its
   * credential. Retrying that exact condition converges on the newer state. */
  private async readRuntimeSnapshot(): Promise<{
    readonly state: SettingsStateV2;
    readonly storedSecrets: Awaited<ReturnType<typeof readProviderSecrets>>;
  }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5));
      }
      const state = await readSettingsState(this.dataDir);
      const storedSecrets = await readProviderSecrets(this.secretsDir);
      const referenced = storedSecretIdsInDocument(activeSettingsDocument(state));
      if ([...referenced].every((secretId) => storedSecrets.has(secretId))) {
        return { state, storedSecrets };
      }
    }
    throw new ServiceError(
      503,
      "Settings changed repeatedly while reading provider credentials; retry."
    );
  }

  async loadEffective() {
    return (await this.loadRuntime()).settings;
  }

  async loadMatchingProviderRuntimes(
    settings: GenerationSettings
  ): Promise<readonly {
    readonly connectionId: string;
    readonly providerRuntime: ReturnType<typeof providerRuntimeFromV2>;
  }[]> {
    const { state, storedSecrets } = await this.readRuntimeSnapshot();
    const document = activeSettingsDocument(state);
    const exact: Array<{
      readonly connectionId: string;
      readonly providerRuntime: ReturnType<typeof providerRuntimeFromV2>;
    }> = [];
    const fallback: typeof exact = [];
    for (const [connectionId, connection] of Object.entries(document.connections)) {
      const provider = providerForProtocol(connection.protocol);
      if (
        provider !== settings.provider
        || (connection.baseUrl ?? "") !== settings.baseUrl
        || effectiveApiKeyEnv(connection) !== settings.apiKeyEnv
      ) continue;
      const models = Object.values(document.models).filter(
        (model) => model.connectionId === connectionId
      );
      const exactModel = models.find((candidate) =>
        candidate.remoteId === settings.model
      );
      const model = exactModel ?? models[0];
      const match = {
        connectionId,
        providerRuntime: providerRuntimeFromV2(
          connection,
          "default",
          model?.capabilities ?? defaultModelCapabilities(provider),
          this.environment,
          storedSecrets
        )
      };
      (exactModel === undefined ? fallback : exact).push(match);
    }
    return exact.length > 0 ? exact : fallback;
  }

  async loadProviderProbeTarget(
    documentValue: unknown,
    purpose: SettingsRoutePurpose
  ): Promise<GenerationSettings> {
    const document = parseSettingsDocumentV2(documentValue);
    const route = selectSettingsRoute(document, purpose);
    const connectionId = route.model.connectionId;
    const { state, storedSecrets } = await this.readRuntimeSnapshot();
    if (usesCredentialReferences(route.connection)) {
      const activeConnection =
        activeSettingsDocument(state).connections[connectionId];
      const activeTargetSaved = activeConnection !== undefined
        && sameActivatedCredentialTarget(activeConnection, route.connection);
      // A staged candidate only exists after its own durable save, so probing
      // its credential target is as legitimate as probing the active one —
      // and it is exactly what recovery from a failed activation needs.
      const pendingConnection = state.pendingRevision === null
        ? undefined
        : pendingSettingsDocument(state).connections[connectionId];
      const pendingTargetSaved = pendingConnection !== undefined
        && sameActivatedCredentialTarget(pendingConnection, route.connection);
      if (!activeTargetSaved && !pendingTargetSaved) {
        throw new ServiceError(
          409,
          "A new or changed credential target must be saved and activated before it can be tested.",
          "credential_test_requires_activation"
        );
      }
    }
    const runtime = effectiveGenerationRuntime(
      document,
      purpose,
      {},
      this.environment,
      { allowBlankModel: true },
      storedSecrets
    );
    assertRuntimeGenerationSettingsSupported(runtime.settings);
    return runtime.settings;
  }

  async inspectMutationReceipt(mutationId: string): Promise<{
    readonly state: "pending" | "completed";
    readonly method: "saveSettings" | "discardPendingSettings";
    readonly fingerprint: string;
  } | null> {
    const receipt = await this.ledger.loadUserReceipt("settings", mutationId);
    const prepared = receipt.prepared;
    if (prepared === null) return null;
    requireSettingsPrepared(prepared, mutationId);
    const method = prepared.method;
    if (method !== "saveSettings" && method !== "discardPendingSettings") {
      throw new Error("Settings receipt method was not narrowed");
    }
    return {
      state: receipt.completed === null ? "pending" : "completed",
      method,
      fingerprint: prepared.fingerprintHash
    };
  }

  async save(commandValue: unknown): Promise<SettingsMutationResult> {
    const command = parseSaveSettingsCommandEnvelope(commandValue);
    return await this.coordinator.runAfterSettingsAdmission(
      settingsCoordinatorAdmissionRequest(command),
      () => {
        try {
          const document = parseSaveSettingsDocument(commandValue);
          const operation: SettingsMutationOperation = {
            method: "saveSettings",
            document,
            connectionSecrets: parseSaveSettingsConnectionSecrets(commandValue)
          };
          return {
            fingerprint: settingsMutationFingerprint(
              operation,
              command.expectedStateGeneration
            ),
            payload: operation
          };
        } catch (error) {
          throw invalidSettingsMutation(error);
        }
      },
      async (request, operation) => await this.runMutation(operation, request)
    );
  }

  async discardPending(commandValue: unknown): Promise<SettingsMutationResult> {
    const command = parseDiscardPendingSettingsCommand(commandValue);
    const operation: SettingsMutationOperation = {
      method: "discardPendingSettings"
    };
    const fingerprint = settingsMutationFingerprint(
      operation,
      command.expectedStateGeneration
    );
    return await this.coordinator.runSettings(
      settingsCoordinatorRequest(command, fingerprint),
      async (request) => await this.runMutation(operation, request)
    );
  }

  private async runMutation(
    operation: SettingsMutationOperation,
    request: MutationCoordinatorRequest<SettingsMutationTarget>
  ): Promise<SettingsMutationResult> {
    const current = await this.recoverReceiptTransaction();
    const existing = await this.ledger.loadUserReceipt("settings", request.mutationId);
    if (existing.prepared === null && existing.completed === null) {
      requireFreshUnseenMutationId(
        request.mutationId,
        this.now().getTime()
      );
    }
    if (existing.prepared !== null) {
      const prepared = requireMatchingSettingsPrepared(
        existing.prepared,
        operation,
        request.mutationId,
        request.fingerprint
      );
      if (existing.completed === null) {
        if (prepared.oldStateHash !== hashSettingsStateV2(current)
          || pointsToUserMutation(current, request.mutationId)) {
          throw new ServiceError(
            409,
            "Settings mutation recovery is incomplete; retry after restarting the backend.",
            "mutation_outcome_unknown"
          );
        }
        await this.ledger.removeOrphanPreparedUserReceipt(
          "settings",
          request.mutationId,
          hashPreparedMutationRecord(prepared)
        );
      } else {
        requireSettingsReceiptNotAhead(prepared, current);
        return settingsResult(prepared, responseActivationOutcome(current, request.mutationId));
      }
    }

    if (operation.method === "saveSettings") {
      assertRuntimeDocumentSupported(operation.document);
    }
    if (current.stateGeneration !== request.expectedAggregateVersion.stateGeneration) {
      throw new ServiceError(
        409,
        "Settings changed since this edit began; reload before saving.",
        "revision_conflict"
      );
    }
    const relation = settingsStateRelation(current);
    // One spelling of save admission: the reducer owns the set, this layer
    // only maps inadmissible relations onto the transport's 409. A staged
    // save replaces the pending candidate, so a failed activation stays
    // directly editable instead of demanding an explicit discard first.
    if (
      operation.method === "saveSettings"
      && !SETTINGS_SAVE_ADMISSIBLE_RELATIONS.includes(relation)
    ) {
      throw new ServiceError(409, "Settings activation is incomplete; retry after restarting the backend.");
    }
    if (operation.method === "discardPendingSettings" && relation !== "staged") {
      throw new ServiceError(409, "There are no pending settings to discard.");
    }

    const connectionSecretEntries = operation.method === "saveSettings"
      ? Object.entries(operation.connectionSecrets ?? {})
      : [];
    if (operation.method === "saveSettings") {
      requireConnectionSecretsMatchDocument(
        operation.document,
        connectionSecretEntries
      );
      requireActiveSecretRebindingRekeyed(
        activeSettingsDocument(current),
        operation.document,
        connectionSecretEntries
      );
      // Clean state only: from staged, a save of the active document is the
      // discard-pending route below, and taking this shortcut instead would
      // leave the failed candidate silently pending.
      if (
        relation === "clean"
        && connectionSecretEntries.length > 0
        && hashSettingsDocumentV2(operation.document)
          === hashSettingsDocumentV2(activeSettingsDocument(current))
      ) {
        for (const [secretId, value] of connectionSecretEntries) {
          if (value !== null) await writeProviderSecret(this.secretsDir, secretId, value);
        }
        const prepared = prepareSettingsMutation(
          operation,
          request,
          current,
          current,
          this.timestamp()
        );
        await this.ledger.writeUserRecord(prepared);
        await this.pruneUnreferencedSecrets(current);
        await this.ledger.writeUserRecord(
          completeSettingsMutation(prepared, this.timestamp())
        );
        return settingsResult(prepared, responseActivationOutcome(current, request.mutationId));
      }
    }

    let next: SettingsStateV2;
    try {
      const pointer = {
        receiptKind: "user" as const,
        mutationId: request.mutationId,
        phase: "prepared" as const
      };
      next = operation.method === "saveSettings"
        ? reduceSettingsStateV2(current, {
            kind: "save-document",
            document: operation.document,
            lastTransaction: pointer
          })
        : reduceSettingsStateV2(current, {
            kind: "discard-pending",
            lastTransaction: pointer
          });
    } catch (error) {
      throw invalidSettingsMutation(error);
    }

    const prepared = prepareSettingsMutation(
      operation,
      request,
      current,
      next,
      this.timestamp()
    );
    await stageSettingsState(this.dataDir, next);
    // Replacement takes effect on save by design; a post-stage failure is recoverable by re-entering the key.
    for (const [secretId, value] of connectionSecretEntries) {
      if (value !== null) await writeProviderSecret(this.secretsDir, secretId, value);
    }
    try {
      await this.ledger.writeUserRecord(prepared);
    } catch (error) {
      await this.cleanupUncommitted(prepared).catch(() => undefined);
      throw error;
    }
    await publishStagedSettingsState(this.dataDir);
    await this.pruneUnreferencedSecrets(next);
    await this.ledger.writeUserRecord(completeSettingsMutation(prepared, this.timestamp()));
    // A credential-touching save activates in the same request: the same
    // sequence init() uses for crash recovery, still inside the coordinator's
    // settings scope. The durable receipt keeps its staging result; the
    // response and the view's lastActivationOutcome carry what happened next.
    // A validation failure keeps the candidate staged, so nothing is
    // discarded silently.
    let settled = next;
    if (
      operation.method === "saveSettings"
      && this.activationMode === "activation-capable"
      && settingsStateRelation(next) === "staged"
    ) {
      settled = await this.activateStaged(next);
      // A committed activation may drop the old revision; only now are its
      // replaced stored secrets unreferenced, so prune again.
      await this.pruneUnreferencedSecrets(settled);
    }
    await this.deleteSupersededSecrets([current, next], settled);
    return settingsResult(prepared, responseActivationOutcome(settled, request.mutationId));
  }

  /** Delete exactly the stored credentials this transition superseded. The
   * shared machine tier disables reference pruning — other projects'
   * references are invisible there — but an ID this transition replaced or
   * discarded was written by this project and is referenced by nothing after
   * it settles, so a targeted delete is safe where a scan is not. A failed
   * validation keeps every document and therefore deletes nothing.
   *
   * Deletion is gated on provable mint provenance: only IDs carrying the
   * sidecar's crypto-UUID suffix qualify, because they cannot predate the
   * mint-per-key change and cannot arise from another writer's derivation.
   * Legacy connection-derived IDs and caller-selected API IDs are never
   * deleted; they keep their pre-existing accumulate-forever behavior rather
   * than risk removing a name another project also resolves. One residual
   * remains: a project that adopts this project's minted ID by exact value
   * would lose it on rotation here — out of the threat model, availability
   * only, and self-healing by re-entering the key.
   *
   * Cleanup is deliberately not crash-recoverable. The unrecoverable window
   * runs from the durable commit to this call — milliseconds — and the
   * artifact is one superseded credential inside a 0600 machine-tier file;
   * before this change every rotation leaked its value there permanently,
   * so this is a strict improvement, and a persisted cleanup record would
   * cost settings-state schema churn that outweighs the residual. */
  private async deleteSupersededSecrets(
    preceding: readonly SettingsStateV2[],
    settled: SettingsStateV2
  ): Promise<void> {
    const remaining = storedSecretIdsInState(settled);
    const superseded = new Set<string>();
    for (const state of preceding) {
      for (const secretId of storedSecretIdsInState(state)) {
        if (!remaining.has(secretId) && MINTED_SECRET_ID_PATTERN.test(secretId)) {
          superseded.add(secretId);
        }
      }
    }
    for (const secretId of superseded) {
      await deleteProviderSecret(this.secretsDir, secretId);
    }
  }

  private async pruneUnreferencedSecrets(state: SettingsStateV2): Promise<void> {
    if (!this.prunesSecrets) return;
    await pruneProviderSecrets(this.secretsDir, storedSecretIdsInState(state));
  }

  /** Final is always authoritative. A valid reserved `.next` is either an
   * unpublished internal edge or a provable pre-state user transaction. */
  private async recoverReceiptTransaction(): Promise<SettingsStateV2> {
    let { current, next } = await readSettingsStateFiles(this.dataDir);
    if (next !== null) {
      await this.recoverUnpublishedNext(current, next);
      current = await readSettingsState(this.dataDir);
    }
    const pointer = current.lastTransaction;
    if (pointer === null) return current;
    if (pointer.receiptKind === "format-migration-v1") {
      const receipt = await this.ledger.loadFormatMigrationReceipt(pointer.key);
      if (receipt.prepared === null || receipt.completed === null
        || receipt.prepared.newStateHash !== hashSettingsStateV2(current)) {
        throw corruptSettingsStateReceipt("format migration");
      }
      return current;
    }

    const receipt = await this.ledger.loadUserReceipt("settings", pointer.mutationId);
    if (receipt.prepared === null) throw corruptSettingsStateReceipt(pointer.mutationId);
    requireSettingsPrepared(receipt.prepared, pointer.mutationId);
    if (receipt.completed === null) {
      requireExactSettingsReceiptState(receipt.prepared, current);
      await this.ledger.writeUserRecord(completeSettingsMutation(receipt.prepared, this.timestamp()));
    } else {
      requireSettingsReceiptNotAhead(receipt.prepared, current);
    }
    return current;
  }

  private async recoverUnpublishedNext(
    current: SettingsStateV2,
    next: SettingsStateV2
  ): Promise<void> {
    const pointer = next.lastTransaction;
    if (pointer === null) {
      if (next.stateGeneration !== 1) throw corruptSettingsStateReceipt("initial settings replacement");
      await discardStagedSettingsState(this.dataDir);
      return;
    }
    if (pointer.receiptKind === "format-migration-v1") {
      const receipt = await this.ledger.loadFormatMigrationReceipt(pointer.key);
      if (receipt.prepared === null || receipt.completed === null) {
        throw corruptSettingsStateReceipt(pointer.key);
      }
      if (receipt.prepared.newStateHash !== hashSettingsStateV2(next)
        || current.stateGeneration < next.stateGeneration) {
        throw corruptSettingsStateReceipt(pointer.key);
      }
      await discardStagedSettingsState(this.dataDir);
      return;
    }

    const receipt = await this.ledger.loadUserReceipt("settings", pointer.mutationId);
    if (receipt.prepared === null) {
      await discardStagedSettingsState(this.dataDir);
      return;
    }
    requireSettingsPrepared(receipt.prepared, pointer.mutationId);
    if (receipt.completed === null) {
      if (receipt.prepared.oldStateHash !== hashSettingsStateV2(current)
        || receipt.prepared.newStateHash !== hashSettingsStateV2(next)) {
        throw corruptSettingsStateReceipt(pointer.mutationId);
      }
      await this.ledger.removeOrphanPreparedUserReceipt(
        "settings",
        pointer.mutationId,
        hashPreparedMutationRecord(receipt.prepared)
      );
      await discardStagedSettingsState(this.dataDir);
      return;
    }
    requireSettingsReceiptNotAhead(receipt.prepared, current);
    const nextIsReceiptState = receipt.prepared.newStateHash === hashSettingsStateV2(next);
    if (!nextIsReceiptState && !isExactSettingsActivationSuccessor(current, next)) {
      throw corruptSettingsStateReceipt(pointer.mutationId);
    }
    await discardStagedSettingsState(this.dataDir);
  }

  private async cleanupUncommitted(prepared: PreparedUserMutationRecord): Promise<void> {
    const receipt = await this.ledger.loadUserReceipt("settings", prepared.key);
    if (receipt.prepared !== null && receipt.completed === null
      && hashPreparedMutationRecord(receipt.prepared) === hashPreparedMutationRecord(prepared)) {
      await this.ledger.removeOrphanPreparedUserReceipt(
        "settings",
        prepared.key,
        hashPreparedMutationRecord(prepared)
      );
    }
    await discardStagedSettingsState(this.dataDir);
  }

  private async recoverActivation(initial: SettingsStateV2): Promise<SettingsStateV2> {
    let state = initial;
    for (let edge = 0; edge < 6; edge += 1) {
      const relation = settingsStateRelation(state);
      if (relation === "clean") return state;
      if (relation === "staged") {
        return this.activationMode === "activation-capable"
          ? await this.activateStaged(state)
          : state;
      }
      const event = recoveryEventForSettingsStateV2(state);
      if (event === null) throw corruptSettingsStateReceipt("settings activation");
      state = await this.replaceInternal(reduceSettingsStateV2(state, event));
    }
    throw corruptSettingsStateReceipt("settings activation edge bound");
  }

  private async activateStaged(state: SettingsStateV2): Promise<SettingsStateV2> {
    const pointer = state.lastTransaction;
    if (pointer?.receiptKind !== "user") throw corruptSettingsStateReceipt("staged settings");
    let next = await this.replaceInternal(reduceSettingsStateV2(state, {
      kind: "begin-validation",
      transactionId: pointer.mutationId
    }));
    const candidate = pendingSettingsDocument(next);
    const storedSecrets = await readProviderSecrets(this.secretsDir);
    if (!credentialReferencesResolve(
      candidate,
      this.environment,
      new Set(storedSecrets.keys())
    )) {
      return await this.replaceInternal(reduceSettingsStateV2(next, {
        kind: "validation-failed",
        errorCode: "credential_unresolved"
      }));
    }
    let candidateReady = false;
    try {
      assertRuntimeDocumentSupported(candidate);
      const validatedConnections = new Set<string>();
      const probeTargets: GenerationSettings[] = [];
      for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
        const route = selectSettingsRoute(candidate, purpose);
        if (validatedConnections.has(route.model.connectionId)) continue;
        validatedConnections.add(route.model.connectionId);
        const effective = effectiveGenerationRuntime(
          candidate,
          purpose,
          {},
          this.environment,
          {},
          storedSecrets
        ).settings;
        if (providerRequestTransportAvailable(effective)) probeTargets.push(effective);
      }
      // Distinct connections validate concurrently, so the whole attempt is
      // bounded by one probe deadline rather than their sum — an activation
      // that runs inside a save request must settle well before the client's
      // own request deadline gives up on it.
      const results = await Promise.all(
        probeTargets.map((target) => this.validateCandidate(target))
      );
      candidateReady = results.every((ready) => ready);
    } catch {
      candidateReady = false;
    }
    if (!candidateReady) {
      return await this.replaceInternal(reduceSettingsStateV2(next, {
        kind: "validation-failed",
        errorCode: "candidate_invalid"
      }));
    }
    for (const kind of ["prepare", "promote", "commit", "finish-commit"] as const) {
      next = await this.replaceInternal(reduceSettingsStateV2(next, { kind }));
    }
    return next;
  }

  private async replaceInternal(state: SettingsStateV2): Promise<SettingsStateV2> {
    await stageSettingsState(this.dataDir, state);
    await publishStagedSettingsState(this.dataDir);
    return state;
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("Settings clock returned an invalid date");
    return value.toISOString();
  }
}

function usesCredentialReferences(
  connection: SettingsDocumentV2["connections"][string]
): boolean {
  return connection.auth.type !== "none" || connection.headers.length > 0;
}

function sameActivatedCredentialTarget(
  active: SettingsDocumentV2["connections"][string],
  candidate: SettingsDocumentV2["connections"][string]
): boolean {
  return active.protocol === candidate.protocol
    && active.baseUrl === candidate.baseUrl
    && JSON.stringify(active.auth) === JSON.stringify(candidate.auth)
    && JSON.stringify(active.headers) === JSON.stringify(candidate.headers);
}

function pointsToUserMutation(state: SettingsStateV2, mutationId: string): boolean {
  return state.lastTransaction?.receiptKind === "user"
    && state.lastTransaction.mutationId === mutationId;
}

function settingsResult(
  prepared: PreparedUserMutationRecord,
  activationOutcome: SettingsActivationOutcomeV2 | null
): SettingsMutationResult {
  if (prepared.result.kind !== "settings") {
    throw corruptSettingsStateReceipt(prepared.key);
  }
  return Object.freeze({ ...prepared.result, activationOutcome });
}

/** The response reports an activation attempt only when it belongs to this
 * mutation; the reducer nulls outcomes whose candidate was since replaced or
 * discarded, so a stale story can never ride a receipt replay. */
function responseActivationOutcome(
  state: SettingsStateV2,
  mutationId: string
): SettingsActivationOutcomeV2 | null {
  const outcome = state.lastActivationOutcome;
  return outcome !== null && outcome.transactionId === mutationId ? outcome : null;
}

function storedSecretIdsInDocument(document: SettingsDocumentV2): Set<string> {
  const ids = new Set<string>();
  for (const connection of Object.values(document.connections)) {
    if (
      connection.auth.type === "bearer-stored"
      || connection.auth.type === "header-stored"
    ) ids.add(connection.auth.secretId);
  }
  return ids;
}

function storedSecretIdsInState(state: SettingsStateV2): Set<string> {
  const ids = new Set<string>();
  for (const document of Object.values(state.documents)) {
    for (const secretId of storedSecretIdsInDocument(document)) ids.add(secretId);
  }
  return ids;
}

/** A stored secret ID binds one credential target to one value. While the
 * active document still resolves an ID, a save may overwrite its value only
 * for that same target — rotation in place. Rebinding it to a different
 * target would hand the new key to the old endpoint through every reader of
 * the still-active revision, including one racing this very save, and the
 * mismatched pairing would persist if the candidate then failed validation. */
function requireActiveSecretRebindingRekeyed(
  active: SettingsDocumentV2,
  submitted: SettingsDocumentV2,
  entries: readonly (readonly [string, string | null])[]
): void {
  for (const [secretId, value] of entries) {
    if (value === null) continue;
    const activeReferences = connectionsResolvingStoredSecret(active, secretId);
    if (activeReferences.length === 0) continue;
    const submittedReferences = connectionsResolvingStoredSecret(submitted, secretId);
    const rotationInPlace = activeReferences.every((reference) =>
      submittedReferences.some((candidate) =>
        sameActivatedCredentialTarget(reference, candidate)));
    if (!rotationInPlace) {
      throw new ServiceError(
        400,
        "A stored key for a changed credential target needs a new secret ID; the active settings still resolve this one.",
        "invalid_request"
      );
    }
  }
}

function connectionsResolvingStoredSecret(
  document: SettingsDocumentV2,
  secretId: string
): readonly SettingsDocumentV2["connections"][string][] {
  return Object.values(document.connections).filter(
    (connection) => storedCredentialSecretId(connection.auth) === secretId
  );
}

function requireConnectionSecretsMatchDocument(
  document: SettingsDocumentV2,
  entries: readonly (readonly [string, string | null])[]
): void {
  const referenced = storedSecretIdsInDocument(document);
  for (const [secretId, value] of entries) {
    if (
      (value === null && referenced.has(secretId))
      || (value !== null && !referenced.has(secretId))
    ) {
      throw new ServiceError(
        400,
        "Settings secret sidecar does not match the document credential references.",
        "invalid_request"
      );
    }
  }
}
