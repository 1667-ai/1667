import type { MutationCoordinatorRequest, SettingsMutationTarget } from "./mutation-coordinator.js";
import { hashPreparedMutationRecord } from "./mutation-ledger-codec.js";
import type { MutationLedgerStore } from "./mutation-ledger-store.js";
import type { PreparedUserMutationRecord } from "./mutation-ledger-types.js";
import {
  deleteProviderSecret,
  pruneProviderSecrets,
  readProviderSecrets,
  writeProviderSecret
} from "./provider-secret-store.js";
import { isMintedSecretId } from "./settings-secret-ids.js";
import {
  newlyMintedSecretIds,
  requireActiveSecretRebindingRekeyed,
  requireConnectionSecretsMatchDocument,
  requireMintedSecretIntroduction
} from "./settings-secret-guards.js";
import {
  parseSettingsPendingSecretsV1,
  removeSettingsPendingSecretsV1,
  writeSettingsPendingSecretsV1,
  type SettingsPendingSecretsV1
} from "./settings-pending-secrets.js";
import {
  completeSettingsSchema5UpgradeV1,
  prepareSettingsSchema5UpgradeV1,
  settingsSchema5UpgradeV1Identity,
  writeSettingsSchema5UpgradeCompleted,
  writeSettingsSchema5UpgradePrepared,
  type SettingsSchema5UpgradeV1Prepared,
  type SettingsSchema5SourceVersion
} from "./settings-schema5-upgrade.js";
import {
  convertSettingsStateSlotToV5,
  hashSettingsStateSlot,
  sourceSchemaVersionOf,
  stageSettingsStateV5
} from "./settings-state-authority.js";
import type { SettingsStateSlot } from "./settings-state-slot.js";
import {
  discardStagedSettingsState,
  publishStagedSettingsState
} from "./settings-state-file.js";
import { hashSettingsDocumentV5, hashSettingsStateV5, parseSettingsStateV5 } from "./settings-v5-codec.js";
import { reduceSettingsStateV5 } from "./settings-v5-reducer.js";
import {
  completeSettingsMutationV5,
  prepareSettingsMutationV5,
  type SettingsMutationOperationV5
} from "./settings-v5-mutation.js";
import { SETTINGS_ROUTE_PURPOSE_VALUES } from "../shared/settings-v2-types.js";
import type { SettingsStateV5 } from "../shared/settings-v5-types.js";
import { selectSettingsRouteV5 } from "../shared/settings-v5-types.js";
import {
  credentialReferencesResolve,
  providerRequestTransportAvailable
} from "./settings-v2-runtime.js";
import { assertRuntimeDocumentSupportedV5 } from "./settings-v5-runtime.js";
import { activeSettingsDocumentV5 } from "./settings-v5-state-validation.js";
import { settingsStateRelation } from "./settings-state-validation.js";
import { storedSecretIdsInState, providerSecretIdsToKeep } from "./subscription-runtime.js";
import type { SettingsRuntimeResolver } from "./settings-runtime-resolver.js";
import {
  runSettingsSaveHook,
  type SettingsActivationMode,
  type SettingsSaveHooks
} from "./settings-save-hooks.js";
import { corruptSettingsStateReceipt } from "./settings-v2-mutation.js";
import type { GenerationSettings } from "../shared/types.js";

export interface SettingsV5SaveContext {
  readonly dataDir: string;
  readonly secretsDir: string;
  readonly prunesSecrets: boolean;
  readonly ledger: MutationLedgerStore;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeResolver: SettingsRuntimeResolver;
  readonly validateCandidate: (settings: GenerationSettings) => Promise<boolean>;
  readonly activationMode: SettingsActivationMode;
  readonly now: () => Date;
  readonly hooks?: SettingsSaveHooks;
}

