import type {
  SettingsActivationErrorCodeV2,
  SettingsDocumentV2,
  SettingsStateV2,
  SettingsTransactionPointerV2
} from "../shared/settings-v2-types.js";
import {
  hashSettingsDocumentV2,
  parseSettingsDocumentV2,
  parseSettingsStateV2
} from "./settings-v2-codec.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import {
  settingsStateRelation,
  type SettingsStateRelation
} from "./settings-v2-state-validation.js";
import { canonicalJson } from "./canonical-json.js";

type UserSettingsPointer = Extract<SettingsTransactionPointerV2, { receiptKind: "user" }>;

export type SettingsStateV2Event =
  | {
      readonly kind: "save-document";
      readonly document: SettingsDocumentV2;
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

export { settingsStateRelation };

export function reduceSettingsStateV2(
  input: SettingsStateV2,
  event: SettingsStateV2Event
): SettingsStateV2 {
  const state = parseSettingsStateV2(input);
  switch (event.kind) {
    case "save-document": return saveDocument(state, event.document, event.lastTransaction);
    case "discard-pending": return discardPending(state, event.lastTransaction);
    case "begin-validation": return beginValidation(state, event.transactionId);
    case "validation-failed": return finishValidationFailure(state, event.errorCode);
    case "prepare": return prepare(state);
    case "promote": return promote(state);
    case "commit": return commit(state);
    case "finish-commit": return finishCommit(state);
    case "begin-rollback": return beginRollback(state);
    case "finish-rollback": return finishRollback(state, event.errorCode);
  }
}

/** One deterministic recovery edge. null means no automatic state transition:
 * clean is ready; staged waits for an activation-capable host. */
export function recoveryEventForSettingsStateV2(state: SettingsStateV2): SettingsStateV2Event | null {
  switch (settingsStateRelation(parseSettingsStateV2(state))) {
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

/** Apply recovery until its bounded fixed point. Staged remains staged. */
export function recoverSettingsStateV2(input: SettingsStateV2): SettingsStateV2 {
  let state = parseSettingsStateV2(input);
  for (let edge = 0; edge < 2; edge += 1) {
    const event = recoveryEventForSettingsStateV2(state);
    if (event === null) return state;
    state = reduceSettingsStateV2(state, event);
  }
  if (recoveryEventForSettingsStateV2(state) !== null) {
    throw new SettingsFormatError("settings recovery exceeded its two-edge bound");
  }
  return state;
}

/**
 * Proves that `candidate` is exactly one receipt-free activation edge after
 * `input`. The candidate may select an allowed terminal error, but it cannot
 * skip an edge or change any field outside the reducer's transition.
 */
export function isExactSettingsActivationSuccessor(
  input: SettingsStateV2,
  candidate: SettingsStateV2
): boolean {
  try {
    const state = parseSettingsStateV2(input);
    const next = parseSettingsStateV2(candidate);
    const event = activationSuccessorEvent(state, next);
    if (event === null) return false;
    return canonicalJson(reduceSettingsStateV2(state, event)) === canonicalJson(next);
  } catch {
    return false;
  }
}

export function settingsDocumentsChangeCredentialReferences(
  active: SettingsDocumentV2,
  candidate: SettingsDocumentV2
): boolean {
  return canonicalJson(credentialProjection(active)) !== canonicalJson(credentialProjection(candidate));
}

function saveDocument(
  state: SettingsStateV2,
  rawDocument: SettingsDocumentV2,
  pointer: UserSettingsPointer
): SettingsStateV2 {
  requireRelation(state, "clean", "save settings");
  const document = parseSettingsDocumentV2(rawDocument);
  const active = documentAt(state, state.activeRevision);
  if (hashSettingsDocumentV2(active) === hashSettingsDocumentV2(document)) {
    throw new SettingsFormatError("settings document is unchanged");
  }
  const stateGeneration = increment(state.stateGeneration, "settings state generation");
  const revision = increment(state.settingsRevisionClock, "settings revision clock");
  const staged = settingsDocumentsChangeCredentialReferences(active, document);
  const next = parseSettingsStateV2({
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
    lastTransaction: pointer
  });
  if (staged) preflightActivationPath(next);
  return next;
}

function discardPending(state: SettingsStateV2, pointer: UserSettingsPointer): SettingsStateV2 {
  requireRelation(state, "staged", "discard pending settings");
  return parseSettingsStateV2({
    ...state,
    stateGeneration: increment(state.stateGeneration, "settings state generation"),
    documents: { [String(state.activeRevision)]: documentAt(state, state.activeRevision) },
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastTransaction: pointer
  });
}

function beginValidation(state: SettingsStateV2, transactionId: string): SettingsStateV2 {
  requireRelation(state, "staged", "begin settings validation");
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user" || pointer.mutationId !== transactionId) {
    throw new SettingsFormatError("settings validation transaction must match the staging receipt");
  }
  const candidateRevision = state.pendingRevision!;
  return nextInternal(state, {
    activation: {
      transactionId,
      oldHash: hashSettingsDocumentV2(documentAt(state, state.activeRevision)),
      candidateHash: hashSettingsDocumentV2(documentAt(state, candidateRevision)),
      state: "validating",
      attempt: 1
    }
  });
}

function finishValidationFailure(
  state: SettingsStateV2,
  errorCode: Extract<
    SettingsActivationErrorCodeV2,
    "candidate_invalid" | "credential_unresolved" | "activation_crashed"
  >
): SettingsStateV2 {
  requireRelation(state, "validating", "finish settings validation failure");
  const generation = increment(state.stateGeneration, "settings state generation");
  const candidateRevision = state.pendingRevision!;
  return parseSettingsStateV2({
    ...state,
    stateGeneration: generation,
    documents: { [String(state.activeRevision)]: documentAt(state, state.activeRevision) },
    pendingRevision: null,
    previousRevision: null,
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

function prepare(state: SettingsStateV2): SettingsStateV2 {
  requireRelation(state, "validating", "prepare settings activation");
  return nextInternal(state, {
    previousRevision: state.activeRevision,
    activation: { ...state.activation!, state: "prepared" }
  });
}

function promote(state: SettingsStateV2): SettingsStateV2 {
  requireRelation(state, "prepared", "promote settings");
  return nextInternal(state, {
    activeRevision: state.pendingRevision!,
    activation: { ...state.activation!, state: "promoted" }
  });
}

function commit(state: SettingsStateV2): SettingsStateV2 {
  requireRelation(state, "promoted", "commit settings activation");
  return nextInternal(state, { activation: { ...state.activation!, state: "committed" } });
}

function finishCommit(state: SettingsStateV2): SettingsStateV2 {
  requireRelation(state, "committed", "finish settings commit");
  const generation = increment(state.stateGeneration, "settings state generation");
  const candidateRevision = state.activeRevision;
  return parseSettingsStateV2({
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

function beginRollback(state: SettingsStateV2): SettingsStateV2 {
  const relation = settingsStateRelation(state);
  if (relation !== "prepared" && relation !== "promoted") {
    throw new SettingsFormatError(`begin settings rollback requires prepared or promoted, not ${relation}`);
  }
  return nextInternal(state, {
    activeRevision: state.previousRevision!,
    activation: { ...state.activation!, state: "rolling-back" }
  });
}

function finishRollback(
  state: SettingsStateV2,
  errorCode: Exclude<SettingsActivationErrorCodeV2, "candidate_invalid" | "activation_crashed">
): SettingsStateV2 {
  requireRelation(state, "rolling-back", "finish settings rollback");
  const generation = increment(state.stateGeneration, "settings state generation");
  const candidateRevision = state.pendingRevision!;
  return parseSettingsStateV2({
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

function nextInternal(
  state: SettingsStateV2,
  patch: Partial<SettingsStateV2>
): SettingsStateV2 {
  return parseSettingsStateV2({
    ...state,
    ...patch,
    stateGeneration: increment(state.stateGeneration, "settings state generation")
  });
}

function preflightActivationPath(staged: SettingsStateV2): void {
  const pointer = staged.lastTransaction;
  if (pointer?.receiptKind !== "user") throw new SettingsFormatError("staged settings pointer is invalid");
  const validating = beginValidation(staged, pointer.mutationId);
  const prepared = prepare(validating);
  const promoted = promote(prepared);
  finishValidationFailure(validating, "credential_unresolved");
  finishRollback(beginRollback(prepared), "readiness_failed");
  finishRollback(beginRollback(promoted), "readiness_failed");
  finishCommit(commit(promoted));
}

function activationSuccessorEvent(
  state: SettingsStateV2,
  next: SettingsStateV2
): SettingsStateV2Event | null {
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

function validationFailureEvent(next: SettingsStateV2): SettingsStateV2Event | null {
  if (settingsStateRelation(next) !== "clean"
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

function rollbackFinishedEvent(next: SettingsStateV2): SettingsStateV2Event | null {
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

function credentialProjection(document: SettingsDocumentV2): unknown {
  return Object.fromEntries(Object.entries(document.connections).map(([id, connection]) => [
    id,
    { auth: connection.auth, headers: connection.headers }
  ]));
}

function documentAt(state: SettingsStateV2, revision: number): SettingsDocumentV2 {
  const document = state.documents[String(revision)];
  if (document === undefined) throw new SettingsFormatError(`settings revision ${revision} does not resolve`);
  return document;
}

function requireRelation(
  state: SettingsStateV2,
  expected: SettingsStateRelation,
  operation: string
): void {
  const actual = settingsStateRelation(state);
  if (actual !== expected) {
    throw new SettingsFormatError(`${operation} requires ${expected} settings state, not ${actual}`);
  }
}

function increment(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new SettingsFormatError(`${label} overflow`);
  return value + 1;
}
