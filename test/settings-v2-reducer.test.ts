import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEffectiveGenerationSettings,
  effectiveGenerationSettings
} from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_STATE_V2
} from "../server/settings-v2-default.js";
import {
  recoverSettingsStateV2,
  recoveryEventForSettingsStateV2,
  reduceSettingsStateV2,
  settingsDocumentsChangeCredentialReferences,
  settingsStateRelation
} from "../server/settings-v2-reducer.js";
import { parseSettingsStateV2 } from "../server/settings-v2-codec.js";
import type {
  SettingsDocumentV2,
  SettingsStateV2
} from "../shared/settings-v2-types.js";
import {
  settingsStateCredentialNames,
  settingsStateEnvironmentCredentialNames
} from "../shared/settings-credential-slots.js";

const MUTATION_A = `m1.1767225600000.${"a".repeat(32)}`;
const MUTATION_B = `m1.1767225600001.${"b".repeat(32)}`;
const POINTER_A = { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" } as const;
const POINTER_B = { receiptKind: "user", mutationId: MUTATION_B, phase: "prepared" } as const;

test("non-credential edit replaces active immediately and advances each counter once", () => {
  const document = applyEffectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...effectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2),
    systemPrompt: "A changed writing brief."
  });
  const state = reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
    kind: "save-document",
    document,
    lastTransaction: POINTER_A
  });
  assert.equal(settingsStateRelation(state), "clean");
  assert.equal(state.stateGeneration, 2);
  assert.equal(state.settingsRevisionClock, 2);
  assert.equal(state.activeRevision, 2);
  assert.equal(state.pendingRevision, null);
  assert.deepEqual(Object.keys(state.documents), ["2"]);
  assert.deepEqual(state.lastTransaction, POINTER_A);
});

test("credential edit stages one candidate and a later save replaces it in place", () => {
  const candidate = credentialedDocument();
  assert.equal(
    settingsDocumentsChangeCredentialReferences(INITIAL_SETTINGS_DOCUMENT_V2, candidate),
    true
  );
  const staged = stage(candidate);
  assert.equal(settingsStateRelation(staged), "staged");
  assert.equal(staged.activeRevision, 1);
  assert.equal(staged.pendingRevision, 2);
  assert.deepEqual(Object.keys(staged.documents), ["1", "2"]);

  const replaced = reduceSettingsStateV2(staged, {
    kind: "save-document",
    document: { ...candidate, writing: { defaultAuthorBrief: "Later edit." } },
    lastTransaction: POINTER_B
  });
  assert.equal(settingsStateRelation(replaced), "staged");
  assert.equal(replaced.activeRevision, 1);
  assert.equal(replaced.pendingRevision, 3);
  assert.deepEqual(Object.keys(replaced.documents), ["1", "3"]);
  assert.deepEqual(replaced.lastTransaction, POINTER_B);

  const reverted = reduceSettingsStateV2(staged, {
    kind: "save-document",
    document: writingDocumentV2("Reverted to credential-free settings."),
    lastTransaction: POINTER_B
  });
  assert.equal(settingsStateRelation(reverted), "clean");
  assert.equal(reverted.activeRevision, 3);
  assert.deepEqual(Object.keys(reverted.documents), ["3"]);
});

test("activation follows the exhaustive role matrix without renumbering documents", () => {
  const staged = stage(credentialedDocument());
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const committed = reduceSettingsStateV2(promoted, { kind: "commit" });
  for (const [state, relation, generation] of [
    [staged, "staged", 2],
    [validating, "validating", 3],
    [prepared, "prepared", 4],
    [promoted, "promoted", 5],
    [committed, "committed", 6]
  ] as const) {
    assert.equal(settingsStateRelation(state), relation);
    assert.equal(state.stateGeneration, generation);
    assert.equal(state.settingsRevisionClock, 2);
    assert.deepEqual(Object.keys(state.documents), ["1", "2"]);
  }
  const clean = reduceSettingsStateV2(committed, { kind: "finish-commit" });
  assert.equal(settingsStateRelation(clean), "clean");
  assert.equal(clean.stateGeneration, 7);
  assert.equal(clean.activeRevision, 2);
  assert.deepEqual(Object.keys(clean.documents), ["2"]);
  assert.deepEqual(clean.lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "committed",
    errorCode: null,
    atStateGeneration: 7
  });
});

