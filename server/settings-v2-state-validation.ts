import {
  SETTINGS_ACTIVATION_ERROR_CODE_V2_VALUES,
  SETTINGS_ACTIVATION_OUTCOME_RESULT_V2_VALUES,
  SETTINGS_ACTIVATION_STATE_V2_VALUES,
  type SettingsActivationOutcomeV2,
  type SettingsActivationV2,
  type SettingsDocumentV2,
  type SettingsStateV2,
  type SettingsTransactionPointerV2
} from "../shared/settings-v2-types.js";
import { FM1_KEY_PATTERN, MUTATION_ID_PATTERN } from "./mutation-ledger-scalars.js";
import { hashCanonicalSettingsDocumentV2 } from "./settings-v2-hash.js";
import { INITIAL_SETTINGS_DOCUMENT_V2_HASH } from "./settings-v2-initial-vectors.js";
import {
  HASH256_PATTERN,
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_ENVELOPE_BYTES,
  SettingsFormatError,
  requirePositiveSettingsInteger
} from "./settings-v2-scalars.js";
import { validateSettingsDocumentV2, type SettingsValidationOptions } from "./settings-v2-validation.js";
import { canonicalJson } from "./canonical-json.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import {
  MAX_CREDENTIAL_NAMES_PER_STATE
} from "../shared/credential-slot-policy.js";
import {
  settingsStateCredentialNames
} from "../shared/settings-credential-slots.js";

const STATE = closedShape([
  "schemaVersion", "stateGeneration", "settingsRevisionClock", "documents", "activeRevision",
  "pendingRevision", "previousRevision", "activation", "lastActivationOutcome", "lastTransaction"
]);
const ACTIVATION = closedShape(["transactionId", "oldHash", "candidateHash", "state", "attempt"]);
const OUTCOME = closedShape([
  "transactionId", "candidateRevision", "result", "errorCode", "atStateGeneration"
]);
const USER_POINTER = closedShape(["receiptKind", "mutationId", "phase"]);
const MIGRATION_POINTER = closedShape(["receiptKind", "key", "phase"]);

export type SettingsStateRelation =
  | "clean"
  | "staged"
  | "validating"
  | "prepared"
  | "promoted"
  | "rolling-back"
  | "committed";

export function validateSettingsStateV2(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV2 {
  const root = closedRecord(value, "settings state", STATE);
  literal(root.schemaVersion, 2, "settings state.schemaVersion");
  const stateGeneration = requirePositiveSettingsInteger(root.stateGeneration, "settings state.stateGeneration");
  const settingsRevisionClock = requirePositiveSettingsInteger(
    root.settingsRevisionClock,
    "settings state.settingsRevisionClock"
  );
  if (stateGeneration < settingsRevisionClock) {
    throw new SettingsFormatError("settings state.stateGeneration must not trail settingsRevisionClock");
  }
  const documents = parseDocuments(root.documents, settingsRevisionClock, options);
  const activeRevision = requireDocumentRevision(root.activeRevision, "settings state.activeRevision", documents);
  const pendingRevision = nullableDocumentRevision(
    root.pendingRevision,
    "settings state.pendingRevision",
    documents
  );
  const previousRevision = nullableDocumentRevision(
    root.previousRevision,
    "settings state.previousRevision",
    documents
  );
  const activation = root.activation === null ? null : parseActivation(root.activation);
  const lastActivationOutcome = root.lastActivationOutcome === null
    ? null
    : parseOutcome(root.lastActivationOutcome, stateGeneration, settingsRevisionClock);
  const lastTransaction = root.lastTransaction === null ? null : parseTransactionPointer(root.lastTransaction);
  const state: SettingsStateV2 = {
    schemaVersion: 2,
    stateGeneration,
    settingsRevisionClock,
    documents,
    activeRevision,
    pendingRevision,
    previousRevision,
    activation,
    lastActivationOutcome,
    lastTransaction
  };
  const relation = settingsStateRelation(state);
  validateRoleDocuments(state, relation);
  validateActivationBinding(state, relation);
  validateTransactionBinding(state, relation);
  validateInitialNullPointer(state, relation);
  if (settingsStateCredentialNames(state).length
    > MAX_CREDENTIAL_NAMES_PER_STATE) {
    throw new SettingsFormatError(
      `settings state exceeds the ${MAX_CREDENTIAL_NAMES_PER_STATE}-credential-name limit`
    );
  }
  return state;
}

export function settingsStateRelation(state: SettingsStateV2): SettingsStateRelation {
  const { activeRevision: active, pendingRevision: pending, previousRevision: previous, activation } = state;
  if (activation === null) {
    if (pending === null && previous === null) return "clean";
    if (pending !== null && pending !== active && previous === null) return "staged";
    throw new SettingsFormatError("settings state has an invalid clean/staged role relation");
  }
  switch (activation.state) {
    case "validating":
      if (pending !== null && pending !== active && previous === null) return "validating";
      break;
    case "prepared":
      if (pending !== null && pending !== active && previous === active) return "prepared";
      break;
    case "promoted":
      if (pending === active && previous !== null && previous !== active) return "promoted";
      break;
    case "rolling-back":
      if (pending !== null && pending !== active && previous === active) return "rolling-back";
      break;
    case "committed":
      if (pending === active && previous !== null && previous !== active) return "committed";
      break;
  }
  throw new SettingsFormatError(`settings state has an invalid ${activation.state} role relation`);
}

function parseDocuments(
  value: unknown,
  clock: number,
  options: SettingsValidationOptions
): Record<string, SettingsDocumentV2> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError("settings state.documents must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 2) {
    throw new SettingsFormatError("settings state.documents must contain one or two entries");
  }
  const result: Record<string, SettingsDocumentV2> = {};
  const hashes = new Set<string>();
  for (const [key, raw] of entries) {
    const revision = parseRevisionKey(key);
    if (revision > clock) throw new SettingsFormatError(`settings document revision ${key} exceeds the clock`);
    const document = validateSettingsDocumentV2(raw, options);
    const bytes = Buffer.byteLength(canonicalJson(document), "utf8");
    if (bytes > MAX_SETTINGS_DOCUMENT_BYTES) {
      throw new SettingsFormatError(
        `settings document revision ${key} exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte limit`
      );
    }
    const hash = hashCanonicalSettingsDocumentV2(document);
    if (hashes.has(hash)) throw new SettingsFormatError("settings state contains byte-identical document revisions");
    hashes.add(hash);
    result[key] = document;
  }
  return result;
}

