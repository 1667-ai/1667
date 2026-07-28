import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
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
import type { MutationId } from "../server/mutation-ledger-types.js";
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

const MUTATION_D = `m1.1767225600003.${"d".repeat(32)}` as MutationId;

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

  // Each revision pairs its own endpoint with its own key, so a crossed
  // stream — the old endpoint resolving the new key, or the reverse — is
  // observable, not just a missing credential.
  const pairing: Readonly<Record<string, string>> = {
    "https://api.openai.com/v1": "Bearer sk-first",
    "https://second.example/v1": "Bearer sk-second"
  };
  let stop = false;
  const hammer = (async () => {
    while (!stop) {
      const { settings } = await store.loadGeneration();
      const authorization = resolveProviderHeaders(settings, {}).headers.authorization;
      assert.equal(
        authorization,
        pairing[settings.baseUrl],
        `crossed credential streams: ${settings.baseUrl} resolved ${String(authorization)}`
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  try {
    await store.save({
      ...saveCommand(
        MUTATION_B,
        generation,
        storedSecretDocument("second:secret", "https://second.example/v1")
      ),
      connectionSecrets: { "second:secret": "sk-second" }
    });
    // Keep reading across the post-activation prune window as well.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    stop = true;
  }
  await hammer;

  const settled = (await store.loadGeneration()).settings;
  assert.equal(settled.baseUrl, "https://second.example/v1");
  assert.equal(
    resolveProviderHeaders(settled, {}).headers.authorization,
    "Bearer sk-second",
    "readers converge on the committed credential"
  );
  assert.deepEqual(
    [...(await readProviderSecrets(dataDir)).keys()],
    ["second:secret"],
    "the replaced credential is still pruned once no coherent snapshot can reference it"
  );
});

test("a save may not rebind a stored key the active document still resolves", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-rebind-guard-");
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("shared:key")),
    connectionSecrets: { "shared:key": "sk-openai-old" }
  });
  const generation = (await store.loadView()).stateGeneration!;

  // Switching the connection to another provider while reusing the ID would
  // hand the new key to the old endpoint through every concurrent reader.
  await assert.rejects(
    store.save({
      ...saveCommand(MUTATION_B, generation, retargetedStoredDocument("shared:key")),
      connectionSecrets: { "shared:key": "sk-anthropic-new" }
    }),
    hasServiceCode("invalid_request")
  );
  assert.equal(
    (await readProviderSecrets(dataDir)).get("shared:key"),
    "sk-openai-old",
    "the refused save never touched the active value"
  );
  const view = await store.loadView();
  assert.equal(view.pendingRevision, null, "the refused save staged nothing");
  assert.equal(view.effective.baseUrl, "https://api.openai.com/v1");
  assert.equal(
    resolveProviderHeaders((await store.loadGeneration()).settings, {}).headers.authorization,
    "Bearer sk-openai-old"
  );

  // The same retarget under a fresh ID is the supported path: the old
  // binding stays intact until commit, then the superseded value is pruned.
  const rekeyed = await store.save({
    ...saveCommand(MUTATION_C, generation, retargetedStoredDocument("shared:key.2")),
    connectionSecrets: { "shared:key.2": "sk-anthropic-new" }
  });
  assert.equal(rekeyed.activationOutcome?.result, "committed");
  const activated = (await store.loadGeneration()).settings;
  assert.equal(activated.baseUrl, "https://api.anthropic.com");
  assert.equal(
    resolveProviderHeaders(activated, {}).headers["x-api-key"],
    "sk-anthropic-new"
  );
  assert.deepEqual(
    [...(await readProviderSecrets(dataDir)).keys()],
    ["shared:key.2"],
    "the superseded binding is pruned after commit"
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

test("a shared-tier rotation deletes exactly the superseded credential after commit", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-tier-rotation-");
  const secretsDir = await scratchSecretsDir(t);
  let providerReady = true;
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => providerReady,
    secretsDir
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("demo.k00000000-0000-4000-8000-00000000000a")),
    connectionSecrets: { "demo.k00000000-0000-4000-8000-00000000000a": "sk-old" }
  });
  assert.deepEqual([...(await readProviderSecrets(secretsDir)).keys()], ["demo.k00000000-0000-4000-8000-00000000000a"]);

  // A failed replacement keeps both values: the active document still
  // resolves the old one, and the staged candidate still owns the new one.
  providerReady = false;
  const stagedGeneration = (await store.loadView()).stateGeneration!;
  await store.save({
    ...saveCommand(MUTATION_B, stagedGeneration, storedSecretDocument("demo.k00000000-0000-4000-8000-00000000000b")),
    connectionSecrets: { "demo.k00000000-0000-4000-8000-00000000000b": "sk-new" }
  });
  assert.deepEqual(
    [...(await readProviderSecrets(secretsDir)).keys()].sort(),
    ["demo.k00000000-0000-4000-8000-00000000000a", "demo.k00000000-0000-4000-8000-00000000000b"],
    "a failed activation deletes nothing"
  );
  assert.equal(
    resolveProviderHeaders((await store.loadGeneration()).settings, {}).headers.authorization,
    "Bearer sk-old"
  );

  // The retry that commits deletes exactly what it superseded — the old
  // active binding and the replaced failed candidate — with no reference
  // scan against the shared tier.
  providerReady = true;
  const retryGeneration = (await store.loadView()).stateGeneration!;
  await store.save({
    ...saveCommand(MUTATION_C, retryGeneration, storedSecretDocument("demo.k00000000-0000-4000-8000-00000000000c")),
    connectionSecrets: { "demo.k00000000-0000-4000-8000-00000000000c": "sk-new2" }
  });
  assert.deepEqual([...(await readProviderSecrets(secretsDir)).keys()], ["demo.k00000000-0000-4000-8000-00000000000c"]);
  assert.equal(
    resolveProviderHeaders((await store.loadGeneration()).settings, {}).headers.authorization,
    "Bearer sk-new2"
  );
});

