import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderHeaders } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import { readSettingsState } from "../server/settings-state-file.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  credentialedDocument,
  hasServiceCode,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";

test("a credential save activates in-process and generation uses the new credentials", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-activate-");
  const probed: string[] = [];
  const store = new SettingsStore(dataDir, {
    environment: { AI_1667_IN_PROCESS_KEY: "in-process-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async (settings) => {
      probed.push(settings.baseUrl);
      return true;
    }
  });
  await store.init(2);

  const saved = await store.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_IN_PROCESS_KEY")
  ));
  assert.equal(saved.pendingSettingsRevision, 2, "the durable receipt records the staging edge");
  assert.deepEqual(probed, ["https://api.openai.com/v1"], "the save request runs the probe");

  const view = await store.loadView();
  assert.equal(view.activeRevision, 2, "no restart is required");
  assert.equal(view.pendingRevision, null);
  assert.equal(view.effective.provider, "openai-compatible");
  assert.deepEqual(view.lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "committed",
    errorCode: null,
    atStateGeneration: 7
  });

  const generation = await store.loadGeneration();
  assert.equal(generation.settings.model, "test-model");
  assert.equal(
    resolveProviderHeaders(generation.settings, {}).headers.authorization,
    "Bearer in-process-secret",
    "generation resolves the newly activated credential"
  );
});

test("a failed probe keeps the candidate staged with a surfaced outcome, and a retry save activates", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-failed-probe-");
  let providerReady = false;
  const store = new SettingsStore(dataDir, {
    environment: { AI_1667_RETRY_KEY: "retry-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => providerReady
  });
  await store.init(2);
  const candidate = credentialedDocument("AI_1667_RETRY_KEY");

  await store.save(saveCommand(MUTATION_A, 1, candidate));

  const view = await store.loadView();
  if (view.document === null) throw new Error("format-2 settings document is missing");
  assert.equal(view.pendingRevision, 2, "the rejected candidate is not discarded");
  assert.equal(view.activeRevision, 1, "the old active document keeps running");
  assert.equal(view.effective.provider, "dry-run");
  assert.equal(
    view.document.connections["builtin:dry-run"]?.auth.type,
    "bearer-env",
    "the view shows the staged candidate for editing"
  );
  assert.deepEqual(view.lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "validation-failed",
    errorCode: "candidate_invalid",
    atStateGeneration: 4
  });

  providerReady = true;
  const retried: SettingsDocumentV2 = {
    ...candidate,
    writing: { defaultAuthorBrief: "Retried after the provider recovered." }
  };
  await store.save(saveCommand(MUTATION_B, view.stateGeneration!, retried));

  const activated = await store.loadView();
  assert.equal(activated.activeRevision, 3, "the retry save replaces the candidate and activates");
  assert.equal(activated.pendingRevision, null);
  assert.equal(activated.effective.provider, "openai-compatible");
  assert.equal(activated.lastActivationOutcome?.result, "committed");
  assert.equal(activated.lastActivationOutcome?.transactionId, MUTATION_B);
});

test("startup recovers a leftover staged document without a silent discard", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-leftover-");
  // recover-only staging is the analog of a save interrupted before its
  // in-process activation could run.
  const interrupted = new SettingsStore(dataDir, {
    activationMode: "recover-only",
    environment: {},
    now: () => FIXED_TIME
  });
  await interrupted.init(2);
  await interrupted.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_LEFTOVER_KEY")
  ));

  const failingLaunch = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await failingLaunch.init(2);
  const failedView = await failingLaunch.loadView();
  assert.equal(failedView.pendingRevision, 2, "startup recovery keeps the candidate staged");
  assert.equal(failedView.activeRevision, 1);
  assert.deepEqual(failedView.lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "validation-failed",
    errorCode: "credential_unresolved",
    atStateGeneration: 4
  });

  const recoveredLaunch = new SettingsStore(dataDir, {
    environment: { AI_1667_LEFTOVER_KEY: "leftover-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await recoveredLaunch.init(2);
  const recoveredView = await recoveredLaunch.loadView();
  assert.equal(recoveredView.activeRevision, 2);
  assert.equal(recoveredView.pendingRevision, null);
  assert.equal(recoveredView.lastActivationOutcome?.result, "committed");
});

test("a common launch with no staged document performs no provider probe", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-clean-launch-");
  const first = new SettingsStore(dataDir, {
    environment: { AI_1667_CLEAN_LAUNCH_KEY: "clean-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await first.init(2);
  await first.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_CLEAN_LAUNCH_KEY")
  ));
  assert.equal((await first.loadView()).pendingRevision, null);

  const relaunched = new SettingsStore(dataDir, {
    environment: { AI_1667_CLEAN_LAUNCH_KEY: "clean-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      throw new Error("a clean launch must not probe the provider");
    }
  });
  await relaunched.init(2);
  assert.equal((await relaunched.loadView()).activeRevision, 2);
});

test("a saved-but-unactivated credential target stays testable; unsaved targets still require a save", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-staged-probe-");
  const store = new SettingsStore(dataDir, {
    environment: { AI_1667_STAGED_PROBE_KEY: "staged-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => false
  });
  await store.init(2);
  const candidate = credentialedDocument("AI_1667_STAGED_PROBE_KEY");
  await store.save(saveCommand(MUTATION_A, 1, candidate));
  assert.equal(
    (await readSettingsState(dataDir)).pendingRevision,
    2,
    "the probe target below is the staged, not yet activated candidate"
  );

  const probe = await store.resolveProviderProbe({
    kind: "settings-document",
    document: candidate,
    purpose: "default"
  });
  assert.equal(probe.baseUrl, "https://api.openai.com/v1");
  assert.equal(probe.apiKeyEnv, "AI_1667_STAGED_PROBE_KEY");

  await assert.rejects(
    store.resolveProviderProbe({
      kind: "settings-document",
      document: credentialedDocument("AI_1667_NEVER_SAVED_KEY"),
      purpose: "default"
    }),
    hasServiceCode("credential_test_requires_activation")
  );
});
