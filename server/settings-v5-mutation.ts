import { createHash } from "node:crypto";
import type { SettingsDocumentV5, SettingsStateV5 } from "../shared/settings-v5-types.js";
import { canonicalJson } from "./canonical-json.js";
import { ServiceError } from "./errors.js";
import type {
  MutationCoordinatorRequest,
  SettingsMutationTarget
} from "./mutation-coordinator.js";
import { hashPreparedMutationRecord } from "./mutation-ledger-codec.js";
import type { UserMutationReceipt } from "./mutation-ledger-store.js";
import type {
  CompletedMutationRecord,
  MutationId,
  PreparedUserMutationRecord
} from "./mutation-ledger-types.js";
import { hashSettingsStateV5, parseSettingsDocumentV5 } from "./settings-v5-codec.js";
import {
  parseSaveSettingsCommandEnvelope,
  parseSaveSettingsConnectionSecrets,
  type SettingsMutationOperation as SettingsMutationOperationBase
} from "./settings-v2-mutation.js";
import { corruptSettingsStateReceipt } from "./settings-v2-mutation.js";

export type SettingsMutationOperationV5 =
  | {
      readonly method: "saveSettings";
      readonly document: SettingsDocumentV5;
      readonly connectionSecrets?: Readonly<Record<string, string | null>>;
    }
  | {
      readonly method: "discardPendingSettings";
    };

export function parseSaveSettingsDocumentV5(value: unknown): SettingsDocumentV5 {
  const command = value as { readonly document?: unknown };
  return parseSettingsDocumentV5(command.document);
}

export {
  parseSaveSettingsCommandEnvelope,
  parseSaveSettingsConnectionSecrets
};

export function settingsMutationFingerprintV5(
  operation: SettingsMutationOperationV5,
  expectedStateGeneration: number
): string {
  return createHash("sha256")
    .update("settings-mutation-v1\0", "utf8")
    .update(canonicalJson({
      schema: 1,
      method: operation.method,
      expectedStateGeneration,
      ...(operation.method === "saveSettings" ? { document: operation.document } : {})
    }), "utf8")
    .digest("hex");
}

export function prepareSettingsMutationV5(
  operation: SettingsMutationOperationV5,
  request: MutationCoordinatorRequest<SettingsMutationTarget>,
  oldStateHash: string,
  next: SettingsStateV5,
  preparedAt: string
): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key: request.mutationId,
    fingerprintHash: request.fingerprint,
    method: operation.method,
    oldStateHash,
    newStateHash: hashSettingsStateV5(next),
    startedRecordHash: null,
    result: {
      kind: "settings",
      settingsStateGeneration: next.stateGeneration,
      activeSettingsRevision: next.activeRevision,
      pendingSettingsRevision: next.pendingRevision
    },
    preparedAt
  };
}

export function requireExactSettingsReceiptStateV5(
  prepared: PreparedUserMutationRecord,
  state: SettingsStateV5
): void {
  if (prepared.newStateHash !== hashSettingsStateV5(state)
    || prepared.result.kind !== "settings"
    || prepared.result.settingsStateGeneration !== state.stateGeneration
    || prepared.result.activeSettingsRevision !== state.activeRevision
    || prepared.result.pendingSettingsRevision !== state.pendingRevision) {
    throw corruptSettingsStateReceipt(prepared.key);
  }
}

export function requireSettingsReceiptNotAheadV5(
  prepared: PreparedUserMutationRecord,
  state: SettingsStateV5
): void {
  if (prepared.result.kind !== "settings"
    || prepared.result.settingsStateGeneration > state.stateGeneration
    || (prepared.result.settingsStateGeneration === state.stateGeneration
      && prepared.newStateHash !== hashSettingsStateV5(state))) {
    throw corruptSettingsStateReceipt(prepared.key);
  }
}

export function requireMatchingSettingsPreparedV5(
  prepared: NonNullable<UserMutationReceipt["prepared"]>,
  operation: SettingsMutationOperationV5,
  mutationId: MutationId,
  fingerprint: string
): PreparedUserMutationRecord {
  if (prepared.purpose !== "mutation" || prepared.aggregateKey !== "settings"
    || prepared.key !== mutationId
    || (prepared.method !== "saveSettings" && prepared.method !== "discardPendingSettings")
    || prepared.result.kind !== "settings") {
    throw corruptSettingsStateReceipt(mutationId);
  }
  if (prepared.method !== operation.method || prepared.fingerprintHash !== fingerprint) {
    throw new ServiceError(
      409,
      "Mutation ID was already used for different settings input.",
      "idempotency_conflict"
    );
  }
  return prepared;
}

export function completeSettingsMutationV5(
  prepared: PreparedUserMutationRecord,
  completedAt: string
): CompletedMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: "settings",
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt
  };
}

export type { SettingsMutationOperationBase };
