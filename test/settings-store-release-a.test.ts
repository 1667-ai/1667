import assert from "node:assert/strict";
import test from "node:test";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import {
  providerRuntimeFor,
  resolveProviderHeaders
} from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import {
  convertGenerationSettingsV1,
  effectiveGenerationView
} from "../server/settings-v2-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { readSettingsState } from "../server/settings-state-file.js";
import { settingsMutationFingerprint } from "../server/settings-v2-mutation.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import {
  BlockingLookupLedger,
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  credentialedDocument,
  hasServiceCode,
  initializedFormat2Directory,
  saveCommand,
  transactionBytes,
  writingDocument
} from "./settings-store-fixtures.js";

test("format-2 immediate save replays before version policy and distinguishes conflicts", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-replay-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const document = writingDocument("First durable edit.");
  const command = saveCommand(MUTATION_A, 1, document, "transport:first");

  const saved = await store.save(command);
  assert.deepEqual(await store.inspectMutationReceipt(MUTATION_A), {
    state: "completed",
    method: "saveSettings",
    fingerprint: settingsMutationFingerprint(
      { method: "saveSettings", document },
      1
    )
  });
  assert.equal(saved.settingsStateGeneration, 2);
  assert.equal(saved.activeSettingsRevision, 2);
  assert.equal(saved.pendingSettingsRevision, null);
  assert.equal((await store.loadView()).effective.systemPrompt, "First durable edit.");

  await store.save(saveCommand(MUTATION_B, 2, writingDocument("Later durable edit.")));
  const beforeReplay = await transactionBytes(dataDir, MUTATION_A);

  const replayed = await store.save({ ...command, transportOperationId: "transport:retry" });
  assert.deepEqual(replayed, saved);
  assert.deepEqual(await transactionBytes(dataDir, MUTATION_A), beforeReplay);
  const current = await store.loadView();
  assert.equal(current.stateGeneration, 3);
  assert.equal(current.effective.systemPrompt, "Later durable edit.");

  await assert.rejects(
    store.save(saveCommand(MUTATION_A, 1, writingDocument("Changed retry input."))),
    hasServiceCode("idempotency_conflict")
  );
  await assert.rejects(
    store.save(saveCommand(MUTATION_C, 1, writingDocument("Stale independent edit."))),
    hasServiceCode("revision_conflict")
  );
  assert.deepEqual(await transactionBytes(dataDir, MUTATION_A), beforeReplay);
  assert.equal((await store.loadView()).stateGeneration, 3);
});

test("format-2 credential save activates in-process; a failed activation stays staged and discardable", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-pending-");
  const store = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await store.init(2);

  const staged = await store.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_PENDING_KEY")
  ));
  assert.equal(staged.settingsStateGeneration, 2);
  assert.equal(staged.activeSettingsRevision, 1);
  assert.equal(staged.pendingSettingsRevision, 2);

  const stagedView = await store.loadView();
  if (stagedView.document === null) throw new Error("format-2 settings document is missing");
  assert.equal(
    stagedView.stateGeneration,
    4,
    "the save request itself runs the activation attempt"
  );
  assert.equal(stagedView.pendingRevision, 2, "a failed activation never discards the candidate");
  assert.equal(stagedView.document.connections["builtin:dry-run"]?.auth.type, "bearer-env");
  assert.equal(stagedView.effective.provider, "dry-run", "rejected credentials never become effective");
  assert.deepEqual(stagedView.lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "validation-failed",
    errorCode: "credential_unresolved",
    atStateGeneration: 4
  });

  const discarded = await store.discardPending({
    transportOperationId: "transport:discard",
    mutationId: MUTATION_C,
    expectedStateGeneration: 4
  });
  assert.equal(discarded.settingsStateGeneration, 5);
  assert.equal(discarded.activeSettingsRevision, 1);
  assert.equal(discarded.pendingSettingsRevision, null);
  assert.equal((await store.loadView()).effective.provider, "dry-run");

  const saved = await store.save(saveCommand(
    MUTATION_B,
    5,
    writingDocument("Editing resumes after discard.")
  ));
  assert.equal(saved.settingsStateGeneration, 6);
  assert.equal(saved.pendingSettingsRevision, null);
  assert.equal((await store.loadView()).effective.systemPrompt, "Editing resumes after discard.");
});

