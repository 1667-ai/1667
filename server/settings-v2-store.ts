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
  readSettingsStateSlot,
  stageSettingsState
} from "./settings-state-file.js";
import {
  requireMutableSettingsStateSlot,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import { activeSettingsDocumentV4 } from "./settings-v4-state-validation.js";
import { requireFreshUnseenMutationId } from "./mutation-id-policy.js";
import { parseSettingsDocumentV2 } from "./settings-v2-codec.js";
import { storedCredentialSecretId } from "../shared/settings-stored-credential.js";
import { assertSavedSamplingBiasResolves } from "./settings-v2-save-bias-check.js";
import {
  createSubscriptionRuntime,
  providerSecretIdsToKeep,
  storedSecretIdsInDocument,
  storedSecretIdsInState
} from "./subscription-runtime.js";
import { readSettingsView } from "./settings-v2-view-read.js";
import {
  readSettingsRuntimeSnapshot,
  resolveSettingsRuntimeSnapshot,
  settingsRuntimeSnapshotActiveDocument,
  settingsRuntimeSnapshotPendingDocument
} from "./settings-runtime-snapshot.js";

type Clock = () => Date;
export type SettingsActivationMode = "activation-capable" | "recover-only";

/** Re-exported from the module that now owns the save-time bias check
 * (server/settings-v2-save-bias-check.ts, issue #282 review round 5, finding
 * 2) so existing callers keep importing it from the store. */
export { SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS } from "./settings-v2-save-bias-check.js";

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
  private readonly runtimeResolver: SettingsRuntimeResolver;

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
  }

  async init(): Promise<void> {
    await this.ledger.init();
    const slot = await readSettingsStateSlot(this.dataDir);
    // A successor-owned authority is not this build's to change, and that is
    // an ordinary startup state rather than a failure, so it is a branch here
    // rather than a caught throw. There is nothing of its own to recover,
    // activate, or prune. Opening proves the state parses and its active
    // document supports a route, exactly like the writable path below.
    if (slot.kind === "v3") {
      assertRuntimeDocumentSupported(activeSettingsDocument(slot.readOnlyView), this.runtimeResolver);
      settingsViewFromState(slot.readOnlyView);
      return;
    }
    if (slot.kind === "v4") {
      const document = activeSettingsDocumentV4(slot.state);
      for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
        this.runtimeResolver.resolveV4({ document, purpose });
      }
      return;
    }
    // Every authority that reaches here is schema 2: the branch above
    // already returned for a schema-3 one, and every write below stays
    // schema 2 too, so the pipeline is schema-2-typed throughout.
    let state = await this.recoverReceiptTransaction();
    const preActivation = state;
    state = await this.recoverActivation(state);
    await this.deleteSupersededSecrets([preActivation], state);
    if (this.prunesSecrets) {
      await removeProviderSecretsScratch(this.secretsDir);
      await pruneProviderSecrets(this.secretsDir, providerSecretIdsToKeep(state));
    }
    assertRuntimeDocumentSupported(activeSettingsDocument(state), this.runtimeResolver);
    settingsViewFromState(state);
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

  async loadProviderProbeTarget(
    documentValue: unknown,
    purpose: SettingsRoutePurpose,
    probeSecrets: Readonly<Record<string, string>> = {}
  ): Promise<GenerationSettings> {
    const document = parseSettingsDocumentV2(documentValue);
    const route = selectSettingsRoute(document, purpose);
    const connectionId = route.model.connectionId;
    const snapshot = await readSettingsRuntimeSnapshot(this.dataDir, this.secretsDir);
    const storedSecrets = snapshot.storedSecrets;
    // Probe-only key material. It is resolved for this request and never
    // published, so it is layered over the store rather than into it.
    const probeSecretId = storedCredentialSecretId(route.connection.auth);
    const suppliedProbeSecret = probeSecretId !== null
      && probeSecrets[probeSecretId] !== undefined
      && route.connection.headers.length === 0;
    const resolvedSecrets = suppliedProbeSecret
      ? new Map([...storedSecrets, [probeSecretId, probeSecrets[probeSecretId]!]])
      : storedSecrets;
    // A caller that supplies the key has proved possession of it, which is all
    // a probe tests. Requiring a save first would make the model list
    // unreachable until after the very step it exists to inform.
    if (!suppliedProbeSecret && usesCredentialReferences(route.connection)) {
      const activeDocument = settingsRuntimeSnapshotActiveDocument(snapshot);
      const activeConnection = activeDocument.connections[connectionId];
      const activeTargetSaved = activeConnection !== undefined
        && sameActivatedCredentialTarget(activeConnection, route.connection);
      // A staged candidate only exists after its own durable save, so probing
      // its credential target is as legitimate as probing the active one —
      // and it is exactly what recovery from a failed activation needs.
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
    const runtime = this.runtimeResolver.resolve({
      document,
      purpose,
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
      async (request, operation) => await this.runMutation(operation, request, signal)
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
    request: MutationCoordinatorRequest<SettingsMutationTarget>,
    signal?: AbortSignal
  ): Promise<SettingsMutationResult> {
    // Refuse before any write touches disk: a schema-3 authority requires a
    // successor release to change, so this check runs before the mutation
    // recovery below reads or writes anything.
    const slot = await readSettingsStateSlot(this.dataDir);
    requireMutableSettingsStateSlot(slot);
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
      assertRuntimeDocumentSupported(operation.document, this.runtimeResolver);
      await assertSavedSamplingBiasResolves(
        operation.document,
        this.runtimeResolver,
        signal
      );
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
      requireMintedSecretIntroduction(
        current,
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
    await pruneProviderSecrets(this.secretsDir, providerSecretIdsToKeep(state));
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
    if (nextSlot.kind === "v3" || nextSlot.kind === "v4") {
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

/** The minted namespace (`.k<uuid>` suffix) is reserved. A save may reference
 * a mint-shaped secret ID only when the current state's documents already
 * reference it — existing references, including a copied project's, keep
 * working — or when this same save stores the ID's key material, which is the
 * shape of a genuine sidecar mint. Referencing a foreign minted ID without
 * its material is refused, so a mint-shaped ID inside a project's documents
 * provably entered through a mint, which is what keeps targeted supersession
 * deletion in the shared tier safe. */
function requireMintedSecretIntroduction(
  current: SettingsStateV2,
  submitted: SettingsDocumentV2,
  entries: readonly (readonly [string, string | null])[]
): void {
  const known = storedSecretIdsInState(current);
  const supplied = new Set(
    entries.filter(([, value]) => value !== null).map(([secretId]) => secretId)
  );
  for (const secretId of storedSecretIdsInDocument(submitted)) {
    if (!MINTED_SECRET_ID_PATTERN.test(secretId)) continue;
    if (known.has(secretId) || supplied.has(secretId)) continue;
    throw new ServiceError(
      400,
      "A minted secret ID can only enter settings through the save that stores its key; store the key or reference an ID these settings already use.",
      "invalid_request"
    );
  }
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
