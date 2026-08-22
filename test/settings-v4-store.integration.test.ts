import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildOpenAiChatRequestBody } from "../server/provider-request-body.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { providerRuntimeFor } from "../server/provider-runtime.js";
import { ProviderError } from "../server/errors.js";
import { streamCompletion } from "../server/providers.js";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-layout.js";
import {
  formatSettingsStateV4,
  hashSettingsDocumentV4,
  parseSettingsDocumentV4,
  parseSettingsStateV4
} from "../server/settings-v4-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4,
  INITIAL_SETTINGS_STATE_V4
} from "../server/settings-v4-default.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { parseSettingsDocumentV5 } from "../server/settings-v5-codec.js";
import { decodeSettingsViewResponse } from "../shared/settings-response-decoder.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import type { SettingsDocumentV4 } from "../shared/settings-v4-types.js";
import { normalizeUserConfig } from "../tui/src/config.js";
import {
  initialSettingsOverlay,
  settingsRows
} from "../tui/src/settings-overlay-model.js";
import {
  imageInputAuthorized,
  resolveImageInputCapability
} from "../shared/image-input-capabilities.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  hasServiceCode,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";

function statePath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

function reasoningDocument(): SettingsDocumentV4 {
  const baseModel = INITIAL_SETTINGS_DOCUMENT_V4.models["builtin:dry-run"]!;
  const baseConnection = INITIAL_SETTINGS_DOCUMENT_V4.connections["builtin:dry-run"]!;
  return parseSettingsDocumentV4({
    ...INITIAL_SETTINGS_DOCUMENT_V4,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.connections,
      fixture: {
        ...baseConnection,
        name: "OpenAI fixture",
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1"
      }
    },
    models: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.models,
      fixture: {
        ...baseModel,
        connectionId: "fixture",
        remoteId: "gpt-5",
        name: "GPT-5 fixture",
        capabilities: {
          ...baseModel.capabilities,
          reasoningEffort: "supported"
        }
      }
    },
    profiles: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.profiles,
      default: {
        ...INITIAL_SETTINGS_DOCUMENT_V4.profiles.default!,
        modelId: "fixture",
        temperature: null,
        effort: "high",
        thinkingMode: "on"
      }
    }
  });
}

function plaintextDocument(): SettingsDocumentV4 {
  const base = reasoningDocument();
  return parseSettingsDocumentV4({
    ...base,
    connections: {
      ...base.connections,
      fixture: {
        ...base.connections.fixture!,
        name: "LAN fixture",
        preset: "custom",
        baseUrl: "http://192.168.1.2/v1",
        auth: { type: "none" },
        allowInsecureHttp: true
      }
    }
  });
}

function subscriptionSamplingDocument(): SettingsDocumentV4 {
  const base = reasoningDocument();
  return parseSettingsDocumentV4({
    ...base,
    connections: {
      ...base.connections,
      fixture: {
        ...base.connections.fixture!,
        name: "ChatGPT plan fixture",
        preset: "chatgpt-plan",
        protocol: "openai-codex-responses",
        baseUrl: null,
        auth: { type: "none" },
        headers: []
      }
    },
    models: {
      ...base.models,
      fixture: {
        ...base.models.fixture!,
        remoteId: "gpt-5.6-sol",
        capabilities: {
          ...base.models.fixture!.capabilities,
          reasoningEffort: "supported"
        }
      }
    },
    profiles: {
      ...base.profiles,
      default: {
        ...base.profiles.default!,
        temperature: null,
        effort: "default",
        thinkingMode: "default",
        sampling: { ...EMPTY_SAMPLING_V2, topP: 0.9, topK: 17 }
      }
    }
  });
}

function reasoningState(document: SettingsDocumentV4) {
  return parseSettingsStateV4({
    ...INITIAL_SETTINGS_STATE_V4,
    documents: { "1": document },
    // A non-null pointer makes this a valid clean successor state without
    // claiming the schema-4 document is the schema-4 initial vector.
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
  });
}

function promotedState(
  oldDocument: SettingsDocumentV4,
  candidateDocument: SettingsDocumentV4
) {
  return parseSettingsStateV4({
    ...INITIAL_SETTINGS_STATE_V4,
    stateGeneration: 2,
    settingsRevisionClock: 2,
    documents: { "1": oldDocument, "2": candidateDocument },
    activeRevision: 2,
    pendingRevision: 2,
    previousRevision: 1,
    activation: {
      transactionId: MUTATION_A,
      oldHash: hashSettingsDocumentV4(oldDocument),
      candidateHash: hashSettingsDocumentV4(candidateDocument),
      state: "promoted",
      attempt: 1
    },
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
  });
}

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [{
    role: "user",
    blocks: [{
      stability: "volatile",
      kind: "request",
      text: "Continue.",
      boundaryAfter: "none"
    }]
  }]
};