test("format-2 coordinator rejects a concurrent same-scope save without queueing", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-busy-");
  const ledger = new BlockingLookupLedger(dataDir);
  const store = new SettingsStore(dataDir, { ledger, now: () => FIXED_TIME });
  await store.init(2);

  const first = store.save(saveCommand(MUTATION_A, 1, writingDocument("Admitted edit.")));
  await ledger.waitUntilBlocked();
  try {
    await assert.rejects(
      store.save({
        ...saveCommand(MUTATION_B, 1, writingDocument("Malformed envelope.")),
        mutationId: "malformed",
        document: null
      }),
      hasServiceCode("invalid_request")
    );
    await assert.rejects(
      store.save({
        ...saveCommand(MUTATION_B, 1, writingDocument("Concurrent edit.")),
        document: null
      }),
      hasServiceCode("resource_busy")
    );
  } finally {
    ledger.unblock();
  }
  const saved = await first;
  assert.equal(saved.settingsStateGeneration, 2);
  assert.equal((await store.loadView()).effective.systemPrompt, "Admitted edit.");
  await assert.rejects(
    store.save({
      ...saveCommand(MUTATION_B, 2, writingDocument("Malformed admitted edit.")),
      document: null
    }),
    hasServiceCode("invalid_request")
  );
});

test("restart activates a staged credential document when every reference resolves", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-activate-");
  const first = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await first.init(2);
  const command = saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_ACTIVATION_KEY")
  );
  // The in-process attempt fails (no environment), so the candidate stays
  // staged; the restart with the credential present retries and activates.
  const staged = await first.save(command);

  const restarted = new SettingsStore(dataDir, {
    environment: { AI_1667_ACTIVATION_KEY: "test-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async (settings) => {
      assert.equal(
        resolveProviderHeaders(settings, {}).headers.authorization,
        "Bearer test-secret"
      );
      return true;
    }
  });
  await restarted.init(2);
  const view = await restarted.loadView();
  assert.equal(view.stateGeneration, 9);
  assert.equal(view.activeRevision, 2);
  assert.equal(view.pendingRevision, null);
  assert.equal(view.effective.provider, "openai-compatible");
  assert.equal(view.effective.apiKeyEnv, "AI_1667_ACTIVATION_KEY");
  const probeSettings = await restarted.assertProviderProbeSupported({
    ...view.effective,
    model: "another-model-on-the-same-connection",
    contextWindow: 123_456
  });
  assert.equal(probeSettings.contextWindow, 123_456);
  assert.equal(probeSettings.model, "another-model-on-the-same-connection");
  assert.deepEqual(providerRuntimeFor(probeSettings).auth, {
    type: "bearer-env",
    env: "AI_1667_ACTIVATION_KEY"
  });
  assert.equal(
    resolveProviderHeaders(probeSettings, {}).headers.authorization,
    "Bearer test-secret"
  );
  await assert.doesNotReject(restarted.assertProviderProbeSupported({
    ...view.effective,
    baseUrl: "https://keyless-models.example/v1",
    apiKeyEnv: null
  }));
  assert.deepEqual(
    await restarted.save({ ...command, transportOperationId: "transport:post-activation-retry" }),
    {
      ...staged,
      activationOutcome: {
        transactionId: MUTATION_A,
        candidateRevision: 2,
        result: "committed",
        errorCode: null,
        atStateGeneration: 9
      }
    },
    "receipt replay keeps the durable staging result and reports the attempt that has since run"
  );
  assert.deepEqual((await readSettingsState(dataDir)).lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "committed",
    errorCode: null,
    atStateGeneration: 9
  });
});

test("activation validates every distinct routed connection", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-v2-routed-activation-"
  );
  const base = credentialedDocument("AI_1667_DEFAULT_ROUTE_KEY");
  const defaultProfile = base.profiles[base.routing.default]!;
  const defaultModel = base.models[defaultProfile.modelId]!;
  const defaultConnection = base.connections[defaultModel.connectionId]!;
  const document: SettingsDocumentV2 = {
    ...base,
    connections: {
      ...base.connections,
      "prose:connection": {
        ...defaultConnection,
        name: "Prose connection",
        baseUrl: "https://prose.example/v1",
        auth: {
          type: "bearer-env",
          env: "AI_1667_PROSE_ROUTE_KEY"
        }
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
      prose: {
        ...defaultProfile,
        name: "Prose",
        modelId: "prose:model"
      }
    },
    routing: {
      ...base.routing,
      prose: "prose"
    }
  };
  const first = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await first.init(2);
  await first.save(saveCommand(MUTATION_A, 1, document));
  const validated: string[] = [];
  const restarted = new SettingsStore(dataDir, {
    environment: {
      AI_1667_DEFAULT_ROUTE_KEY: "default-secret",
      AI_1667_PROSE_ROUTE_KEY: "prose-secret"
    },
    now: () => FIXED_TIME,
    validateCandidate: async (settings) => {
      validated.push(settings.baseUrl);
      return settings.baseUrl !== "https://prose.example/v1";
    }
  });

  await restarted.init(2);

  assert.deepEqual(validated, [
    "https://api.openai.com/v1",
    "https://prose.example/v1"
  ]);
  const view = await restarted.loadView();
  assert.equal(view.activeRevision, 1);
  assert.equal(view.pendingRevision, 2, "the rejected candidate stays staged");
  assert.equal(view.lastActivationOutcome?.errorCode, "candidate_invalid");
});

