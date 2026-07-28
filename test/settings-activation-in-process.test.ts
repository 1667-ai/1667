import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SETTINGS_STATE_V2_NEXT_FILE } from "../server/data-directory-layout.js";
import { readProviderSecrets } from "../server/provider-secret-store.js";
import { resolveProviderHeaders } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import { effectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { reduceSettingsStateV2 } from "../server/settings-v2-reducer.js";
import {
  activeSettingsDocument,
  settingsViewFromState
} from "../server/settings-v2-runtime.js";
import { readSettingsState } from "../server/settings-state-file.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  changedState,
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
  assert.deepEqual(saved.activationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "committed",
    errorCode: null,
    atStateGeneration: 7
  }, "the save response itself reports the activation outcome");

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

  const failedSave = await store.save(saveCommand(MUTATION_A, 1, candidate));
  assert.equal(failedSave.activationOutcome?.result, "validation-failed");
  assert.equal(failedSave.activationOutcome?.errorCode, "candidate_invalid");

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
  const retriedSave = await store.save(saveCommand(MUTATION_B, view.stateGeneration!, retried));
  assert.equal(retriedSave.activationOutcome?.result, "committed");

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

test("concurrent reads during an in-save activation never observe the candidate", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-concurrent-read-");
  let during: {
    readonly viewProvider: string;
    readonly pendingRevision: number | null;
    readonly generationProvider: string;
  } | null = null;
  const store = new SettingsStore(dataDir, {
    environment: { AI_1667_CONCURRENT_KEY: "concurrent-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      const view = await store.loadView();
      const generation = await store.loadGeneration();
      during = {
        viewProvider: view.effective.provider,
        pendingRevision: view.pendingRevision,
        generationProvider: generation.settings.provider
      };
      return true;
    }
  });
  await store.init(2);

  await store.save(saveCommand(MUTATION_A, 1, credentialedDocument("AI_1667_CONCURRENT_KEY")));

  assert.notEqual(during, null);
  assert.equal(during!.viewProvider, "dry-run", "a concurrent view stays on the old credentials");
  assert.equal(during!.pendingRevision, 2);
  assert.equal(
    during!.generationProvider,
    "dry-run",
    "a concurrent generation start never races onto a half-activated credential set"
  );
  assert.equal((await store.loadGeneration()).settings.provider, "openai-compatible");
});

test("mid-activation states keep the old document effective until the commit edge", () => {
  const staged = changedState(MUTATION_A, credentialedDocument("AI_1667_PROJECTION_KEY"));
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const committed = reduceSettingsStateV2(promoted, { kind: "commit" });

  for (const state of [staged, validating, prepared, promoted]) {
    assert.equal(
      effectiveGenerationSettings(activeSettingsDocument(state)).provider,
      "dry-run",
      "a reversible activation state never exposes the candidate to readers"
    );
  }
  const promotedView = settingsViewFromState(promoted);
  assert.equal(promotedView.effective.provider, "dry-run");
  assert.equal(promotedView.activeRevision, 1);
  assert.equal(promotedView.pendingRevision, 2);
  // Commit is the durable point of no return: recovery only completes it, so
  // the candidate reads as plainly active — never as its own pending revision.
  assert.equal(
    effectiveGenerationSettings(activeSettingsDocument(committed)).provider,
    "openai-compatible"
  );
  const committedView = settingsViewFromState(committed);
  assert.equal(committedView.pendingRevision, null);
  assert.equal(committedView.activeRevision, 2);
  assert.equal(committedView.effective.provider, "openai-compatible");
});

test("generation snapshots stay coherent while an activation replaces a stored credential", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-snapshot-");
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return true;
    }
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("first:secret")),
    connectionSecrets: { "first:secret": "sk-first" }
  });
  const generation = (await store.loadView()).stateGeneration!;

  let stop = false;
  const hammer = (async () => {
    while (!stop) {
      const { settings } = await store.loadGeneration();
      const authorization = resolveProviderHeaders(settings, {}).headers.authorization;
      assert.equal(
        authorization === "Bearer sk-first" || authorization === "Bearer sk-second",
        true,
        `torn runtime snapshot: ${String(authorization)}`
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  try {
    await store.save({
      ...saveCommand(MUTATION_B, generation, storedSecretDocument("second:secret")),
      connectionSecrets: { "second:secret": "sk-second" }
    });
    // Keep reading across the post-activation prune window as well.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    stop = true;
  }
  await hammer;

  assert.equal(
    resolveProviderHeaders((await store.loadGeneration()).settings, {}).headers.authorization,
    "Bearer sk-second",
    "readers converge on the committed credential"
  );
  assert.deepEqual(
    [...(await readProviderSecrets(dataDir)).keys()],
    ["second:secret"],
    "the replaced credential is still pruned once no coherent snapshot can reference it"
  );
});

test("a failed activation edge never leaves the candidate effective", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-failed-edge-");
  const blocker = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const store = new SettingsStore(dataDir, {
    environment: { AI_1667_FAILED_EDGE_KEY: "edge-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      // Block the next state publish, so the edge after validation fails.
      await mkdir(blocker);
      return true;
    }
  });
  await store.init(2);

  await assert.rejects(store.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_FAILED_EDGE_KEY")
  )));
  assert.equal(
    (await store.loadGeneration()).settings.provider,
    "dry-run",
    "a failed activation edge never exposes the candidate"
  );

  await rm(blocker, { recursive: true, force: true });
  const recovered = new SettingsStore(dataDir, {
    activationMode: "recover-only",
    environment: {},
    now: () => FIXED_TIME
  });
  await recovered.init(2);
  const view = await recovered.loadView();
  assert.equal(view.pendingRevision, 2, "the interrupted candidate is retained");
  assert.equal(view.activeRevision, 1);
  assert.equal(view.lastActivationOutcome?.errorCode, "activation_crashed");
});