export async function commitSettingsSaveV5(
  ctx: SettingsV5SaveContext,
  operation: SettingsMutationOperationV5,
  request: MutationCoordinatorRequest<SettingsMutationTarget>,
  sourceSlot: SettingsStateSlot,
  currentV5: SettingsStateV5
): Promise<{
  readonly prepared: PreparedUserMutationRecord;
  readonly settled: SettingsStateV5;
}> {
  const relation = settingsStateRelation(currentV5);
  const connectionSecretEntries = operation.method === "saveSettings"
    ? Object.entries(operation.connectionSecrets ?? {})
    : [];
  if (operation.method === "saveSettings") {
    requireConnectionSecretsMatchDocument(operation.document, connectionSecretEntries);
    requireActiveSecretRebindingRekeyed(
      activeSettingsDocumentV5(currentV5),
      operation.document,
      connectionSecretEntries
    );
    requireMintedSecretIntroduction(currentV5, operation.document, connectionSecretEntries);
  }

  const next = nextStateAfterMutation(sourceSlot, currentV5, operation, request.mutationId);
  const mintedIds = operation.method === "saveSettings"
    ? newlyMintedSecretIds(currentV5, connectionSecretEntries)
    : [];
  const sourceHash = hashSettingsStateSlot(sourceSlot);
  const candidateHash = hashSettingsStateV5(next);
  const ownership = mintedIds.length === 0
    ? null
    : parseSettingsPendingSecretsV1({
      schema: 1,
      kind: "settings-pending-secrets-v1",
      sourceStateHash: sourceHash,
      mutationId: request.mutationId,
      candidateHash,
      mintedSecretIds: mintedIds
    } satisfies SettingsPendingSecretsV1);

  if (ownership !== null) {
    await writeSettingsPendingSecretsV1(ctx.dataDir, ownership);
  }
  await runSettingsSaveHook(ctx.hooks, "afterPendingSecretsOwnership");

  for (const [secretId, value] of connectionSecretEntries) {
    if (value !== null) await writeProviderSecret(ctx.secretsDir, secretId, value);
  }
  await runSettingsSaveHook(ctx.hooks, "afterSecretValueWrite");

  const prepared = prepareSettingsMutationV5(
    operation,
    request,
    hashSettingsStateSlot(sourceSlot),
    next,
    timestamp(ctx)
  );
  const crossSchema = sourceSlot.kind !== "v5";
  const upgradeIdentity = crossSchema
    ? settingsSchema5UpgradeV1Identity(
      sourceSchemaVersionOf(sourceSlot) as SettingsSchema5SourceVersion,
      sourceHash,
      candidateHash,
      request.mutationId
    )
    : null;
  let upgradePrepared: SettingsSchema5UpgradeV1Prepared | null = null;
  if (upgradeIdentity !== null) {
    upgradePrepared = prepareSettingsSchema5UpgradeV1(upgradeIdentity, timestamp(ctx));
    await writeSettingsSchema5UpgradePrepared(ctx.dataDir, upgradePrepared);
  }
  await ctx.ledger.writeUserRecord(prepared);
  await runSettingsSaveHook(ctx.hooks, "afterReceiptPrepared");

  await stageSettingsStateV5(ctx.dataDir, next);
  await runSettingsSaveHook(ctx.hooks, "afterNextStaged");
  await publishStagedSettingsState(ctx.dataDir);
  await runSettingsSaveHook(ctx.hooks, "afterCurrentPublished");

  if (upgradePrepared !== null) {
    await writeSettingsSchema5UpgradeCompleted(
      ctx.dataDir,
      completeSettingsSchema5UpgradeV1(upgradePrepared, timestamp(ctx))
    );
  }
  await ctx.ledger.writeUserRecord(completeSettingsMutationV5(prepared, timestamp(ctx)));
  await runSettingsSaveHook(ctx.hooks, "afterReceiptCompleted");

  let settled = next;
  if (
    operation.method === "saveSettings"
    && ctx.activationMode === "activation-capable"
    && settingsStateRelation(next) === "staged"
  ) {
    settled = await activateStagedV5(ctx, next);
  }
  await deleteSupersededSecrets(ctx, [currentV5, next], settled);
  if (ctx.prunesSecrets) {
    await pruneProviderSecrets(ctx.secretsDir, providerSecretIdsToKeep(settled));
  }
  await runSettingsSaveHook(ctx.hooks, "afterSecretCleanup");
  if (ownership !== null) {
    await removeSettingsPendingSecretsV1(ctx.dataDir);
  }
  return { prepared, settled };
}

export async function cleanupUncommittedSettingsSave(
  ctx: SettingsV5SaveContext,
  prepared: PreparedUserMutationRecord
): Promise<void> {
  const receipt = await ctx.ledger.loadUserReceipt("settings", prepared.key);
  if (receipt.prepared !== null && receipt.completed === null
    && hashPreparedMutationRecord(receipt.prepared) === hashPreparedMutationRecord(prepared)) {
    await ctx.ledger.removeOrphanPreparedUserReceipt(
      "settings",
      prepared.key,
      hashPreparedMutationRecord(prepared)
    );
  }
  await discardStagedSettingsState(ctx.dataDir);
}