test("a superseded legacy secret ID survives the shared-tier deletion pass", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-tier-legacy-");
  const secretsDir = await scratchSecretsDir(t);
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true,
    secretsDir
  });
  await store.init(2);
  // A connection-derived ID from before mint-per-key: another project may
  // resolve the same name in the shared tier, so it is never deleted.
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("builtin:dry-run")),
    connectionSecrets: { "builtin:dry-run": "sk-legacy" }
  });
  const generation = (await store.loadView()).stateGeneration!;

  await store.save({
    ...saveCommand(
      MUTATION_B,
      generation,
      storedSecretDocument("demo.k00000000-0000-4000-8000-0000000000d4")
    ),
    connectionSecrets: { "demo.k00000000-0000-4000-8000-0000000000d4": "sk-minted" }
  });

  assert.equal((await store.loadView()).pendingRevision, null, "the replacement committed");
  assert.deepEqual(
    [...(await readProviderSecrets(secretsDir)).keys()].sort(),
    ["builtin:dry-run", "demo.k00000000-0000-4000-8000-0000000000d4"],
    "only provably minted IDs are ever deleted; legacy names keep accumulating"
  );
});

test("shared-tier discard and startup commit remove exactly their superseded credentials", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-inprocess-tier-recovery-");
  const secretsDir = await scratchSecretsDir(t);
  const active = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true,
    secretsDir
  });
  await active.init(2);
  await active.save({
    ...saveCommand(MUTATION_A, 1, storedSecretDocument("tier.k00000000-0000-4000-8000-0000000000a1")),
    connectionSecrets: { "tier.k00000000-0000-4000-8000-0000000000a1": "sk-active" }
  });

  // A staged candidate left behind by an interrupted save.
  const interrupted = new SettingsStore(dataDir, {
    activationMode: "recover-only",
    environment: {},
    now: () => FIXED_TIME,
    secretsDir
  });
  await interrupted.init(2);
  const generation = (await interrupted.loadView()).stateGeneration!;
  await interrupted.save({
    ...saveCommand(MUTATION_B, generation, storedSecretDocument("tier.k00000000-0000-4000-8000-0000000000b2")),
    connectionSecrets: { "tier.k00000000-0000-4000-8000-0000000000b2": "sk-candidate" }
  });
  assert.deepEqual(
    [...(await readProviderSecrets(secretsDir)).keys()].sort(),
    ["tier.k00000000-0000-4000-8000-0000000000a1", "tier.k00000000-0000-4000-8000-0000000000b2"]
  );

  // Discarding the candidate removes its credential from the shared tier.
  const discardGeneration = (await interrupted.loadView()).stateGeneration!;
  await interrupted.discardPending({
    transportOperationId: "transport:tier-discard",
    mutationId: MUTATION_C,
    expectedStateGeneration: discardGeneration
  });
  assert.deepEqual(
    [...(await readProviderSecrets(secretsDir)).keys()],
    ["tier.k00000000-0000-4000-8000-0000000000a1"],
    "the discarded candidate's credential does not linger in the shared tier"
  );

  // A startup commit of a leftover staged candidate removes the credential
  // it superseded.
  const restaged = new SettingsStore(dataDir, {
    activationMode: "recover-only",
    environment: {},
    now: () => FIXED_TIME,
    secretsDir
  });
  await restaged.init(2);
  const restageGeneration = (await restaged.loadView()).stateGeneration!;
  await restaged.save({
    ...saveCommand(MUTATION_D, restageGeneration, storedSecretDocument("tier.k00000000-0000-4000-8000-0000000000c3")),
    connectionSecrets: { "tier.k00000000-0000-4000-8000-0000000000c3": "sk-replacement" }
  });
  const recovered = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true,
    secretsDir
  });
  await recovered.init(2);
  assert.equal((await recovered.loadView()).pendingRevision, null);
  assert.deepEqual(
    [...(await readProviderSecrets(secretsDir)).keys()],
    ["tier.k00000000-0000-4000-8000-0000000000c3"],
    "the startup commit deletes the binding it superseded"
  );
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

async function scratchSecretsDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-secrets-tier-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

function storedSecretDocument(
  secretId: string,
  baseUrl = "https://api.openai.com/v1"
): SettingsDocumentV2 {
  const base = credentialedDocument("AI_1667_UNUSED_ENV_KEY");
  const connection = base.connections["builtin:dry-run"]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      "builtin:dry-run": {
        ...connection,
        baseUrl,
        auth: { type: "bearer-stored", secretId }
      }
    }
  };
}

function retargetedStoredDocument(secretId: string): SettingsDocumentV2 {
  const base = storedSecretDocument(secretId);
  const connection = base.connections["builtin:dry-run"]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      "builtin:dry-run": {
        ...connection,
        preset: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        auth: { type: "header-stored", name: "x-api-key", secretId }
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