test("validation failure keeps the candidate staged and rollback restores the old active document", () => {
  const staged = stage(credentialedDocument());
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  const failed = reduceSettingsStateV2(validating, {
    kind: "validation-failed",
    errorCode: "credential_unresolved"
  });
  assert.equal(settingsStateRelation(failed), "staged");
  assert.equal(failed.activeRevision, 1);
  assert.equal(failed.pendingRevision, 2, "the rejected candidate is never discarded silently");
  assert.deepEqual(Object.keys(failed.documents), ["1", "2"]);
  assert.equal(failed.settingsRevisionClock, 2, "failed candidate revision is never reused");
  assert.equal(failed.lastActivationOutcome?.result, "validation-failed");
  assert.equal(failed.lastActivationOutcome?.errorCode, "credential_unresolved");

  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const rolling = reduceSettingsStateV2(promoted, { kind: "begin-rollback" });
  assert.equal(settingsStateRelation(rolling), "rolling-back");
  assert.equal(rolling.activeRevision, 1);
  const rolledBack = reduceSettingsStateV2(rolling, {
    kind: "finish-rollback",
    errorCode: "readiness_failed"
  });
  assert.equal(settingsStateRelation(rolledBack), "clean");
  assert.equal(rolledBack.activeRevision, 1);
  assert.deepEqual(Object.keys(rolledBack.documents), ["1"]);
  assert.equal(rolledBack.lastActivationOutcome?.result, "rolled-back");
});

test("discard removes only the pending candidate and records a second receipt pointer", () => {
  const staged = stage(credentialedDocument());
  const discarded = reduceSettingsStateV2(staged, {
    kind: "discard-pending",
    lastTransaction: POINTER_B
  });
  assert.equal(settingsStateRelation(discarded), "clean");
  assert.equal(discarded.activeRevision, 1);
  assert.equal(discarded.settingsRevisionClock, 2);
  assert.equal(discarded.stateGeneration, 3);
  assert.deepEqual(discarded.lastTransaction, POINTER_B);
});

test("recovery is deterministic, bounded, and never retries a staged candidate", () => {
  const staged = stage(credentialedDocument());
  assert.equal(recoveryEventForSettingsStateV2(staged), null);
  assert.deepEqual(recoverSettingsStateV2(staged), staged);
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  const recoveredValidation = recoverSettingsStateV2(validating);
  assert.equal(settingsStateRelation(recoveredValidation), "staged");
  assert.equal(recoveredValidation.pendingRevision, 2, "an interrupted validation keeps its candidate");
  assert.equal(recoveredValidation.lastActivationOutcome?.errorCode, "activation_crashed");

  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const recoveredPrepared = recoverSettingsStateV2(prepared);
  assert.equal(settingsStateRelation(recoveredPrepared), "clean");
  assert.equal(recoveredPrepared.activeRevision, 1);
  assert.equal(recoveredPrepared.lastActivationOutcome?.errorCode, "readiness_failed");

  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const committed = reduceSettingsStateV2(promoted, { kind: "commit" });
  const recoveredCommitted = recoverSettingsStateV2(committed);
  assert.equal(settingsStateRelation(recoveredCommitted), "clean");
  assert.equal(recoveredCommitted.activeRevision, 2);
  assert.equal(recoveredCommitted.lastActivationOutcome?.result, "committed");
});