test("schema 4 opens as an editable schema-5 working document and first save publishes schema 5", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v4-store-");
  const state = reasoningState(reasoningDocument());
  await writeFile(statePath(dataDir), formatSettingsStateV4(state), { mode: 0o600 });

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const view = await store.loadView();
  assert.equal(view.dataFormat, 2);
  assert.equal(view.editable, true);
  assert.equal(view.document?.schemaVersion, 5);
  assert.equal(view.document?.profiles.default?.generationReasoning.kind, "independent");
  assert.equal(view.effective.model, "gpt-5");
  assert.equal(view.effectiveProse.model, "gpt-5");
  assert.equal(view.effective.allowInsecureHttp, undefined);
  assert.equal(view.effectiveProseReasoning, "marker");
  const runtime = await store.loadRuntime();
  const providerRuntime = providerRuntimeFor(runtime.settings);
  assert.equal(providerRuntime.effort, "high");
  assert.equal(providerRuntime.thinkingMode, "on");

  const request = await buildOpenAiChatRequestBody(
    runtime.settings,
    PROMPT,
    { kind: "omit", reason: "policy-off" }
  );
  assert.equal(request.reasoning_effort, "high");

  assert.ok(view.document);
  const saved = await store.save(saveCommand(MUTATION_B, view.stateGeneration, view.document));
  assert.equal(saved.kind, "settings");
  const published = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: number };
  assert.equal(published.schemaVersion, 5);
});

test("schema 4 plaintext policy survives the real view and response decoder into TUI", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v4-plaintext-view-");
  await writeFile(
    statePath(dataDir),
    formatSettingsStateV4(reasoningState(plaintextDocument())),
    { mode: 0o600 }
  );

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const view = await store.loadView();
  assert.equal(view.dataFormat, 2);
  assert.equal(view.effective.allowInsecureHttp, true);
  assert.equal(view.effectiveProse.allowInsecureHttp, true);

  const wire = JSON.parse(JSON.stringify(view));
  const decoded = decodeSettingsViewResponse(wire, parseSettingsDocumentV5);
  assert.equal(decoded.effective.allowInsecureHttp, true);
  assert.equal(decoded.effectiveProse.allowInsecureHttp, true);

  const config = normalizeUserConfig({ settingsViewMode: "advanced" });
  const overlay = initialSettingsOverlay(decoded, config);
  const plainHttpRow = settingsRows(overlay, config)
    .find((row) => row.id === "allow-insecure-http");
  assert.equal(plainHttpRow?.value, "[ on ]");
  assert.equal(plainHttpRow?.hint, "Allows plain HTTP for a model service you control.");

  const invalidWire = {
    ...wire,
    effective: { ...wire.effective, allowInsecureHttp: "true" }
  };
  assert.throws(
    () => decodeSettingsViewResponse(invalidWire, parseSettingsDocumentV5),
    /generation settings\.allowInsecureHttp/
  );
});

test("schema 4 subscription sampling stays readable and refuses before adapter dispatch", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v4-subscription-sampling-");
  const document = subscriptionSamplingDocument();
  await writeFile(statePath(dataDir), formatSettingsStateV4(reasoningState(document)), { mode: 0o600 });

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const view = await store.loadView();
  assert.equal(view.dataFormat, 2);
  assert.equal(view.editable, true);
  assert.equal(view.effective.model, "gpt-5.6-sol");

  const runtime = await store.loadRuntime();
  const providerRuntime = providerRuntimeFor(runtime.settings);
  assert.equal(providerRuntime.sampling.topP, 0.9);
  assert.equal(providerRuntime.sampling.topK, 17);
  let providerStarted = false;
  await assert.rejects(
    (async () => {
      for await (const _text of streamCompletion(
        runtime.settings,
        PROMPT,
        new AbortController().signal,
        { providerStarted: () => { providerStarted = true; } }
      )) {
        // The canonical policy must refuse before a provider stream can start.
      }
    })(),
    (error: unknown) => error instanceof ProviderError
      && error.message === "The pinned subscription adapter cannot serialize sampling controls."
  );
  assert.equal(providerStarted, false);

  const latest = await store.loadView();
  if (latest.stateGeneration === null) throw new Error("schema-4 view is not editable");
  const saved = await store.save(saveCommand(MUTATION_B, latest.stateGeneration, INITIAL_SETTINGS_DOCUMENT_V2));
  assert.equal(saved.kind, "settings");
  const published = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: number };
  assert.equal(published.schemaVersion, 5);
});

