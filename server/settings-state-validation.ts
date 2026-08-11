import {
  type SettingsActivationOutcomeV2,
  type SettingsActivationV2,
  type SettingsStateEnvelope,
  type SettingsTransactionPointerV2
} from "../shared/settings-v2-types.js";
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
  parseTransactionPointer
} from "./settings-state-scalars.js";
import { type SettingsValidationOptions } from "./settings-v2-validation.js";
import { canonicalJson } from "./canonical-json.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import {
  MAX_CREDENTIAL_NAMES_PER_STATE
} from "../shared/credential-slot-policy.js";
import {
  settingsStateCredentialNames,
  type CredentialBearingSettingsDocument
} from "../shared/settings-credential-slots.js";

const STATE = closedShape([
  "schemaVersion", "stateGeneration", "settingsRevisionClock", "documents", "activeRevision",
  "pendingRevision", "previousRevision", "activation", "lastActivationOutcome", "lastTransaction"
]);

export type SettingsStateRelation =
  | "clean"
  | "staged"
  | "validating"
  | "prepared"
  | "promoted"
  | "rolling-back"
  | "committed";

/**
 * What one settings schema version supplies to the shared state engine
 * below: how to validate and hash its document, and the hash of the exact
 * canonical initial document. Every other rule in `validateSettingsState`
 * reads no document-version-specific field at all, so it runs unchanged for
 * schema 2 (`server/settings-v2-state-validation.ts`) and schema 3
 * (`server/settings-v3-state-validation.ts`).
 */
export interface SettingsStateSchema<V extends 2 | 3, D extends CredentialBearingSettingsDocument> {
  readonly schemaVersion: V;
  readonly validateDocument: (value: unknown, options: SettingsValidationOptions) => D;
  readonly hashDocument: (document: D) => string;
  readonly initialDocumentHash: string;
}

/** The one settings-state validator, for any schema version whose document
 *  type and document hash are supplied through `schema`. This replaced two
 *  near-identical ~250-line copies, one per schema version: every rule here
 *  used to read no version-specific field at all except for which document
 *  validator and hash to call. */
export function validateSettingsState<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  value: unknown,
  schema: SettingsStateSchema<V, D>,
  options: SettingsValidationOptions = {}
): SettingsStateEnvelope<V, D> {
  const root = closedRecord(value, "settings state", STATE);
  literal(root.schemaVersion, schema.schemaVersion, "settings state.schemaVersion");
  const stateGeneration = requirePositiveSettingsInteger(root.stateGeneration, "settings state.stateGeneration");
  const settingsRevisionClock = requirePositiveSettingsInteger(
    root.settingsRevisionClock,
    "settings state.settingsRevisionClock"
  );
  if (stateGeneration < settingsRevisionClock) {
    throw new SettingsFormatError("settings state.stateGeneration must not trail settingsRevisionClock");
  }
  const documents = parseDocuments(root.documents, settingsRevisionClock, schema, options);
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
  const state: SettingsStateEnvelope<V, D> = {
    schemaVersion: schema.schemaVersion,
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
  validateActivationBinding(state, relation, schema.hashDocument);
  validateTransactionBinding(state, relation);
  validateInitialNullPointer(state, relation, schema.hashDocument, schema.initialDocumentHash);
  if (settingsStateCredentialNames(state).length
    > MAX_CREDENTIAL_NAMES_PER_STATE) {
    throw new SettingsFormatError(
      `settings state exceeds the ${MAX_CREDENTIAL_NAMES_PER_STATE}-credential-name limit`
    );
  }
  return state;
}

export function settingsStateRelation<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<V, D>
): SettingsStateRelation {
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

function parseDocuments<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  value: unknown,
  clock: number,
  schema: SettingsStateSchema<V, D>,
  options: SettingsValidationOptions
): Record<string, D> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError("settings state.documents must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 2) {
    throw new SettingsFormatError("settings state.documents must contain one or two entries");
  }
  const result: Record<string, D> = {};
  const hashes = new Set<string>();
  for (const [key, raw] of entries) {
    const revision = parseRevisionKey(key);
    if (revision > clock) throw new SettingsFormatError(`settings document revision ${key} exceeds the clock`);
    const document = schema.validateDocument(raw, options);
    const bytes = Buffer.byteLength(canonicalJson(document), "utf8");
    if (bytes > MAX_SETTINGS_DOCUMENT_BYTES) {
      throw new SettingsFormatError(
        `settings document revision ${key} exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte limit`
      );
    }
    const hash = schema.hashDocument(document);
    if (hashes.has(hash)) throw new SettingsFormatError("settings state contains byte-identical document revisions");
    hashes.add(hash);
    result[key] = document;
  }
  return result;
}

function validateRoleDocuments<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<V, D>,
  relation: SettingsStateRelation
): void {
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

function validateActivationBinding<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<V, D>,
  relation: SettingsStateRelation,
  hashDocument: (document: D) => string
): void {
  if (state.activation === null) return;
  const oldRevision = relation === "promoted" || relation === "committed"
    ? state.previousRevision!
    : state.activeRevision;
  const oldDocument = state.documents[String(oldRevision)]!;
  const candidateDocument = state.documents[String(state.pendingRevision!)]!;
  if (state.activation.oldHash !== hashDocument(oldDocument)) {
    throw new SettingsFormatError("settings activation oldHash does not bind its old document");
  }
  if (state.activation.candidateHash !== hashDocument(candidateDocument)) {
    throw new SettingsFormatError("settings activation candidateHash does not bind its candidate document");
  }
  if (state.activation.oldHash === state.activation.candidateHash) {
    throw new SettingsFormatError("settings activation old and candidate hashes must differ");
  }
}

function validateTransactionBinding<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<V, D>,
  relation: SettingsStateRelation
): void {
  if (relation === "clean") return;
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user") {
    throw new SettingsFormatError("non-clean settings state requires its user staging receipt pointer");
  }
  if (state.activation !== null && state.activation.transactionId !== pointer.mutationId) {
    throw new SettingsFormatError("settings activation transaction does not match its staging receipt");
  }
}

function validateInitialNullPointer<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<V, D>,
  relation: SettingsStateRelation,
  hashDocument: (document: D) => string,
  initialDocumentHash: string
): void {
  if (state.lastTransaction !== null) return;
  if (
    relation !== "clean"
    || state.stateGeneration !== 1
    || state.settingsRevisionClock !== 1
    || state.activeRevision !== 1
    || state.lastActivationOutcome !== null
    || hashDocument(state.documents["1"]!) !== initialDocumentHash
  ) {
    throw new SettingsFormatError(
      "null lastTransaction is reserved for the exact canonical initial settings state"
    );
  }
}

/** Version-free: the fixed-envelope byte bound applies to any settings
 *  state, whichever document version it carries. */
export function settingsStateEnvelopeBytes<V extends 2 | 3, D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<V, D>
): number {
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

function requireDocumentRevision<D>(
  value: unknown,
  label: string,
  documents: Readonly<Record<string, D>>
): number {
  const revision = requirePositiveSettingsInteger(value, label);
  if (!Object.hasOwn(documents, String(revision))) throw new SettingsFormatError(`${label} does not resolve`);
  return revision;
}

function nullableDocumentRevision<D>(
  value: unknown,
  label: string,
  documents: Readonly<Record<string, D>>
): number | null {
  return value === null ? null : requireDocumentRevision(value, label, documents);
}