function parseActivation(value: unknown): SettingsActivationV2 {
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

function parseOutcome(value: unknown, generation: number, clock: number): SettingsActivationOutcomeV2 {
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

function parseTransactionPointer(value: unknown): SettingsTransactionPointerV2 {
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

function validateRoleDocuments(state: SettingsStateV2, relation: SettingsStateRelation): void {
  const referenced = new Set([state.activeRevision]);
  if (state.pendingRevision !== null) referenced.add(state.pendingRevision);
  if (state.previousRevision !== null) referenced.add(state.previousRevision);
  const documentKeys = Object.keys(state.documents).map(parseRevisionKey);
  if (referenced.size !== documentKeys.length || documentKeys.some((revision) => !referenced.has(revision))) {
    throw new SettingsFormatError("settings state document table does not exactly match its roles");
  }
  if (relation !== "clean") {
    if (state.pendingRevision !== state.settingsRevisionClock) {
      throw new SettingsFormatError("non-clean settings state candidate revision must equal the revision clock");
    }
    const oldRevision = relation === "promoted" || relation === "committed"
      ? state.previousRevision!
      : state.activeRevision;
    if (state.pendingRevision <= oldRevision) {
      throw new SettingsFormatError("settings candidate revision must be newer than the old active revision");
    }
  }
}

function validateActivationBinding(state: SettingsStateV2, relation: SettingsStateRelation): void {
  if (state.activation === null) return;
  const oldRevision = relation === "promoted" || relation === "committed"
    ? state.previousRevision!
    : state.activeRevision;
  const oldDocument = state.documents[String(oldRevision)]!;
  const candidateDocument = state.documents[String(state.pendingRevision!)]!;
  if (state.activation.oldHash !== hashCanonicalSettingsDocumentV2(oldDocument)) {
    throw new SettingsFormatError("settings activation oldHash does not bind its old document");
  }
  if (state.activation.candidateHash !== hashCanonicalSettingsDocumentV2(candidateDocument)) {
    throw new SettingsFormatError("settings activation candidateHash does not bind its candidate document");
  }
  if (state.activation.oldHash === state.activation.candidateHash) {
    throw new SettingsFormatError("settings activation old and candidate hashes must differ");
  }
}

function validateTransactionBinding(state: SettingsStateV2, relation: SettingsStateRelation): void {
  if (relation === "clean") return;
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user") {
    throw new SettingsFormatError("non-clean settings state requires its user staging receipt pointer");
  }
  if (state.activation !== null && state.activation.transactionId !== pointer.mutationId) {
    throw new SettingsFormatError("settings activation transaction does not match its staging receipt");
  }
}

function validateInitialNullPointer(state: SettingsStateV2, relation: SettingsStateRelation): void {
  if (state.lastTransaction !== null) return;
  if (
    relation !== "clean"
    || state.stateGeneration !== 1
    || state.settingsRevisionClock !== 1
    || state.activeRevision !== 1
    || state.lastActivationOutcome !== null
    || hashCanonicalSettingsDocumentV2(state.documents["1"]!) !== INITIAL_SETTINGS_DOCUMENT_V2_HASH
  ) {
    throw new SettingsFormatError(
      "null lastTransaction is reserved for the exact canonical initial settings state"
    );
  }
}

export function settingsStateEnvelopeBytes(state: SettingsStateV2): number {
  const total = Buffer.byteLength(canonicalJson(state), "utf8");
  const documents = Object.values(state.documents)
    .reduce((sum, document) => sum + Buffer.byteLength(canonicalJson(document), "utf8"), 0);
  const envelope = total - documents;
  if (envelope > MAX_SETTINGS_STATE_ENVELOPE_BYTES) {
    throw new SettingsFormatError(
      `settings state fixed envelope exceeds its ${MAX_SETTINGS_STATE_ENVELOPE_BYTES}-byte limit`
    );
  }
  return envelope;
}

function requireDocumentRevision(
  value: unknown,
  label: string,
  documents: Readonly<Record<string, SettingsDocumentV2>>
): number {
  const revision = requirePositiveSettingsInteger(value, label);
  if (!Object.hasOwn(documents, String(revision))) throw new SettingsFormatError(`${label} does not resolve`);
  return revision;
}

function nullableDocumentRevision(
  value: unknown,
  label: string,
  documents: Readonly<Record<string, SettingsDocumentV2>>
): number | null {
  return value === null ? null : requireDocumentRevision(value, label, documents);
}

function parseRevisionKey(value: string): number {
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
