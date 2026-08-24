import type {
  SettingsActivationErrorCodeV2,
  SettingsStateEnvelope,
  SettingsTransactionPointerV2
} from "../shared/settings-v2-types.js";
import type { CredentialBearingSettingsDocument } from "../shared/settings-credential-slots.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import {
  settingsStateRelation,
  type SettingsStateRelation
} from "./settings-state-validation.js";
import { canonicalJson } from "./canonical-json.js";

type UserSettingsPointer = Extract<SettingsTransactionPointerV2, { receiptKind: "user" }>;

export type SettingsStateEvent<D> =
  | {
      readonly kind: "save-document";
      readonly document: D;
      readonly lastTransaction: UserSettingsPointer;
    }
  | {
      readonly kind: "discard-pending";
      readonly lastTransaction: UserSettingsPointer;
    }
  | { readonly kind: "begin-validation"; readonly transactionId: string }
  | {
      readonly kind: "validation-failed";
      readonly errorCode: Extract<
        SettingsActivationErrorCodeV2,
        "candidate_invalid" | "credential_unresolved" | "activation_crashed"
      >;
    }
  | { readonly kind: "prepare" }
  | { readonly kind: "promote" }
  | { readonly kind: "commit" }
  | { readonly kind: "finish-commit" }
  | { readonly kind: "begin-rollback" }
  | {
      readonly kind: "finish-rollback";
      readonly errorCode: Exclude<SettingsActivationErrorCodeV2, "candidate_invalid" | "activation_crashed">;
    };

export interface SettingsStateReducerSchema<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
> {
  readonly parseState: (value: unknown) => SettingsStateEnvelope<V, D>;
  readonly parseDocument: (value: unknown) => D;
  readonly hashDocument: (document: D) => string;
}

export { settingsStateRelation };

export const SETTINGS_SAVE_ADMISSIBLE_RELATIONS: readonly SettingsStateRelation[] =
  ["clean", "staged"];

export function reduceSettingsState<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  input: SettingsStateEnvelope<V, D>,
  event: SettingsStateEvent<D>
): SettingsStateEnvelope<V, D> {
  const state = schema.parseState(input);
  switch (event.kind) {
    case "save-document":
      return saveDocument(schema, state, event.document, event.lastTransaction);
    case "discard-pending":
      return discardPending(schema, state, event.lastTransaction);
    case "begin-validation":
      return beginValidation(schema, state, event.transactionId);
    case "validation-failed":
      return finishValidationFailure(schema, state, event.errorCode);
    case "prepare":
      return prepare(schema, state);
    case "promote":
      return promote(schema, state);
    case "commit":
      return commit(schema, state);
    case "finish-commit":
      return finishCommit(schema, state);
    case "begin-rollback":
      return beginRollback(schema, state);
    case "finish-rollback":
      return finishRollback(schema, state, event.errorCode);
  }
}

export function recoverSettingsState<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  input: SettingsStateEnvelope<V, D>
): SettingsStateEnvelope<V, D> {
  let state = schema.parseState(input);
  for (let edge = 0; edge < 2; edge += 1) {
    const event = recoveryEventForSettingsState(state);
    if (event === null) return state;
    state = reduceSettingsState(schema, state, event);
  }
  if (recoveryEventForSettingsState(state) !== null) {
    throw new SettingsFormatError("settings recovery exceeded its two-edge bound");
  }
  return state;
}

export function recoveryEventForSettingsState<D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<2 | 3 | 4 | 5, D>
): SettingsStateEvent<D> | null {
  switch (settingsStateRelation(state)) {
    case "clean":
    case "staged":
      return null;
    case "validating":
      return { kind: "validation-failed", errorCode: "activation_crashed" };
    case "prepared":
    case "promoted":
      return { kind: "begin-rollback" };
    case "rolling-back":
      return { kind: "finish-rollback", errorCode: "readiness_failed" };
    case "committed":
      return { kind: "finish-commit" };
  }
}

export function isExactSettingsActivationSuccessorFor<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  input: SettingsStateEnvelope<V, D>,
  candidate: SettingsStateEnvelope<V, D>
): boolean {
  try {
    const state = schema.parseState(input);
    const next = schema.parseState(candidate);
    const event = activationSuccessorEvent(state, next);
    if (event === null) return false;
    return canonicalJson(reduceSettingsState(schema, state, event)) === canonicalJson(next);
  } catch {
    return false;
  }
}