export function nextStateAfterMutation(
  sourceSlot: SettingsStateSlot,
  currentV5: SettingsStateV5,
  operation: SettingsMutationOperationV5,
  mutationId: string
): SettingsStateV5 {
  const pointer = {
    receiptKind: "user" as const,
    mutationId,
    phase: "prepared" as const
  };
  const current = currentV5.lastTransaction === null
    ? parseSettingsStateV5({ ...currentV5, lastTransaction: pointer })
    : currentV5;
  const relation = settingsStateRelation(current);
  if (operation.method === "discardPendingSettings") {
    return reduceSettingsStateV5(current, { kind: "discard-pending", lastTransaction: pointer });
  }
  const active = activeSettingsDocumentV5(current);
  if (
    sourceSlot.kind !== "v5"
    && relation === "clean"
    && hashSettingsDocumentV5(active) === hashSettingsDocumentV5(operation.document)
  ) {
    return parseSettingsStateV5({
      ...current,
      stateGeneration: current.stateGeneration + 1,
      lastTransaction: pointer
    });
  }
  return reduceSettingsStateV5(current, {
    kind: "save-document",
    document: operation.document,
    lastTransaction: pointer
  });
}

export async function activateStagedV5(
  ctx: SettingsV5SaveContext,
  state: SettingsStateV5
): Promise<SettingsStateV5> {
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user") throw corruptSettingsStateReceipt("staged settings");
  let next = await replaceInternalV5(ctx, reduceSettingsStateV5(state, {
    kind: "begin-validation",
    transactionId: pointer.mutationId
  }));
  const candidate = next.documents[String(next.pendingRevision!)]!;
  const storedSecrets = await readProviderSecrets(ctx.secretsDir);
  if (!credentialReferencesResolve(candidate, ctx.environment, new Set(storedSecrets.keys()))) {
    return await replaceInternalV5(ctx, reduceSettingsStateV5(next, {
      kind: "validation-failed",
      errorCode: "credential_unresolved"
    }));
  }
  let candidateReady = false;
  try {
    assertRuntimeDocumentSupportedV5(candidate, ctx.runtimeResolver);
    const validatedConnections = new Set<string>();
    const probeTargets: GenerationSettings[] = [];
    for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
      const route = selectSettingsRouteV5(candidate, purpose);
      if (validatedConnections.has(route.model.connectionId)) continue;
      validatedConnections.add(route.model.connectionId);
      const effective = ctx.runtimeResolver.resolveV5({
        document: candidate,
        purpose,
        storedSecrets
      }).settings;
      if (providerRequestTransportAvailable(effective)) probeTargets.push(effective);
    }
    const results = await Promise.all(
      probeTargets.map((target) => ctx.validateCandidate(target))
    );
    candidateReady = results.every((ready) => ready);
  } catch {
    candidateReady = false;
  }
  if (!candidateReady) {
    return await replaceInternalV5(ctx, reduceSettingsStateV5(next, {
      kind: "validation-failed",
      errorCode: "candidate_invalid"
    }));
  }
  for (const kind of ["prepare", "promote", "commit", "finish-commit"] as const) {
    next = await replaceInternalV5(ctx, reduceSettingsStateV5(next, { kind }));
  }
  return next;
}

async function replaceInternalV5(
  ctx: SettingsV5SaveContext,
  state: SettingsStateV5
): Promise<SettingsStateV5> {
  await stageSettingsStateV5(ctx.dataDir, state);
  await publishStagedSettingsState(ctx.dataDir);
  return state;
}

async function deleteSupersededSecrets(
  ctx: SettingsV5SaveContext,
  preceding: readonly SettingsStateV5[],
  settled: SettingsStateV5
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
    await deleteProviderSecret(ctx.secretsDir, secretId);
  }
}

function timestamp(ctx: SettingsV5SaveContext): string {
  const value = ctx.now();
  if (!Number.isFinite(value.getTime())) throw new Error("Settings clock returned an invalid date");
  return value.toISOString();
}

export { convertSettingsStateSlotToV5 };