test("re-entering the active stored key discards a failed staged candidate instead of bypassing it", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-sidecar-discard-");
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("active:secret")),
    connectionSecrets: { "active:secret": "sk-original" }
  });
  assert.equal((await store.loadView()).pendingRevision, null);

  const stagedGeneration = (await store.loadView()).stateGeneration!;
  await store.save(saveCommand(
    MUTATION_B,
    stagedGeneration,
    credentialedDocument("AI_1667_UNRESOLVED_KEY")
  ));
  assert.equal((await store.loadView()).pendingRevision, 3, "the failing candidate stages");

  const retryGeneration = (await store.loadView()).stateGeneration!;
  const reentered = await store.save({
    ...saveCommand(MUTATION_C, retryGeneration, storedSecretDocument("active:secret")),
    connectionSecrets: { "active:secret": "sk-rotated" }
  });

  assert.equal(reentered.pendingSettingsRevision, null);
  const view = await store.loadView();
  assert.equal(view.pendingRevision, null, "the failed candidate is discarded, not left pending");
  assert.equal(view.lastActivationOutcome, null);
  assert.equal(
    (await readProviderSecrets(dataDir)).get("active:secret"),
    "sk-rotated",
    "the re-entered key value is stored"
  );
});

test("editing a staged candidate back to the active values discards it instead of erroring", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-revert-discard-");
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await store.init(2);
  await store.save(saveCommand(MUTATION_A, 1, credentialedDocument("AI_1667_REVERT_KEY")));
  const staged = await store.loadView();
  assert.equal(staged.pendingRevision, 2);

  const reverted = await store.save(saveCommand(
    MUTATION_B,
    staged.stateGeneration!,
    INITIAL_SETTINGS_DOCUMENT_V2
  ));

  assert.equal(reverted.pendingSettingsRevision, null);
  assert.equal(reverted.activationOutcome, null);
  const view = await store.loadView();
  assert.equal(view.pendingRevision, null, "the candidate is discarded, not kept as an error");
  assert.equal(view.activeRevision, 1, "the active document never moved");
  assert.equal(view.effective.provider, "dry-run");
  assert.equal(view.lastActivationOutcome, null, "the discarded candidate takes its outcome with it");
});

test("a committed in-process activation prunes the replaced stored secret without a restart", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-secret-prune-");
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("first:secret")),
    connectionSecrets: { "first:secret": "sk-first-value" }
  });
  assert.equal((await readProviderSecrets(dataDir)).get("first:secret"), "sk-first-value");

  const generation = (await store.loadView()).stateGeneration!;
  await store.save({
    ...saveCommand(MUTATION_B, generation, storedSecretDocument("second:secret")),
    connectionSecrets: { "second:secret": "sk-second-value" }
  });

  assert.deepEqual(
    [...(await readProviderSecrets(dataDir)).entries()],
    [["second:secret", "sk-second-value"]],
    "the replaced key does not linger on disk until the next restart"
  );
});

test("distinct routed connections validate concurrently inside one probe budget", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-parallel-probe-");
  let inFlight = 0;
  let maxInFlight = 0;
  const store = new SettingsStore(dataDir, {
    environment: {
      AI_1667_PARALLEL_DEFAULT_KEY: "default-secret",
      AI_1667_PARALLEL_PROSE_KEY: "prose-secret"
    },
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      return true;
    }
  });
  await store.init(2);

  await store.save(saveCommand(MUTATION_A, 1, twoConnectionDocument(
    "AI_1667_PARALLEL_DEFAULT_KEY",
    "AI_1667_PARALLEL_PROSE_KEY"
  )));

  assert.equal(maxInFlight, 2, "the probes overlap instead of adding their deadlines");
  assert.equal((await store.loadView()).pendingRevision, null);
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

function storedSecretDocument(secretId: string): SettingsDocumentV2 {
  const base = credentialedDocument("AI_1667_UNUSED_ENV_KEY");
  const connection = base.connections["builtin:dry-run"]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      "builtin:dry-run": {
        ...connection,
        auth: { type: "bearer-stored", secretId }
      }
    }
  };
}

function twoConnectionDocument(defaultEnv: string, proseEnv: string): SettingsDocumentV2 {
  const base = credentialedDocument(defaultEnv);
  const defaultProfile = base.profiles[base.routing.default]!;
  const defaultModel = base.models[defaultProfile.modelId]!;
  const defaultConnection = base.connections[defaultModel.connectionId]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      "prose:connection": {
        ...defaultConnection,
        name: "Prose connection",
        baseUrl: "https://prose.example/v1",
        auth: { type: "bearer-env", env: proseEnv }
      }
    },
    models: {
      ...base.models,
      "prose:model": {
        ...defaultModel,
        name: "Prose model",
        connectionId: "prose:connection"
      }
    },
    profiles: {
      ...base.profiles,
      prose: { ...defaultProfile, name: "Prose", modelId: "prose:model" }
    },
    routing: { ...base.routing, prose: "prose" }
  };
}