function saveDocument<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>,
  rawDocument: D,
  pointer: UserSettingsPointer
): SettingsStateEnvelope<V, D> {
  requireRelation(state, SETTINGS_SAVE_ADMISSIBLE_RELATIONS, "save settings");
  const relation = settingsStateRelation(state);
  const document = schema.parseDocument(rawDocument);
  const active = documentAt(state, state.activeRevision);
  if (schema.hashDocument(active) === schema.hashDocument(document)) {
    if (relation === "staged") return discardPending(schema, state, pointer);
    throw new SettingsFormatError("settings document is unchanged");
  }
  const stateGeneration = increment(state.stateGeneration, "settings state generation");
  const revision = increment(state.settingsRevisionClock, "settings revision clock");
  const staged = settingsDocumentsChangeCredentialReferences(active, document);
  const next = schema.parseState({
    ...state,
    stateGeneration,
    settingsRevisionClock: revision,
    documents: staged
      ? { [String(state.activeRevision)]: active, [String(revision)]: document }
      : { [String(revision)]: document },
    activeRevision: staged ? state.activeRevision : revision,
    pendingRevision: staged ? revision : null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: null,
    lastTransaction: pointer
  });
  if (staged) preflightActivationPath(schema, next);
  return next;
}

function discardPending<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>,
  pointer: UserSettingsPointer
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "staged", "discard pending settings");
  return schema.parseState({
    ...state,
    stateGeneration: increment(state.stateGeneration, "settings state generation"),
    documents: { [String(state.activeRevision)]: documentAt(state, state.activeRevision) },
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: null,
    lastTransaction: pointer
  });
}

function beginValidation<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>,
  transactionId: string
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "staged", "begin settings validation");
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user" || pointer.mutationId !== transactionId) {
    throw new SettingsFormatError("settings validation transaction must match the staging receipt");
  }
  const candidateRevision = state.pendingRevision!;
  return nextInternal(schema, state, {
    activation: {
      transactionId,
      oldHash: schema.hashDocument(documentAt(state, state.activeRevision)),
      candidateHash: schema.hashDocument(documentAt(state, candidateRevision)),
      state: "validating",
      attempt: 1
    }
  });
}

function finishValidationFailure<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>,
  errorCode: Extract<
    SettingsActivationErrorCodeV2,
    "candidate_invalid" | "credential_unresolved" | "activation_crashed"
  >
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "validating", "finish settings validation failure");
  const generation = increment(state.stateGeneration, "settings state generation");
  const candidateRevision = state.pendingRevision!;
  return schema.parseState({
    ...state,
    stateGeneration: generation,
    activation: null,
    lastActivationOutcome: {
      transactionId: state.activation!.transactionId,
      candidateRevision,
      result: "validation-failed",
      errorCode,
      atStateGeneration: generation
    }
  });
}

function prepare<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "validating", "prepare settings activation");
  return nextInternal(schema, state, {
    previousRevision: state.activeRevision,
    activation: { ...state.activation!, state: "prepared" }
  });
}

function promote<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "prepared", "promote settings");
  return nextInternal(schema, state, {
    activeRevision: state.pendingRevision!,
    activation: { ...state.activation!, state: "promoted" }
  });
}

function commit<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "promoted", "commit settings activation");
  return nextInternal(schema, state, { activation: { ...state.activation!, state: "committed" } });
}

function finishCommit<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "committed", "finish settings commit");
  const generation = increment(state.stateGeneration, "settings state generation");
  const candidateRevision = state.activeRevision;
  return schema.parseState({
    ...state,
    stateGeneration: generation,
    documents: { [String(candidateRevision)]: documentAt(state, candidateRevision) },
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: {
      transactionId: state.activation!.transactionId,
      candidateRevision,
      result: "committed",
      errorCode: null,
      atStateGeneration: generation
    }
  });
}

function beginRollback<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>
): SettingsStateEnvelope<V, D> {
  requireRelation(state, ["prepared", "promoted"], "begin settings rollback");
  return nextInternal(schema, state, {
    activeRevision: state.previousRevision!,
    activation: { ...state.activation!, state: "rolling-back" }
  });
}

function finishRollback<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>,
  errorCode: Exclude<SettingsActivationErrorCodeV2, "candidate_invalid" | "activation_crashed">
): SettingsStateEnvelope<V, D> {
  requireRelation(state, "rolling-back", "finish settings rollback");
  const generation = increment(state.stateGeneration, "settings state generation");
  const candidateRevision = state.pendingRevision!;
  return schema.parseState({
    ...state,
    stateGeneration: generation,
    documents: { [String(state.activeRevision)]: documentAt(state, state.activeRevision) },
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: {
      transactionId: state.activation!.transactionId,
      candidateRevision,
      result: "rolled-back",
      errorCode,
      atStateGeneration: generation
    }
  });
}

function nextInternal<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  state: SettingsStateEnvelope<V, D>,
  patch: Partial<SettingsStateEnvelope<V, D>>
): SettingsStateEnvelope<V, D> {
  return schema.parseState({
    ...state,
    ...patch,
    stateGeneration: increment(state.stateGeneration, "settings state generation")
  });
}