test("restart retries an unresolved credential and keeps the candidate staged on failure", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-missing-env-");
  const first = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await first.init(2);
  await first.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_MISSING_KEY")
  ));

  const restarted = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await restarted.init(2);
  const view = await restarted.loadView();
  assert.equal(view.stateGeneration, 6, "save-time attempt plus one startup retry");
  assert.equal(view.activeRevision, 1);
  assert.equal(view.pendingRevision, 2, "startup recovery never discards the candidate");
  assert.equal(view.effective.provider, "dry-run");
  const state = await readSettingsState(dataDir);
  assert.equal(state.settingsRevisionClock, 2, "rejected candidate revision is never reused");
  assert.deepEqual(state.lastActivationOutcome, {
    transactionId: MUTATION_A,
    candidateRevision: 2,
    result: "validation-failed",
    errorCode: "credential_unresolved",
    atStateGeneration: 6
  });
});

test("restart ignores inherited environment properties before candidate validation", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-inherited-env-");
  const first = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await first.init(2);
  await first.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("constructor")
  ));
  let validationCalls = 0;

  const restarted = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      validationCalls += 1;
      return true;
    }
  });
  await restarted.init(2);

  assert.equal(validationCalls, 0);
  assert.equal((await restarted.loadView()).activeRevision, 1);
  assert.equal(
    (await readSettingsState(dataDir)).lastActivationOutcome?.errorCode,
    "credential_unresolved"
  );
});

test("recover-only maintenance leaves staged settings untouched", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-maintenance-");
  const first = new SettingsStore(dataDir, { environment: {}, now: () => FIXED_TIME });
  await first.init(2);
  await first.save(saveCommand(
    MUTATION_A,
    1,
    credentialedDocument("AI_1667_MAINTENANCE_KEY")
  ));
  let validationCalls = 0;

  const maintenance = new SettingsStore(dataDir, {
    activationMode: "recover-only",
    environment: { AI_1667_MAINTENANCE_KEY: "test-secret" },
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      validationCalls += 1;
      return true;
    }
  });
  await maintenance.init(2);

  const view = await maintenance.loadView();
  assert.equal(validationCalls, 0);
  assert.equal(view.stateGeneration, 4, "the failed save-time attempt already advanced the state");
  assert.equal(view.activeRevision, 1);
  assert.equal(view.pendingRevision, 2);
  assert.equal(view.effective.provider, "dry-run");
});

test("migrated plaintext presets use owned loopback only on supported targets", async (t) => {
  const cases = [
    ["lm-studio", "http://127.0.0.1:1234/v1"],
    ["ollama", "http://127.0.0.1:11434/v1"],
    ["llama-cpp", "http://127.0.0.1:8080/v1"],
    ["koboldcpp", "http://127.0.0.1:5001/v1"]
  ] as const;
  const remediation =
    "Plain HTTP provider requests are unavailable on this release target; configure an authenticated HTTPS endpoint.";

  for (const [preset, baseUrl] of cases) {
    const dataDir = await initializedFormat2Directory(
      t,
      `1667-settings-v2-${preset}-`
    );
    const first = new SettingsStore(dataDir, {
      now: () => FIXED_TIME,
      // Keep the save-time attempt hermetic: on owned-loopback targets it
      // fails and stays staged; elsewhere the probe is skipped entirely.
      validateCandidate: async () => false
    });
    await first.init(2);
    const migrated = convertGenerationSettingsV1({
      ...effectiveGenerationView(INITIAL_SETTINGS_DOCUMENT_V2),
      provider: "openai-compatible",
      baseUrl,
      model: `${preset}-model`
    });
    const staged = await first.save(saveCommand(MUTATION_A, 1, migrated));
    assert.equal(staged.pendingSettingsRevision, 2);

    let providerWorkCalls = 0;
    const restarted = new SettingsStore(dataDir, {
      now: () => FIXED_TIME,
      validateCandidate: async () => {
        providerWorkCalls += 1;
        return true;
      }
    });
    await restarted.init(2);
    const view = await restarted.loadView();
    if (view.document === null) throw new Error("format-2 settings document is missing");
    assert.equal(view.activeRevision, 2);
    assert.equal(view.pendingRevision, null);
    assert.equal(view.effective.baseUrl, baseUrl);
    assert.equal(view.document.connections["migrated:connection"]?.preset, preset);
    assert.equal(
      providerWorkCalls,
      ownedLoopbackHttpSupported() ? 1 : 0,
      "only supported owned-loopback targets validate the provider"
    );

    const edited: SettingsDocumentV2 = {
      ...view.document,
      writing: { defaultAuthorBrief: `Edited ${preset} settings.` }
    };
    const saved = await restarted.save(saveCommand(
      MUTATION_B,
      view.stateGeneration!,
      edited
    ));
    assert.equal(saved.pendingSettingsRevision, null);
    assert.equal((await restarted.loadView()).effective.systemPrompt, `Edited ${preset} settings.`);

    if (ownedLoopbackHttpSupported()) {
      await assert.doesNotReject(restarted.loadGeneration());
      await assert.doesNotReject(restarted.assertProviderProbeSupported(view.effective));
    } else {
      await assert.rejects(
        restarted.loadGeneration(),
        (error) => error instanceof Error && error.message === remediation
      );
      await assert.rejects(
        restarted.assertProviderProbeSupported(view.effective),
        (error) => error instanceof Error && error.message === remediation
      );
    }
  }
});