test("schema 4 keyless loopback HTTP opens before request transport admission", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v4-loopback-");
  const baseModel = INITIAL_SETTINGS_DOCUMENT_V4.models["builtin:dry-run"]!;
  const baseConnection = INITIAL_SETTINGS_DOCUMENT_V4.connections["builtin:dry-run"]!;
  const document = parseSettingsDocumentV4({
    ...INITIAL_SETTINGS_DOCUMENT_V4,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.connections,
      loopback: {
        ...baseConnection,
        name: "Loopback",
        preset: "custom",
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:1234/v1",
        auth: { type: "none" }
      }
    },
    models: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.models,
      loopback: {
        ...baseModel,
        connectionId: "loopback",
        remoteId: "loaded-model",
        name: "Loopback model"
      }
    },
    profiles: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.profiles,
      default: {
        ...INITIAL_SETTINGS_DOCUMENT_V4.profiles.default!,
        modelId: "loopback"
      }
    }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV4(reasoningState(document)), { mode: 0o600 });

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await assert.doesNotReject(store.init());

  if (ownedLoopbackHttpSupported()) {
    await assert.doesNotReject(store.loadRuntime());
  } else {
    await assert.rejects(
      store.loadRuntime(),
      (error) => error instanceof Error
        && error.message === "Plain HTTP provider requests are unavailable on this release target; configure an authenticated HTTPS endpoint."
    );
  }
});

test("schema 4 route fallback and explicit purpose keep runtime, cache, image, and view data aligned", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v4-routes-");
  const base = reasoningDocument();
  const fixtureModel = base.models.fixture!;
  const document = parseSettingsDocumentV4({
    ...base,
    models: {
      ...base.models,
      proseFixture: {
        ...fixtureModel,
        remoteId: "prose-model",
        name: "Prose fixture",
        capabilities: {
          ...fixtureModel.capabilities,
          imageInput: "supported",
          imageTokenCeiling: 4_096
        }
      }
    },
    profiles: {
      ...base.profiles,
      prose: {
        ...base.profiles.default!,
        name: "Prose",
        modelId: "proseFixture",
        reasoning: "open",
        continuationPromptOptimization: "late-cache-stable"
      }
    },
    routing: {
      ...base.routing,
      prose: "prose"
    }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV4(reasoningState(document)), { mode: 0o600 });

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const defaultRuntime = await store.loadRuntime("utility");
  assert.equal(defaultRuntime.settings.model, "gpt-5");
  assert.equal(defaultRuntime.route.profileId, "default");
  assert.equal(defaultRuntime.promptCache.remoteModelId, "gpt-5");
  assert.equal(defaultRuntime.imageInputCapability?.imageInput, "unsupported");

  const proseRuntime = await store.loadRuntime("prose");
  assert.equal(proseRuntime.settings.model, "prose-model");
  assert.equal(proseRuntime.route.profileId, "prose");
  assert.equal(proseRuntime.promptCache.remoteModelId, "prose-model");
  assert.deepEqual(proseRuntime.imageInputCapability, {
    imageInput: "supported",
    imageTokenCeiling: 4_096
  });
  assert.equal(providerRuntimeFor(proseRuntime.settings).reasoning, "open");

  const view = await store.loadView();
  assert.equal(view.dataFormat, 2);
  assert.equal(view.effective.model, "gpt-5");
  assert.equal(view.effectiveProse.model, "prose-model");
  assert.equal(view.effectiveProseReasoning, "open");
  assert.equal(view.effectiveProseContinuationPromptLayout, "late-cache-stable");
});

test("a promoted schema 4 state uses one effective revision for runtime and image authorization", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v4-promoted-");
  const oldDocument = parseSettingsDocumentV4({
    ...reasoningDocument(),
    models: {
      ...reasoningDocument().models,
      fixture: {
        ...reasoningDocument().models.fixture!,
        remoteId: "old-model"
      }
    }
  });
  const candidateDocument = parseSettingsDocumentV4({
    ...reasoningDocument(),
    models: {
      ...reasoningDocument().models,
      fixture: {
        ...reasoningDocument().models.fixture!,
        remoteId: "candidate-model",
        capabilities: {
          ...reasoningDocument().models.fixture!.capabilities,
          imageInput: "supported",
          imageTokenCeiling: 4_096
        }
      }
    }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV4(promotedState(oldDocument, candidateDocument)), { mode: 0o600 });

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const runtime = await store.loadRuntime();
  assert.equal(runtime.settings.model, "old-model");
  assert.deepEqual(runtime.imageInputCapability, {
    imageInput: "unsupported",
    imageTokenCeiling: undefined
  });

  const providerRuntime = providerRuntimeFor(runtime.settings);
  const resolution = resolveImageInputCapability({
    protocol: providerRuntime.protocol!,
    remoteModelId: runtime.settings.model,
    override: runtime.imageInputCapability?.imageInput,
    overrideTokenCeiling: runtime.imageInputCapability?.imageTokenCeiling
  });
  assert.equal(imageInputAuthorized(resolution), false);
});