function preflightActivationPath<
  V extends 2 | 3 | 4 | 5,
  D extends CredentialBearingSettingsDocument
>(
  schema: SettingsStateReducerSchema<V, D>,
  staged: SettingsStateEnvelope<V, D>
): void {
  const pointer = staged.lastTransaction;
  if (pointer?.receiptKind !== "user") throw new SettingsFormatError("staged settings pointer is invalid");
  const validating = beginValidation(schema, staged, pointer.mutationId);
  const prepared = prepare(schema, validating);
  const promoted = promote(schema, prepared);
  finishValidationFailure(schema, validating, "credential_unresolved");
  finishRollback(schema, beginRollback(schema, prepared), "readiness_failed");
  finishRollback(schema, beginRollback(schema, promoted), "readiness_failed");
  finishCommit(schema, commit(schema, promoted));
}

function activationSuccessorEvent<D extends CredentialBearingSettingsDocument>(
  state: SettingsStateEnvelope<2 | 3 | 4 | 5, D>,
  next: SettingsStateEnvelope<2 | 3 | 4 | 5, D>
): SettingsStateEvent<D> | null {
  const relation = settingsStateRelation(state);
  const nextRelation = settingsStateRelation(next);
  if (relation === "staged" && nextRelation === "validating") {
    const pointer = state.lastTransaction;
    return pointer?.receiptKind === "user"
      ? { kind: "begin-validation", transactionId: pointer.mutationId }
      : null;
  }
  if (relation === "validating") {
    if (nextRelation === "prepared") return { kind: "prepare" };
    return validationFailureEvent(next);
  }
  if (relation === "prepared") {
    if (nextRelation === "promoted") return { kind: "promote" };
    if (nextRelation === "rolling-back") return { kind: "begin-rollback" };
    return null;
  }
  if (relation === "promoted") {
    if (nextRelation === "committed") return { kind: "commit" };
    if (nextRelation === "rolling-back") return { kind: "begin-rollback" };
    return null;
  }
  if (relation === "rolling-back") return rollbackFinishedEvent(next);
  if (relation === "committed" && nextRelation === "clean") return { kind: "finish-commit" };
  return null;
}

function validationFailureEvent<D extends CredentialBearingSettingsDocument>(
  next: SettingsStateEnvelope<2 | 3 | 4 | 5, D>
): SettingsStateEvent<D> | null {
  if (settingsStateRelation(next) !== "staged"
    || next.lastActivationOutcome?.result !== "validation-failed") {
    return null;
  }
  switch (next.lastActivationOutcome.errorCode) {
    case "candidate_invalid":
    case "credential_unresolved":
    case "activation_crashed":
      return {
        kind: "validation-failed",
        errorCode: next.lastActivationOutcome.errorCode
      };
    default:
      return null;
  }
}

function rollbackFinishedEvent<D extends CredentialBearingSettingsDocument>(
  next: SettingsStateEnvelope<2 | 3 | 4 | 5, D>
): SettingsStateEvent<D> | null {
  if (settingsStateRelation(next) !== "clean"
    || next.lastActivationOutcome?.result !== "rolled-back") {
    return null;
  }
  switch (next.lastActivationOutcome.errorCode) {
    case "credential_unresolved":
    case "activation_failed":
    case "readiness_failed":
      return {
        kind: "finish-rollback",
        errorCode: next.lastActivationOutcome.errorCode
      };
    default:
      return null;
  }
}

export function settingsDocumentsChangeCredentialReferences(
  active: CredentialBearingSettingsDocument,
  candidate: CredentialBearingSettingsDocument
): boolean {
  return canonicalJson(credentialProjection(active)) !== canonicalJson(credentialProjection(candidate));
}

function credentialProjection(document: CredentialBearingSettingsDocument): unknown {
  return Object.fromEntries(Object.entries(document.connections).map(([id, connection]) => [
    id,
    { auth: connection.auth, headers: connection.headers }
  ]));
}

function documentAt<D>(
  state: SettingsStateEnvelope<2 | 3 | 4 | 5, D>,
  revision: number
): D {
  const document = state.documents[String(revision)];
  if (document === undefined) throw new SettingsFormatError(`settings revision ${revision} does not resolve`);
  return document;
}

function requireRelation(
  state: SettingsStateEnvelope<2 | 3 | 4 | 5, CredentialBearingSettingsDocument>,
  expected: SettingsStateRelation | readonly SettingsStateRelation[],
  operation: string
): void {
  const admissible = typeof expected === "string" ? [expected] : expected;
  const actual = settingsStateRelation(state);
  if (!admissible.includes(actual)) {
    throw new SettingsFormatError(
      `${operation} requires ${admissible.join(" or ")} settings state, not ${actual}`
    );
  }
}

function increment(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new SettingsFormatError(`${label} overflow`);
  return value + 1;
}