test("format-2 probes reject a changed credential target before provider work", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-probe-credential-");
  const store = new SettingsStore(dataDir);
  await store.init(2);
  const active = await store.load();

  await assert.doesNotReject(store.assertProviderProbeSupported({
    ...active,
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "credentialless-draft"
  }));
  await assert.rejects(
    store.assertProviderProbeSupported({
      ...active,
      provider: "openai-compatible",
      baseUrl: "https://models.example/v1",
      model: "credentialed-draft",
      apiKeyEnv: "NEW_PROVIDER_KEY"
    }),
    hasServiceCode("credential_test_requires_activation")
  );
});

test("format-2 probes resolve a key the editor has typed but not saved", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-probe-pending-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const connection = INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!;
  const secretId = "builtin:dry-run.kpending";
  const document: SettingsDocumentV2 = {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      "builtin:dry-run": {
        ...connection,
        name: "Anthropic",
        preset: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        auth: { type: "header-stored", name: "x-api-key", secretId }
      }
    }
  };

  // Without the key the probe has nothing to authenticate with. Reading the
  // model list here is what produced a 401 from the provider instead.
  await assert.rejects(
    store.resolveProviderProbe({
      kind: "settings-document",
      document,
      purpose: "default"
    }),
    hasServiceCode("credential_test_requires_activation")
  );

  const settings = await store.resolveProviderProbe({
    kind: "settings-document",
    document,
    purpose: "default",
    secrets: { [secretId]: "sk-ant-pending-probe-key" }
  });
  const { headers } = resolveProviderHeaders(settings, {});
  assert.equal(headers["x-api-key"], "sk-ant-pending-probe-key");

  // A probe tests a key; it never stores one.
  const state = await readSettingsState(dataDir);
  assert.equal(state.pendingRevision, null);
  await assert.rejects(
    store.resolveProviderProbe({
      kind: "settings-document",
      document,
      purpose: "default"
    }),
    hasServiceCode("credential_test_requires_activation")
  );
});

test("format-2 probes restore the active private-HTTP transport policy", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-v2-probe-private-"
  );
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const connection = INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!;
  const model = INITIAL_SETTINGS_DOCUMENT_V2.models["builtin:dry-run"]!;
  const document: SettingsDocumentV2 = {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      "builtin:dry-run": {
        ...connection,
        name: "Private model",
        preset: "custom",
        protocol: "openai-chat-completions",
        baseUrl: "http://192.168.1.25:8080/v1",
        allowInsecureHttp: true
      }
    },
    models: {
      "builtin:dry-run": {
        ...model,
        remoteId: "private-model",
        name: "Private model",
        capabilities: {
          temperature: "supported",
          assistantPrefill: "unknown",
          reasoningEffort: "unknown",
          promptCaching: "unknown"
        }
      }
    }
  };
  await store.save(saveCommand(MUTATION_A, 1, document));
  const view = await store.loadView();
  const serializedProbe = { ...view.effective };
  assert.equal(providerRuntimeFor(serializedProbe).allowInsecureHttp, false);

  const admitted = await store.assertProviderProbeSupported(serializedProbe);
  assert.equal(providerRuntimeFor(admitted).allowInsecureHttp, true);
});