test("promoted settings retain credentials needed for rollback", () => {
  const oldStaged = stage(credentialedDocument("OLD_PROVIDER_KEY"));
  const oldPromoted = reduceSettingsStateV2(
    reduceSettingsStateV2(
      reduceSettingsStateV2(oldStaged, {
        kind: "begin-validation",
        transactionId: MUTATION_A
      }),
      { kind: "prepare" }
    ),
    { kind: "promote" }
  );
  const oldClean = recoverSettingsStateV2(
    reduceSettingsStateV2(oldPromoted, { kind: "commit" })
  );
  const candidate = reduceSettingsStateV2(oldClean, {
    kind: "save-document",
    document: credentialedDocument("NEW_PROVIDER_KEY"),
    lastTransaction: POINTER_B
  });
  const promoted = reduceSettingsStateV2(
    reduceSettingsStateV2(
      reduceSettingsStateV2(candidate, {
        kind: "begin-validation",
        transactionId: MUTATION_B
      }),
      { kind: "prepare" }
    ),
    { kind: "promote" }
  );

  assert.deepEqual(settingsStateCredentialNames(promoted), [
    "NEW_PROVIDER_KEY",
    "OLD_PROVIDER_KEY"
  ]);
});

test("stored credential IDs count toward state bounds but never become environment requests", () => {
  const document = credentialedDocument("STORED_PLACEHOLDER");
  const connection = document.connections["builtin:dry-run"]!;
  const staged = stage({
    ...document,
    connections: {
      ...document.connections,
      "builtin:dry-run": {
        ...connection,
        auth: { type: "bearer-stored", secretId: "builtin:dry-run" }
      }
    }
  });

  assert.deepEqual(settingsStateCredentialNames(staged), ["stored:builtin:dry-run"]);
  assert.deepEqual(settingsStateEnvironmentCredentialNames(staged), []);
});

test("parser rejects every malformed role/hash/pointer relation", () => {
  const staged = stage(credentialedDocument());
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  for (const state of [
    {
      ...INITIAL_SETTINGS_STATE_V2,
      documents: {
        "1": {
          ...INITIAL_SETTINGS_DOCUMENT_V2,
          writing: { defaultAuthorBrief: "Counterfeit initial document." }
        }
      }
    },
    { ...staged, previousRevision: 1 },
    { ...staged, activeRevision: 2 },
    { ...staged, documents: { ...staged.documents, "3": staged.documents["2"] } },
    { ...validating, activation: { ...validating.activation!, candidateHash: "f".repeat(64) } },
    { ...validating, lastTransaction: POINTER_B },
    { ...validating, settingsRevisionClock: 1 }
  ]) {
    assert.throws(() => parseSettingsStateV2(state));
  }
});

test("counter overflow rejects before allocating a revision or generation", () => {
  const direct = reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
    kind: "save-document",
    document: {
      ...INITIAL_SETTINGS_DOCUMENT_V2,
      writing: { defaultAuthorBrief: "First edit." }
    },
    lastTransaction: POINTER_A
  });
  const overflowGeneration = parseSettingsStateV2({
    ...direct,
    stateGeneration: Number.MAX_SAFE_INTEGER
  });
  assert.throws(() => reduceSettingsStateV2(overflowGeneration, {
    kind: "save-document",
    document: {
      ...direct.documents["2"]!,
      writing: { defaultAuthorBrief: "Second edit." }
    },
    lastTransaction: POINTER_B
  }), /overflow/);
  const overflowClock = parseSettingsStateV2({
    ...direct,
    stateGeneration: Number.MAX_SAFE_INTEGER,
    settingsRevisionClock: Number.MAX_SAFE_INTEGER
  });
  assert.throws(() => reduceSettingsStateV2(overflowClock, {
    kind: "save-document",
    document: {
      ...direct.documents["2"]!,
      writing: { defaultAuthorBrief: "Second edit." }
    },
    lastTransaction: POINTER_B
  }), /overflow/);
});

function stage(document: SettingsDocumentV2): SettingsStateV2 {
  return reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
    kind: "save-document",
    document,
    lastTransaction: POINTER_A
  });
}

function writingDocumentV2(brief: string): SettingsDocumentV2 {
  return {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    writing: { defaultAuthorBrief: brief }
  };
}

function credentialedDocument(
  apiKeyEnv = "OPENAI_API_KEY"
): SettingsDocumentV2 {
  return applyEffectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...effectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "test-model",
    apiKeyEnv
  });
}
