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
  hashSettingsStateV2
} from "./settings-v2-codec.js";
import {
  effectiveApiKeyEnv,
  providerForProtocol
} from "./settings-v2-conversion.js";
import {
  createSettingsRuntimeResolver,
  type SettingsRuntimeResolver
} from "./settings-runtime-resolver.js";
import type { ProviderRuntime } from "./provider-runtime.js";
import { defaultModelCapabilities } from "../shared/settings-provider-defaults.js";
import {
  isExactSettingsActivationSuccessor,
  recoveryEventForSettingsStateV2,
  reduceSettingsStateV2
} from "./settings-v2-reducer.js";
import { settingsStateRelation } from "./settings-state-validation.js";
import {
  completeSettingsMutation,
  corruptSettingsStateReceipt,
  invalidSettingsMutation,
  parseDiscardPendingSettingsCommand,
  parseSaveSettingsCommandEnvelope,
  parseSaveSettingsConnectionSecrets,
  requireExactSettingsReceiptState,
  requireSettingsPrepared,
  requireSettingsReceiptNotAhead,
  settingsCoordinatorAdmissionRequest,
  settingsCoordinatorRequest
} from "./settings-v2-mutation.js";
import {
  pruneProviderSecrets,
  readProviderSecrets,
  removeProviderSecretsScratch
} from "./provider-secret-store.js";
import {
  assertRuntimeDocumentSupported,
  credentialReferencesResolve,
  defaultCandidateValidator,
  assertRuntimeGenerationSettingsSupported,
  pendingSettingsDocument,
  providerRequestTransportAvailable
} from "./settings-v2-runtime.js";
import {
  discardStagedSettingsState,
  publishStagedSettingsState,
  readSettingsState,
  readSettingsStateFiles,
  readSettingsStateSlot,
  stageSettingsState
} from "./settings-state-file.js";
import {
  requireSettingsStateSlotWriteAdmission,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import { activeSettingsDocumentV5 } from "./settings-v5-state-validation.js";
import { settingsStateRelationV3 } from "./settings-v3-state-validation.js";
import { settingsStateRelationV4 } from "./settings-v4-state-validation.js";
import { requireFreshUnseenMutationId } from "./mutation-id-policy.js";
import { storedCredentialSecretId } from "../shared/settings-stored-credential.js";
import type { SettingsStateV5 } from "../shared/settings-v5-types.js";
import type { ProviderProbeRouteV1 } from "../shared/provider-probe-route-v1.js";
import { settingsDocumentFromProviderProbeRoute } from "./provider-probe-route.js";
import { assertSavedSamplingBiasResolves } from "./settings-v2-save-bias-check.js";
import {
  createSubscriptionRuntime,
  providerSecretIdsToKeep,
  storedSecretIdsInState
} from "./subscription-runtime.js";
import { readSettingsView } from "./settings-v2-view-read.js";
import {
  readSettingsRuntimeSnapshot,
  resolveSettingsRuntimeSnapshot,
  settingsRuntimeSnapshotActiveDocument,
  settingsRuntimeSnapshotPendingDocument
} from "./settings-runtime-snapshot.js";
import type { SettingsActivationMode, SettingsSaveHooks } from "./settings-save-hooks.js";
import {
  convertSettingsStateSlotToV5,
  hashSettingsStateSlot,
  readSettingsStateAuthority,
  sourceSchemaVersionOf,
  stageSettingsStateBytes,
  stageSettingsStateV5
} from "./settings-state-authority.js";
import {
  activateStagedV5,
  commitSettingsSaveV5,
  type SettingsV5SaveContext
} from "./settings-v5-store-save.js";
import {
  parseSaveSettingsDocumentV5,
  requireExactSettingsReceiptStateV5,
  requireMatchingSettingsPreparedV5,
  requireSettingsReceiptNotAheadV5,
  settingsMutationFingerprintV5,
  type SettingsMutationOperationV5
} from "./settings-v5-mutation.js";
import { hashSettingsStateV5 } from "./settings-v5-codec.js";
import { reduceSettingsStateV5, recoveryEventForSettingsStateV5 } from "./settings-v5-reducer.js";
import { reduceSettingsStateV3, recoveryEventForSettingsStateV3 } from "./settings-v3-reducer.js";
import { reduceSettingsStateV4, recoveryEventForSettingsStateV4 } from "./settings-v4-reducer.js";
import { formatSettingsStateV3 } from "./settings-v3-codec.js";
import { formatSettingsStateV4Bytes } from "./settings-v4-codec.js";
import { assertRuntimeDocumentSupportedV5, settingsViewFromSlot } from "./settings-v5-runtime.js";
import {
  unmatchedSchema5NextError,
  hashSettingsSchema5UpgradePrepared,
  readSettingsSchema5UpgradePrepared,
  readSettingsSchema5UpgradeCompleted,
  removeSettingsSchema5UpgradeReceipts
} from "./settings-schema5-upgrade.js";
import {
  readSettingsPendingSecretsV1,
  removeSettingsPendingSecretsV1
} from "./settings-pending-secrets.js";
import { deleteProviderSecret } from "./provider-secret-store.js";
import { isMintedSecretId } from "./settings-secret-ids.js";
import {
  usesCredentialReferences,
  sameActivatedCredentialTarget
} from "./settings-secret-guards.js";


type Clock = () => Date;
export type { SettingsActivationMode } from "./settings-save-hooks.js";

/** Re-exported from the module that now owns the save-time bias check
 * (server/settings-v2-save-bias-check.ts, issue #282 review round 5, finding
 * 2) so existing callers keep importing it from the store. */
export { SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS } from "./settings-v2-save-bias-check.js";

/** IDs minted by this project's sidecar: a crypto-UUID suffix that cannot
 * predate the mint-per-key change and cannot arise from another writer's
 * connection-derived or caller-selected naming. Only these ever qualify for
 * targeted supersession deletion in the shared machine tier. */
export interface SettingsV2StoreOptions {
  readonly coordinator?: MutationCoordinator;
  readonly ledger?: MutationLedgerStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Clock;
  readonly validateCandidate?: (settings: GenerationSettings) => Promise<boolean>;
  readonly activationMode?: SettingsActivationMode;
  /** The machine tier. Absent means this directory is its own machine tier. */
  readonly secretsDir?: string;
  readonly saveHooks?: SettingsSaveHooks;
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
  private readonly runtimeResolver: SettingsRuntimeResolver;
  private readonly saveHooks: SettingsSaveHooks | undefined;

  constructor(
    private readonly dataDir: string,
    options: SettingsV2StoreOptions = {}
  ) {
    this.secretsDir = options.secretsDir ?? dataDir;
    this.environment = { ...(options.environment ?? process.env) };
    this.runtimeResolver = createSettingsRuntimeResolver({
      environment: this.environment,
      subscription: createSubscriptionRuntime(this.secretsDir)
    });
    // A shared machine tier holds every project's keys, and this store only
    // knows the IDs one project references. Pruning against that view would
    // delete another project's credentials, so garbage collection is confined
    // to the case where the secret store belongs to this directory alone.
    this.prunesSecrets = this.secretsDir === dataDir;
    this.coordinator = options.coordinator ?? createMutationCoordinator();
    this.ledger = options.ledger ?? new MutationLedgerStore(dataDir);
    this.now = options.now ?? (() => new Date());
    this.validateCandidate = options.validateCandidate ?? defaultCandidateValidator;
    this.activationMode = options.activationMode ?? "activation-capable";
    this.saveHooks = options.saveHooks;
  }

  async init(): Promise<void> {
    await this.ledger.init();
    await this.recoverAuthority();
    const slot = await readSettingsStateSlot(this.dataDir);
    const working = convertSettingsStateSlotToV5(slot);
    assertRuntimeDocumentSupportedV5(activeSettingsDocumentV5(working), this.runtimeResolver);
    settingsViewFromSlot(slot, this.runtimeResolver);
  }

  loadView(): Promise<SettingsView> {
    return readSettingsView(
      this.dataDir,
      this.runtimeResolver.credentials,
      this.runtimeResolver
    );
  }

  /** The route's runtime settings AND its stored image-input override,
   *  `imageInput`/`imageTokenCeiling`, read from the exact same snapshot
   *  (`readSettingsRuntimeSnapshot`): one disk read of the settings-state slot,
   *  resolved to one route. Earlier this shipped as two public methods,
   *  `loadRuntime` and `loadImageInputCapability`, each opening the state
   *  file on its own. A caller running them concurrently (`generation-http.ts`
   *  once did, via `Promise.all`) could have a settings save land between the
   *  two reads, pairing one route's provider settings with a DIFFERENT
   *  route's stored capability — a mismatch that can wrongly authorize an
   *  image under the wrong provider settings, or wrongly refuse a valid one.
   *  Folding both into this one method makes that pairing impossible rather
   *  than merely unlikely: there is only one read to race with, and both
   *  values fall out of it.
   *
   *  `imageInputCapability` is `null` when this directory has no successor
   *  image-input override for this model (a `"v2"` authority, or a model the
   *  effective schema-3/schema-4 document does not carry). `null` and
   *  `resolveImageInputCapability`'s (shared/image-input-capabilities.ts) own
   *  no-override default agree, so a caller passes it straight through as
   *  `ImageInputContext.override`/`overrideTokenCeiling` with no translation. */
  async loadRuntime(purpose: SettingsRoutePurpose = "default") {
    const snapshot = await readSettingsRuntimeSnapshot(this.dataDir, this.secretsDir);
    return resolveSettingsRuntimeSnapshot(snapshot, this.runtimeResolver, purpose);
  }

  async loadEffective() {
    return (await this.loadRuntime()).settings;
  }

  async loadMatchingProviderRuntimes(
    settings: GenerationSettings
  ): Promise<readonly {
    readonly connectionId: string;
    readonly providerRuntime: ProviderRuntime;
  }[]> {
    const snapshot = await readSettingsRuntimeSnapshot(this.dataDir, this.secretsDir);
    const storedSecrets = snapshot.storedSecrets;
    const document = settingsRuntimeSnapshotActiveDocument(snapshot);
    const exact: Array<{
      readonly connectionId: string;
      readonly providerRuntime: ProviderRuntime;
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
        providerRuntime: this.runtimeResolver.resolveConnection({
          connection,
          effort: "default",
          capabilities: model?.capabilities ?? defaultModelCapabilities(provider),
          storedSecrets
        })
      };
      (exactModel === undefined ? fallback : exact).push(match);
    }
    return exact.length > 0 ? exact : fallback;
  }

  async loadProviderProbeRoute(
    route: ProviderProbeRouteV1
  ): Promise<GenerationSettings> {
    const document = settingsDocumentFromProviderProbeRoute(route);
    const connectionId = route.model.connectionId;
    const snapshot = await readSettingsRuntimeSnapshot(this.dataDir, this.secretsDir);
    const storedSecrets = snapshot.storedSecrets;
    const probeSecrets = route.secrets ?? {};
    const probeSecretId = storedCredentialSecretId(route.connection.auth);
    const suppliedProbeSecret = probeSecretId !== null
      && probeSecrets[probeSecretId] !== undefined
      && route.connection.headers.length === 0;
    const resolvedSecrets = suppliedProbeSecret
      ? new Map([...storedSecrets, [probeSecretId, probeSecrets[probeSecretId]!]])
      : storedSecrets;
    if (!suppliedProbeSecret && usesCredentialReferences(route.connection)) {
      const activeDocument = settingsRuntimeSnapshotActiveDocument(snapshot);
      const activeConnection = activeDocument.connections[connectionId];
      const activeTargetSaved = activeConnection !== undefined
        && sameActivatedCredentialTarget(activeConnection, route.connection);
      const pendingConnection = settingsRuntimeSnapshotPendingDocument(snapshot)
        ?.connections[connectionId];
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
    const runtime = this.runtimeResolver.resolveV5({
      document,
      purpose: "default",
      allowBlankModel: true,
      storedSecrets: resolvedSecrets
    });
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

  /** `signal` is the caller's own abort signal (threaded from the HTTP
   * request, issue #282 review round 3, finding 3) — folded into the
   * llama-cpp bias-resolution probe's deadline in `runMutation` below, so a
   * client that has already given up frees this save's mutation slot
   * instead of the probe outliving it. */
  async save(commandValue: unknown, signal?: AbortSignal): Promise<SettingsMutationResult> {
    const command = parseSaveSettingsCommandEnvelope(commandValue);
    return await this.coordinator.runAfterSettingsAdmission(
      settingsCoordinatorAdmissionRequest(command),
      () => {
        try {
          const document = parseSaveSettingsDocumentV5(commandValue);
          const operation: SettingsMutationOperationV5 = {
            method: "saveSettings",
            document,
            connectionSecrets: parseSaveSettingsConnectionSecrets(commandValue)
          };
          return {
            fingerprint: settingsMutationFingerprintV5(
              operation,
              command.expectedStateGeneration
            ),
            payload: operation
          };
        } catch (error) {
          throw invalidSettingsMutation(error);
        }
      },
      async (request, operation) => await this.runMutation(operation, request, signal)
    );
  }

  async discardPending(commandValue: unknown): Promise<SettingsMutationResult> {
    const command = parseDiscardPendingSettingsCommand(commandValue);
    const operation: SettingsMutationOperationV5 = {
      method: "discardPendingSettings"
    };
    const fingerprint = settingsMutationFingerprintV5(
      operation,
      command.expectedStateGeneration
    );
    return await this.coordinator.runSettings(
      settingsCoordinatorRequest(command, fingerprint),
      async (request) => await this.runMutation(operation, request)
    );
  }

  private async runMutation(
    operation: SettingsMutationOperationV5,
    request: MutationCoordinatorRequest<SettingsMutationTarget>,
    signal?: AbortSignal
  ): Promise<SettingsMutationResult> {
    await this.recoverDurableState();
    let slot = await readSettingsStateSlot(this.dataDir);
    let sourceRecoveryGeneration: number | null = null;
    if (slot.kind === "v3" || slot.kind === "v4") {
      const relation = slot.kind === "v3"
        ? settingsStateRelationV3(slot.state)
        : settingsStateRelationV4(slot.state);
      if (relation !== "clean" && relation !== "staged") {
        sourceRecoveryGeneration = slot.state.stateGeneration;
        await this.recoverSourceActivation(slot);
        slot = await readSettingsStateSlot(this.dataDir);
      }
    }
    requireSettingsStateSlotWriteAdmission(slot);
    const currentV5 = convertSettingsStateSlotToV5(slot);
    const existing = await this.ledger.loadUserReceipt("settings", request.mutationId);
    if (existing.prepared === null && existing.completed === null) {
      requireFreshUnseenMutationId(
        request.mutationId,
        this.now().getTime()
      );
    }
    if (existing.prepared !== null) {
      const prepared = requireMatchingSettingsPreparedV5(
        existing.prepared,
        operation,
        request.mutationId,
        request.fingerprint
      );
      if (existing.completed === null) {
        if (prepared.oldStateHash !== hashSettingsStateSlot(slot)
          || pointsToUserMutationV5(currentV5, request.mutationId)) {
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
        requireSettingsReceiptNotAheadV5(prepared, currentV5);
        return settingsResult(prepared, responseActivationOutcomeV5(currentV5, request.mutationId));
      }
    }

    if (operation.method === "saveSettings") {
      assertRuntimeDocumentSupportedV5(operation.document, this.runtimeResolver);
      await assertSavedSamplingBiasResolves(
        operation.document,
        this.runtimeResolver,
        signal
      );
    }
    if (
      currentV5.stateGeneration !== request.expectedAggregateVersion.stateGeneration
      && sourceRecoveryGeneration !== request.expectedAggregateVersion.stateGeneration
    ) {
      throw new ServiceError(
        409,
        "Settings changed since this edit began; reload before saving.",
        "revision_conflict"
      );
    }
    const relation = settingsStateRelation(currentV5);
    if (operation.method === "discardPendingSettings" && relation !== "staged") {
      throw new ServiceError(409, "There are no pending settings to discard.");
    }

    const ctx = this.saveContext();
    try {
      const { prepared, settled } = await commitSettingsSaveV5(
        ctx,
        operation,
        request,
        slot,
        currentV5
      );
      return settingsResult(prepared, responseActivationOutcomeV5(settled, request.mutationId));
    } catch (error) {
      throw invalidSettingsMutation(error);
    }
  }

  private saveContext(): SettingsV5SaveContext {
    return {
      dataDir: this.dataDir,
      secretsDir: this.secretsDir,
      prunesSecrets: this.prunesSecrets,
      ledger: this.ledger,
      environment: this.environment,
      runtimeResolver: this.runtimeResolver,
      validateCandidate: this.validateCandidate,
      activationMode: this.activationMode,
      now: this.now,
      hooks: this.saveHooks
    };
  }

  private async recoverDurableState(): Promise<void> {
    const { current, next } = await readSettingsStateAuthority(this.dataDir);
    if (next !== null) {
      await this.recoverUnpublishedNextSlot(current, next);
    }
    const slot = await readSettingsStateSlot(this.dataDir);
    if (slot.kind === "v5") {
      await this.recoverSchema5Receipt(slot);
      await this.recoverPendingSecretsWhileSourceAuthoritative(slot);
      return;
    }
    if (slot.kind === "v2") {
      await this.recoverReceiptTransaction();
      await this.recoverPendingSecretsWhileSourceAuthoritative(slot);
      return;
    }
    await this.recoverPendingSecretsWhileSourceAuthoritative(slot);
  }

  private async recoverAuthority(): Promise<void> {
    await this.recoverDurableState();
    const slot = await readSettingsStateSlot(this.dataDir);
    if (slot.kind === "v5") {
      const recovered = convertSettingsStateSlotToV5(slot);
      const settled = await this.recoverActivationV5(recovered);
      await this.deleteSupersededSecrets([recovered], settled);
      await this.recoverPendingSecretsAfterPublish(slot, settled);
      if (this.prunesSecrets) {
        await pruneProviderSecrets(this.secretsDir, providerSecretIdsToKeep(settled));
      }
      return;
    }
    if (slot.kind === "v2") {
      const preActivation = await readSettingsState(this.dataDir);
      const state = await this.recoverActivation(preActivation);
      await this.deleteSupersededSecrets([preActivation], state);
      if (this.prunesSecrets) {
        await removeProviderSecretsScratch(this.secretsDir);
        await pruneProviderSecrets(this.secretsDir, providerSecretIdsToKeep(state));
      }
      return;
    }
    // Source-schema state is read-only during startup. Complete any source
    // activation as part of the first save, immediately before conversion,
    // so opening a successor-owned file never changes its bytes.
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
   * remains: project-tier state copied by hand shares its minted IDs, so a
   * rotation in the minting project deletes a credential the copy still
   * references, and the copy's generations fail with an unresolved
   * credential until its user re-enters the key. That trade is accepted —
   * manual-copy-only, availability-only, self-healing — because the
   * alternative of never deleting would permanently accumulate plaintext
   * keys for every user on every rotation (issue #90 tracks the durable
   * ownership design).
   *
   * Cleanup is deliberately not crash-recoverable. The unrecoverable window
   * runs from the durable commit to this call — milliseconds — and the
   * artifact is one superseded credential inside a 0600 machine-tier file;
   * before this change every rotation leaked its value there permanently,
   * so this is a strict improvement, and a persisted cleanup record would
   * cost settings-state schema churn that outweighs the residual. */
  private async deleteSupersededSecrets(
    preceding: readonly { readonly documents: Readonly<Record<string, { readonly connections: SettingsDocumentV2["connections"] }>> }[],
    settled: { readonly documents: Readonly<Record<string, { readonly connections: SettingsDocumentV2["connections"] }>> }
  ): Promise<void> {
    const remaining = storedSecretIdsInState(settled);
    const superseded = new Set<string>();
    for (const state of preceding) {
      for (const secretId of storedSecretIdsInState(state)) {
        if (!remaining.has(secretId) && isMintedSecretId(secretId)) {
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
    await pruneProviderSecrets(this.secretsDir, providerSecretIdsToKeep(state));
  }

  private async recoverUnpublishedNextSlot(
    current: SettingsStateSlot,
    next: SettingsStateSlot
  ): Promise<void> {
    if (next.kind === "v5") {
      const prepared = await readSettingsSchema5UpgradePrepared(this.dataDir);
      const userPointer = next.state.lastTransaction;
      if (userPointer?.receiptKind !== "user") {
        throw unmatchedSchema5NextError();
      }
      const receipt = await this.ledger.loadUserReceipt("settings", userPointer.mutationId);
      if (receipt.prepared === null) {
        throw unmatchedSchema5NextError();
      }
      if (receipt.prepared.newStateHash !== hashSettingsStateV5(next.state)) {
        throw unmatchedSchema5NextError();
      }
      if (current.kind !== "v5") {
        if (
          prepared === null
          || prepared.mutationId !== userPointer.mutationId
          || prepared.sourceStateHash !== hashSettingsStateSlot(current)
          || prepared.candidateStateHash !== hashSettingsStateV5(next.state)
        ) {
          throw unmatchedSchema5NextError();
        }
      }
      const stored = await readProviderSecrets(this.secretsDir);
      for (const secretId of storedSecretIdsInState(next.state)) {
        if (!stored.has(secretId)) return;
      }
      await publishStagedSettingsState(this.dataDir);
      return;
    }
    if (current.kind === "v2") {
      await this.recoverUnpublishedNext(current.state, next);
    }
  }

  private async recoverSchema5Receipt(slot: Extract<SettingsStateSlot, { kind: "v5" }>): Promise<void> {
    const pointer = slot.state.lastTransaction;
    const upgradePrepared = await readSettingsSchema5UpgradePrepared(this.dataDir);
    const upgradeCompleted = await readSettingsSchema5UpgradeCompleted(this.dataDir);
    if (pointer === null || pointer.receiptKind !== "user") {
      if (upgradePrepared !== null || upgradeCompleted !== null) {
        throw corruptSettingsStateReceipt("schema-5 upgrade");
      }
      return;
    }
    const receipt = await this.ledger.loadUserReceipt("settings", pointer.mutationId);
    if (receipt.prepared === null) throw corruptSettingsStateReceipt(pointer.mutationId);
    requireSettingsPrepared(receipt.prepared, pointer.mutationId);
    if (upgradePrepared !== null || upgradeCompleted !== null) {
      if (
        upgradePrepared === null
        || upgradePrepared.mutationId !== pointer.mutationId
        || upgradePrepared.candidateStateHash !== receipt.prepared.newStateHash
        || (upgradeCompleted !== null
          && upgradeCompleted.preparedRecordHash !== hashSettingsSchema5UpgradePrepared(upgradePrepared))
      ) {
        throw corruptSettingsStateReceipt("schema-5 upgrade");
      }
    }
    if (receipt.completed === null) {
      requireExactSettingsReceiptStateV5(receipt.prepared, slot.state);
      await this.ledger.writeUserRecord(completeSettingsMutation(receipt.prepared, this.timestamp()));
    } else {
      requireSettingsReceiptNotAheadV5(receipt.prepared, slot.state);
    }
    if (upgradePrepared !== null) {
      await removeSettingsSchema5UpgradeReceipts(this.dataDir);
    }
  }

  private async recoverSourceActivation(
    slot: Extract<SettingsStateSlot, { kind: "v3" } | { kind: "v4" }>
  ): Promise<void> {
    if (slot.kind === "v3") {
      let state = slot.state;
      for (let edge = 0; edge < 6; edge += 1) {
        const relation = settingsStateRelation(state);
        if (relation === "clean" || relation === "staged") return;
        const event = recoveryEventForSettingsStateV3(state);
        if (event === null) throw corruptSettingsStateReceipt("settings activation");
        state = reduceSettingsStateV3(state, event);
        await stageSettingsStateBytes(this.dataDir, Buffer.from(formatSettingsStateV3(state), "utf8"));
        await publishStagedSettingsState(this.dataDir);
      }
      throw corruptSettingsStateReceipt("settings activation edge bound");
    }
    let state = slot.state;
    for (let edge = 0; edge < 6; edge += 1) {
      const relation = settingsStateRelation(state);
      if (relation === "clean" || relation === "staged") return;
      const event = recoveryEventForSettingsStateV4(state);
      if (event === null) throw corruptSettingsStateReceipt("settings activation");
      state = reduceSettingsStateV4(state, event);
      await stageSettingsStateBytes(this.dataDir, formatSettingsStateV4Bytes(state));
      await publishStagedSettingsState(this.dataDir);
    }
    throw corruptSettingsStateReceipt("settings activation edge bound");
  }

  private async recoverActivationV5(initial: SettingsStateV5): Promise<SettingsStateV5> {
    let state = initial;
    for (let edge = 0; edge < 6; edge += 1) {
      const relation = settingsStateRelation(state);
      if (relation === "clean") return state;
      if (relation === "staged") {
        return this.activationMode === "activation-capable"
          ? await activateStagedV5(this.saveContext(), state)
          : state;
      }
      const event = recoveryEventForSettingsStateV5(state);
      if (event === null) throw corruptSettingsStateReceipt("settings activation");
      state = reduceSettingsStateV5(state, event);
      await stageSettingsStateV5(this.dataDir, state);
      await publishStagedSettingsState(this.dataDir);
    }
    throw corruptSettingsStateReceipt("settings activation edge bound");
  }

  private async recoverPendingSecretsWhileSourceAuthoritative(
    slot: SettingsStateSlot
  ): Promise<void> {
    const ownership = await readSettingsPendingSecretsV1(this.dataDir);
    if (ownership === null) {
      await this.recoverSchema5UpgradeWhileSourceAuthoritative(slot);
      return;
    }
    if (ownership.sourceStateHash !== hashSettingsStateSlot(slot)) return;
    for (const secretId of ownership.mintedSecretIds) {
      await deleteProviderSecret(this.secretsDir, secretId);
    }
    const receipt = await this.ledger.loadUserReceipt("settings", ownership.mutationId);
    if (receipt.prepared !== null && receipt.completed === null) {
      await this.ledger.removeOrphanPreparedUserReceipt(
        "settings",
        ownership.mutationId,
        hashPreparedMutationRecord(receipt.prepared)
      );
    }
    const upgrade = await readSettingsSchema5UpgradePrepared(this.dataDir);
    if (upgrade !== null && upgrade.mutationId === ownership.mutationId) {
      await removeSettingsSchema5UpgradeReceipts(this.dataDir);
    }
    await removeSettingsPendingSecretsV1(this.dataDir);
    await this.recoverSchema5UpgradeWhileSourceAuthoritative(slot);
  }

  /** Remove an upgrade receipt after a crash that left the source schema
   * authoritative. This path also covers saves that introduced no new
   * provider secret, so they have no pending-secret ownership record to drive
   * cleanup. */
  private async recoverSchema5UpgradeWhileSourceAuthoritative(
    slot: SettingsStateSlot
  ): Promise<void> {
    if (slot.kind === "v5") return;
    const prepared = await readSettingsSchema5UpgradePrepared(this.dataDir);
    const completed = await readSettingsSchema5UpgradeCompleted(this.dataDir);
    if (prepared === null && completed === null) return;
    if (
      prepared === null
      || completed !== null
      || prepared.sourceSchemaVersion !== sourceSchemaVersionOf(slot)
      || prepared.sourceStateHash !== hashSettingsStateSlot(slot)
    ) {
      throw corruptSettingsStateReceipt("schema-5 upgrade");
    }
    const receipt = await this.ledger.loadUserReceipt("settings", prepared.mutationId);
    if (receipt.prepared === null) {
      await removeSettingsSchema5UpgradeReceipts(this.dataDir);
      return;
    }
    requireSettingsPrepared(receipt.prepared, prepared.mutationId);
    if (
      receipt.completed !== null
      || receipt.prepared.newStateHash !== prepared.candidateStateHash
    ) {
      throw corruptSettingsStateReceipt(prepared.mutationId);
    }
    await this.ledger.removeOrphanPreparedUserReceipt(
      "settings",
      prepared.mutationId,
      hashPreparedMutationRecord(receipt.prepared)
    );
    await removeSettingsSchema5UpgradeReceipts(this.dataDir);
  }

  private async recoverPendingSecretsAfterPublish(
    previous: SettingsStateSlot,
    settled: SettingsStateV5
  ): Promise<void> {
    const ownership = await readSettingsPendingSecretsV1(this.dataDir);
    if (ownership === null) return;
    const publishedCandidate = previous.kind === "v5"
      && ownership.candidateHash === hashSettingsStateV5(previous.state)
      && previous.state.lastTransaction?.receiptKind === "user"
      && previous.state.lastTransaction.mutationId === ownership.mutationId;
    const settledMutation = settled.lastTransaction?.receiptKind === "user"
      && settled.lastTransaction.mutationId === ownership.mutationId;
    if (!publishedCandidate && !settledMutation) return;
    const remaining = storedSecretIdsInState(settled);
    for (const secretId of storedSecretIdsInState(
      previous.kind === "v5" ? previous.state : convertSettingsStateSlotToV5(previous)
    )) {
      if (!remaining.has(secretId) && isMintedSecretId(secretId)) {
        await deleteProviderSecret(this.secretsDir, secretId);
      }
    }
    for (const secretId of ownership.mintedSecretIds) {
      if (!remaining.has(secretId)) {
        await deleteProviderSecret(this.secretsDir, secretId);
      }
    }
    await removeSettingsPendingSecretsV1(this.dataDir);
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
    nextSlot: SettingsStateSlot
  ): Promise<void> {
    // A later release staged this candidate and crashed before publishing:
    // `current` is confirmed schema 2 here, so it never took effect. Discard
    // it unchecked, like every other provably unpublished `.next` below.
    if (nextSlot.kind === "v3" || nextSlot.kind === "v4" || nextSlot.kind === "v5") {
      await discardStagedSettingsState(this.dataDir);
      return;
    }
    const next = nextSlot.state;
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
      assertRuntimeDocumentSupported(candidate, this.runtimeResolver);
      const validatedConnections = new Set<string>();
      const probeTargets: GenerationSettings[] = [];
      for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
        const route = selectSettingsRoute(candidate, purpose);
        if (validatedConnections.has(route.model.connectionId)) continue;
        validatedConnections.add(route.model.connectionId);
        const effective = this.runtimeResolver.resolve({
          document: candidate,
          purpose,
          storedSecrets
        }).settings;
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

function pointsToUserMutationV5(state: SettingsStateV5, mutationId: string): boolean {
  return state.lastTransaction?.receiptKind === "user"
    && state.lastTransaction.mutationId === mutationId;
}

function responseActivationOutcomeV5(
  state: SettingsStateV5,
  mutationId: string
): SettingsActivationOutcomeV2 | null {
  const outcome = state.lastActivationOutcome;
  return outcome !== null && outcome.transactionId === mutationId ? outcome : null;
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
