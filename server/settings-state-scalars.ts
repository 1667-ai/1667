import {
  SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES,
  SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES,
  SETTINGS_ACTIVATION_STATE_V2_VALUES,
  type SettingsActivationOutcomeV2,
  type SettingsActivationV2,
  type SettingsTransactionPointerV2
} from "../shared/settings-v2-types.js";
import { FM1_KEY_PATTERN, MUTATION_ID_PATTERN } from "./mutation-ledger-scalars.js";
import {
  HASH256_PATTERN,
  SettingsFormatError,
  requirePositiveSettingsInteger
} from "./settings-v2-scalars.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

/**
 * The settings-state scalar and pointer parsers: activation, activation
 * outcome, transaction pointer, and the small scalars underneath them. None
 * of these reads a document field, so none of them is settings-schema-
 * version-specific. `server/settings-state-validation.ts` calls the four
 * exported parsers below while checking every other settings-state
 * invariant, for schema 2 and schema 3 alike. `requireMutationId`,
 * `requireHash`, and `oneOf` stay module-private: they have no consumer
 * outside this file, and a public `oneOf` would collide with the
 * differently worded one in `server/settings-v2-validation.ts`.
 */

const ACTIVATION = closedShape(["transactionId", "oldHash", "candidateHash", "state", "attempt"]);
const OUTCOME = closedShape([
  "transactionId", "candidateRevision", "result", "errorCode", "atStateGeneration"
]);
const USER_POINTER = closedShape(["receiptKind", "mutationId", "phase"]);
const MIGRATION_POINTER = closedShape(["receiptKind", "key", "phase"]);

export function parseActivation(value: unknown): SettingsActivationV2 {
  const activation = closedRecord(value, "settings state.activation", ACTIVATION);
  return {
    transactionId: requireMutationId(activation.transactionId, "settings state.activation.transactionId"),
    oldHash: requireHash(activation.oldHash, "settings state.activation.oldHash"),
    candidateHash: requireHash(activation.candidateHash, "settings state.activation.candidateHash"),
    state: oneOf(
      activation.state,
      SETTINGS_ACTIVATION_STATE_V2_VALUES,
      "settings state.activation.state"
    ),
    attempt: literal(activation.attempt, 1, "settings state.activation.attempt")
  };
}

export function parseOutcome(value: unknown, generation: number, clock: number): SettingsActivationOutcomeV2 {
  const outcome = closedRecord(value, "settings state.lastActivationOutcome", OUTCOME);
  const result = oneOf(
    outcome.result,
    SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES,
    "settings activation outcome.result"
  );
  const errorCode = outcome.errorCode === null
    ? null
    : oneOf(
        outcome.errorCode,
        SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES,
        "settings activation outcome.errorCode"
      );
  const candidateRevision = requirePositiveSettingsInteger(
    outcome.candidateRevision,
    "settings activation outcome.candidateRevision"
  );
  if (candidateRevision > clock) {
    throw new SettingsFormatError("settings activation outcome candidate revision exceeds the clock");
  }
  const atStateGeneration = requirePositiveSettingsInteger(
    outcome.atStateGeneration,
    "settings activation outcome.atStateGeneration"
  );
  if (atStateGeneration > generation) {
    throw new SettingsFormatError("settings activation outcome generation is in the future");
  }
  const common = {
    transactionId: requireMutationId(outcome.transactionId, "settings activation outcome.transactionId"),
    candidateRevision,
    atStateGeneration
  };
  if (result === "committed") {
    if (errorCode !== null) {
      throw new SettingsFormatError("only a committed settings activation outcome has null errorCode");
    }
    return { ...common, result, errorCode };
  }
  if (errorCode === null) {
    throw new SettingsFormatError("only a committed settings activation outcome has null errorCode");
  }
  return { ...common, result, errorCode };
}

export function parseTransactionPointer(value: unknown): SettingsTransactionPointerV2 {
  const candidate = value as Record<string, unknown> | null;
  if (candidate?.receiptKind === "user") {
    const pointer = closedRecord(value, "settings state.lastTransaction", USER_POINTER);
    return {
      receiptKind: "user",
      mutationId: requireMutationId(pointer.mutationId, "settings state.lastTransaction.mutationId"),
      phase: literal(pointer.phase, "prepared", "settings state.lastTransaction.phase")
    };
  }
  if (candidate?.receiptKind === "format-migration-v1") {
    const pointer = closedRecord(value, "settings state.lastTransaction", MIGRATION_POINTER);
    if (typeof pointer.key !== "string" || !FM1_KEY_PATTERN.test(pointer.key)) {
      throw new SettingsFormatError("settings state.lastTransaction.key is not a canonical fm1 key");
    }
    return {
      receiptKind: "format-migration-v1",
      key: pointer.key,
      phase: literal(pointer.phase, "prepared", "settings state.lastTransaction.phase")
    };
  }
  throw new SettingsFormatError("settings state.lastTransaction.receiptKind is invalid");
}

export function parseRevisionKey(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new SettingsFormatError(`settings document revision key ${JSON.stringify(value)} is invalid`);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || String(revision) !== value) {
    throw new SettingsFormatError(`settings document revision key ${JSON.stringify(value)} is not canonical`);
  }
  return revision;
}

function requireMutationId(value: unknown, label: string): string {
  if (typeof value !== "string" || !MUTATION_ID_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} is invalid`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH256_PATTERN.test(value)) {
    throw new SettingsFormatError(`${label} is invalid`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new SettingsFormatError(`${label} is invalid`);
  }
  return value as T[number];
}
