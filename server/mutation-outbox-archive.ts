import path from "node:path";
import {
  decodeFailureEnvelope,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import {
  isProviderMutationId,
  isProviderRecoveryContext,
  type ProviderRecoveryContext
} from "../shared/provider-recovery.js";
import { ServiceError } from "./errors.js";
import {
  isProviderMutationMethod
} from "./mutation-ledger-types.js";
import {
  requireDurableCommit,
  type CommitResult
} from "./story-lifecycle.js";
import type { MutationOutboxRecord } from "./mutation-outbox.js";

export type MutationOutboxResolution = FailureEnvelope;
type ProviderRecoveryTarget = Extract<
  ProviderRecoveryContext,
  { readonly kind: "target" }
>;

interface ArchivedMutationOutboxBase {
  format: "1667-mutation-outbox-archive";
  intent: MutationOutboxRecord;
  resolution: MutationOutboxResolution;
  resolvedAt: string;
}

export type ArchivedMutationOutboxRecord =
  ArchivedMutationOutboxBase & (
    | {
        schemaVersion: 1;
        providerRecovery?: never;
      }
    | {
        schemaVersion: 2;
        providerRecovery: ProviderRecoveryTarget;
      }
  );

export interface MutationOutboxDurability {
  unlinkDurable(file: string): Promise<CommitResult>;
  syncDirectory(directory: string): Promise<void>;
}

export function createArchivedMutationOutboxRecord(
  intent: MutationOutboxRecord,
  resolution: MutationOutboxResolution,
  providerMutationId?: string
): ArchivedMutationOutboxRecord {
  const providerWarning = isProviderRecoveryWarning(intent, resolution);
  const currentWarning = isProviderMutationId(intent.mutationId);
  const legacyProviderWarning = providerWarning && !currentWarning;
  if (providerMutationId !== undefined
    ? !providerWarning || !currentWarning
      || !isProviderMutationId(providerMutationId)
    : providerWarning && !legacyProviderWarning) {
    throw corruptArchive(intent.mutationId);
  }
  const resolvedAt = new Date().toISOString();
  if (providerMutationId === undefined) {
    return {
      format: "1667-mutation-outbox-archive",
      schemaVersion: 1,
      intent,
      resolution,
      resolvedAt
    };
  }
  return {
    format: "1667-mutation-outbox-archive",
    // Version 1 readers cannot preserve the exact provider receipt target.
    schemaVersion: 2,
    intent,
    resolution,
    providerRecovery: {
      kind: "target",
      providerMutationId
    },
    resolvedAt
  };
}

export function parseArchivedMutationOutboxRecord(
  value: unknown,
  mutationId: string,
  parseIntent: (
    value: unknown,
    mutationId: string
  ) => MutationOutboxRecord
): ArchivedMutationOutboxRecord {
  if (value === null || typeof value !== "object") {
    throw corruptArchive(mutationId);
  }
  const archived = value as Partial<ArchivedMutationOutboxRecord>;
  const resolution = decodeFailureEnvelope(archived.resolution);
  const intent = archived.intent === undefined
    ? null
    : parseIntent(archived.intent, mutationId);
  const supportedSchema = archived.schemaVersion === 1
    || archived.schemaVersion === 2;
  if (archived.format !== "1667-mutation-outbox-archive"
    || !supportedSchema
    || intent === null
    || !validProviderRecovery(
      archived.schemaVersion,
      archived.providerRecovery,
      intent,
      resolution
    )
    || typeof archived.resolvedAt !== "string"
    || !Number.isFinite(Date.parse(archived.resolvedAt))
    || resolution === null) {
    throw corruptArchive(mutationId);
  }
  const base: ArchivedMutationOutboxBase = {
    format: "1667-mutation-outbox-archive",
    intent,
    resolution,
    resolvedAt: archived.resolvedAt
  };
  return archived.schemaVersion === 1
    ? {
        ...base,
        schemaVersion: 1
      }
    : {
        ...base,
        schemaVersion: 2,
        providerRecovery: archived.providerRecovery!
      };
}

export function providerRecoveryFromArchive(
  record: ArchivedMutationOutboxRecord
): ProviderRecoveryContext | undefined {
  if (record.providerRecovery !== undefined) {
    return record.providerRecovery;
  }
  return record.schemaVersion !== 1
    || !isProviderRecoveryWarning(record.intent, record.resolution)
    || record.intent.expectedAggregateVersion === undefined
    ? undefined
    : {
        kind: "legacy",
        warningAggregateVersion:
          record.intent.expectedAggregateVersion
      };
}

export async function dismissArchivedMutationOutboxRecord(
  file: string,
  message: string,
  durability: MutationOutboxDurability
): Promise<void> {
  try {
    requireDurableCommit(await durability.unlinkDurable(file), message);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A prior cleanup can unlink the archive before its directory barrier
      // fails. Reconfirm that barrier before accepting its absence.
      await durability.syncDirectory(path.dirname(file));
      return;
    }
    throw error;
  }
}

function validProviderRecovery(
  schemaVersion: unknown,
  value: unknown,
  intent: MutationOutboxRecord,
  resolution: MutationOutboxResolution | null
): value is ProviderRecoveryTarget | undefined {
  if (schemaVersion === 1) return value === undefined;
  if (schemaVersion !== 2) return false;
  return isProviderRecoveryContext(value)
    && value.kind === "target"
    && isProviderMutationId(intent.mutationId)
    && resolution !== null
    && isProviderRecoveryWarning(intent, resolution);
}

function isProviderRecoveryWarning(
  intent: MutationOutboxRecord,
  resolution: MutationOutboxResolution
): boolean {
  return resolution.code === "generation_outcome_unknown"
    && isProviderMutationMethod(intent.method);
}

function corruptArchive(mutationId: string): ServiceError {
  return new ServiceError(
    500,
    `Mutation outbox record is corrupt: ${mutationId}`
  );
}
