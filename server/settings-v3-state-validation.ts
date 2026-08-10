import {
  type SettingsDocumentV3,
  type SettingsStateV3
} from "../shared/settings-v2-types.js";
import { hashCanonicalSettingsDocumentV3 } from "./settings-v3-hash.js";
import { INITIAL_SETTINGS_DOCUMENT_V3_HASH } from "./settings-v3-initial-vectors.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_ENVELOPE_BYTES,
  SettingsFormatError,
  requirePositiveSettingsInteger
} from "./settings-v2-scalars.js";
import {
  parseActivation,
  parseOutcome,
  parseRevisionKey,
  parseTransactionPointer,
  type SettingsStateRelation
} from "./settings-v2-state-validation.js";
import { validateSettingsDocumentV3, type SettingsValidationOptions } from "./settings-v3-validation.js";
import { canonicalJson } from "./canonical-json.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";

/** Schema 3's aggregate state codec. Structural sibling of
 * server/settings-v2-state-validation.ts: activation, outcome, and
 * transaction-pointer shapes carry no document-version information, so this
 * module reuses those parsers verbatim and re-implements only the document
 * table and role-relation checks that reference `SettingsDocumentV3`. */

const STATE = closedShape([
  "schemaVersion", "stateGeneration", "settingsRevisionClock", "documents", "activeRevision",
  "pendingRevision", "previousRevision", "activation", "lastActivationOutcome", "lastTransaction"
]);

export function validateSettingsStateV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV3 {
  const root = closedRecord(value, "settings state", STATE);
  literalSchemaVersion(root.schemaVersion);
  const stateGeneration = requirePositiveSettingsInteger(root.stateGeneration, "settings state.stateGeneration");
  const settingsRevisionClock = requirePositiveSettingsInteger(
    root.settingsRevisionClock,
    "settings state.settingsRevisionClock"
  );
  if (stateGeneration < settingsRevisionClock) {
    throw new SettingsFormatError("settings state.stateGeneration must not trail settingsRevisionClock");
  }
  const documents = parseDocumentsV3(root.documents, settingsRevisionClock, options);
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
  const state: SettingsStateV3 = {
    schemaVersion: 3,
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
  const relation = settingsStateRelationV3(state);
  validateRoleDocumentsV3(state, relation);
  validateActivationBindingV3(state, relation);
  validateTransactionBindingV3(state, relation);
  validateInitialNullPointerV3(state, relation);
  return state;
}

export function settingsStateRelationV3(state: SettingsStateV3): SettingsStateRelation {
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

export function settingsStateEnvelopeBytesV3(state: SettingsStateV3): number {
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

function parseDocumentsV3(
  value: unknown,
  clock: number,
  options: SettingsValidationOptions
): Record<string, SettingsDocumentV3> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError("settings state.documents must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 2) {
    throw new SettingsFormatError("settings state.documents must contain one or two entries");
  }
  const result: Record<string, SettingsDocumentV3> = {};
  const hashes = new Set<string>();
  for (const [key, raw] of entries) {
    const revision = parseRevisionKey(key);
    if (revision > clock) throw new SettingsFormatError(`settings document revision ${key} exceeds the clock`);
    const document = validateSettingsDocumentV3(raw, options);
    const bytes = Buffer.byteLength(canonicalJson(document), "utf8");
    if (bytes > MAX_SETTINGS_DOCUMENT_BYTES) {
      throw new SettingsFormatError(
        `settings document revision ${key} exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte limit`
      );
    }
    const hash = hashCanonicalSettingsDocumentV3(document);
    if (hashes.has(hash)) throw new SettingsFormatError("settings state contains byte-identical document revisions");
    hashes.add(hash);
    result[key] = document;
  }
  return result;
}

function validateRoleDocumentsV3(state: SettingsStateV3, relation: SettingsStateRelation): void {
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

function validateActivationBindingV3(state: SettingsStateV3, relation: SettingsStateRelation): void {
  if (state.activation === null) return;
  const oldRevision = relation === "promoted" || relation === "committed"
    ? state.previousRevision!
    : state.activeRevision;
  const oldDocument = state.documents[String(oldRevision)]!;
  const candidateDocument = state.documents[String(state.pendingRevision!)]!;
  if (state.activation.oldHash !== hashCanonicalSettingsDocumentV3(oldDocument)) {
    throw new SettingsFormatError("settings activation oldHash does not bind its old document");
  }
  if (state.activation.candidateHash !== hashCanonicalSettingsDocumentV3(candidateDocument)) {
    throw new SettingsFormatError("settings activation candidateHash does not bind its candidate document");
  }
  if (state.activation.oldHash === state.activation.candidateHash) {
    throw new SettingsFormatError("settings activation old and candidate hashes must differ");
  }
}

function validateTransactionBindingV3(state: SettingsStateV3, relation: SettingsStateRelation): void {
  if (relation === "clean") return;
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user") {
    throw new SettingsFormatError("non-clean settings state requires its user staging receipt pointer");
  }
  if (state.activation !== null && state.activation.transactionId !== pointer.mutationId) {
    throw new SettingsFormatError("settings activation transaction does not match its staging receipt");
  }
}

function validateInitialNullPointerV3(state: SettingsStateV3, relation: SettingsStateRelation): void {
  if (state.lastTransaction !== null) return;
  if (
    relation !== "clean"
    || state.stateGeneration !== 1
    || state.settingsRevisionClock !== 1
    || state.activeRevision !== 1
    || state.lastActivationOutcome !== null
    || hashCanonicalSettingsDocumentV3(state.documents["1"]!) !== INITIAL_SETTINGS_DOCUMENT_V3_HASH
  ) {
    throw new SettingsFormatError(
      "null lastTransaction is reserved for the exact canonical initial settings state"
    );
  }
}

function requireDocumentRevision(
  value: unknown,
  label: string,
  documents: Readonly<Record<string, SettingsDocumentV3>>
): number {
  const revision = requirePositiveSettingsInteger(value, label);
  if (!Object.hasOwn(documents, String(revision))) throw new SettingsFormatError(`${label} does not resolve`);
  return revision;
}

function nullableDocumentRevision(
  value: unknown,
  label: string,
  documents: Readonly<Record<string, SettingsDocumentV3>>
): number | null {
  return value === null ? null : requireDocumentRevision(value, label, documents);
}

function literalSchemaVersion(value: unknown): void {
  if (value !== 3) throw new SettingsFormatError("settings state.schemaVersion must be 3");
}
