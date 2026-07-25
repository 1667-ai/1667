import { createHash } from "node:crypto";
import type {
  DiscardPendingSettingsCommand,
  SaveSettingsCommand,
  SettingsDocumentV2,
  SettingsStateV2
} from "../shared/settings-v2-types.js";
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
import {
  hashSettingsStateV2,
  parseSettingsDocumentV2
} from "./settings-v2-codec.js";
import {
  validateProviderSecretValue
} from "../shared/provider-secret-value.js";
import { requireSecretId } from "./settings-v2-scalars.js";

export type SaveSettingsCommandEnvelope =
  Omit<SaveSettingsCommand, "document" | "connectionSecrets">;
export type SettingsMutationOperation =
  | {
      readonly method: "saveSettings";
      readonly document: SettingsDocumentV2;
      readonly connectionSecrets?: Readonly<Record<string, string | null>>;
    }
  | {
      readonly method: "discardPendingSettings";
    };

export function parseSaveSettingsCommandEnvelope(
  value: unknown
): SaveSettingsCommandEnvelope {
  const command = saveCommandRecord(value);
  return {
    transportOperationId: stringValue(command.transportOperationId, "Transport operation ID"),
    mutationId: stringValue(command.mutationId, "Mutation ID"),
    expectedStateGeneration: integerValue(command.expectedStateGeneration, "Expected state generation")
  };
}

export function parseSaveSettingsDocument(value: unknown): SettingsDocumentV2 {
  const command = saveCommandRecord(value);
  return parseSettingsDocumentV2(command.document);
}

export function parseSaveSettingsConnectionSecrets(
  value: unknown
): Readonly<Record<string, string | null>> {
  const command = saveCommandRecord(value);
  if (command.connectionSecrets === undefined) return {};
  const raw = command.connectionSecrets;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceError(400, "Save settings connectionSecrets must be an object");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 64) {
    throw new ServiceError(400, "Save settings connectionSecrets exceeds 64 entries");
  }
  const result: Record<string, string | null> = {};
  for (const [rawSecretId, rawValue] of entries) {
    const secretId = requireSecretId(rawSecretId, "Save settings secret ID");
    result[secretId] = rawValue === null
      ? null
      : validateProviderSecretValue(rawValue);
  }
  return result;
}

export function parseDiscardPendingSettingsCommand(
  value: unknown
): DiscardPendingSettingsCommand {
  const command = exactRecord(value, [
    "transportOperationId", "mutationId", "expectedStateGeneration"
  ], "Discard pending settings command");
  return {
    transportOperationId: stringValue(command.transportOperationId, "Transport operation ID"),
    mutationId: stringValue(command.mutationId, "Mutation ID"),
    expectedStateGeneration: integerValue(command.expectedStateGeneration, "Expected state generation")
  };
}

export function settingsCoordinatorAdmissionRequest(
  command: SaveSettingsCommandEnvelope
) {
  return {
    transportOperationId: command.transportOperationId,
    mutationId: command.mutationId,
    scope: "settings",
    expectedAggregateVersion: {
      kind: "settings",
      stateGeneration: command.expectedStateGeneration
    }
  };
}

export function settingsCoordinatorRequest(
  command: SaveSettingsCommand | DiscardPendingSettingsCommand,
  fingerprint: string
) {
  return {
    transportOperationId: command.transportOperationId,
    mutationId: command.mutationId,
    fingerprint,
    scope: "settings",
    expectedAggregateVersion: {
      kind: "settings",
      stateGeneration: command.expectedStateGeneration
    }
  };
}

export function settingsMutationFingerprint(
  operation: SettingsMutationOperation,
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

export function prepareSettingsMutation(
  operation: SettingsMutationOperation,
  request: MutationCoordinatorRequest<SettingsMutationTarget>,
  current: SettingsStateV2,
  next: SettingsStateV2,
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
    oldStateHash: hashSettingsStateV2(current),
    newStateHash: hashSettingsStateV2(next),
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

export function completeSettingsMutation(
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

export function requireMatchingSettingsPrepared(
  prepared: NonNullable<UserMutationReceipt["prepared"]>,
  operation: SettingsMutationOperation,
  mutationId: MutationId,
  fingerprint: string
): PreparedUserMutationRecord {
  requireSettingsPrepared(prepared, mutationId);
  if (prepared.method !== operation.method || prepared.fingerprintHash !== fingerprint) {
    throw new ServiceError(
      409,
      "Mutation ID was already used for different settings input.",
      "idempotency_conflict"
    );
  }
  return prepared;
}

export function requireSettingsPrepared(
  prepared: NonNullable<UserMutationReceipt["prepared"]>,
  mutationId: string
): asserts prepared is PreparedUserMutationRecord {
  if (prepared.purpose !== "mutation" || prepared.aggregateKey !== "settings"
    || prepared.key !== mutationId
    || (prepared.method !== "saveSettings" && prepared.method !== "discardPendingSettings")
    || prepared.result.kind !== "settings") {
    throw corruptSettingsStateReceipt(mutationId);
  }
}

export function requireExactSettingsReceiptState(
  prepared: PreparedUserMutationRecord,
  state: SettingsStateV2
): void {
  if (prepared.newStateHash !== hashSettingsStateV2(state)
    || prepared.result.kind !== "settings"
    || prepared.result.settingsStateGeneration !== state.stateGeneration
    || prepared.result.activeSettingsRevision !== state.activeRevision
    || prepared.result.pendingSettingsRevision !== state.pendingRevision) {
    throw corruptSettingsStateReceipt(prepared.key);
  }
}

export function requireSettingsReceiptNotAhead(
  prepared: PreparedUserMutationRecord,
  state: SettingsStateV2
): void {
  if (prepared.result.kind !== "settings"
    || prepared.result.settingsStateGeneration > state.stateGeneration
    || (prepared.result.settingsStateGeneration === state.stateGeneration
      && prepared.newStateHash !== hashSettingsStateV2(state))) {
    throw corruptSettingsStateReceipt(prepared.key);
  }
}

export function invalidSettingsMutation(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const failure = new ServiceError(
    400,
    error instanceof Error ? error.message : "Settings input is invalid.",
    "invalid_request"
  );
  failure.cause = error;
  return failure;
}

export function corruptSettingsStateReceipt(identity: string): ServiceError {
  return new ServiceError(
    500,
    `Settings state and durable receipt disagree: ${identity}`,
    "internal"
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    || Reflect.ownKeys(value).length !== keys.length) {
    throw new ServiceError(400, `${label} must contain exactly: ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function saveCommandRecord(value: unknown): Record<string, unknown> {
  const required = [
    "transportOperationId",
    "mutationId",
    "expectedStateGeneration",
    "document"
  ] as const;
  const allowed = [...required, "connectionSecrets"];
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !(allowed as readonly string[]).includes(key)
    )
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ServiceError(
      400,
      `Save settings command must contain: ${required.join(", ")}; connectionSecrets is optional`
    );
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ServiceError(400, `${label} must be a non-empty string.`);
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ServiceError(400, `${label} must be a positive safe integer.`);
  }
  return value;
}
