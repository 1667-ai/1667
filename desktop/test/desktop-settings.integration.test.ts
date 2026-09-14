import assert from "node:assert/strict";
import test from "node:test";
import type { StoryApi } from "../../client/api.js";
import { INITIAL_SETTINGS_DOCUMENT_V5 } from "../../server/settings-v5-default.js";
import type { ModelServerCheckResult } from "../../shared/types.js";
import type { SettingsView } from "../../shared/settings-v2-view.js";
import { validateSettingsDocumentV5 } from "../../shared/settings-v5-validation.js";
import { INITIAL_STATE, type RendererState } from "../renderer-model.js";
import {
  createSettingsEditorState,
  RendererSettingsController,
  type RendererSettingsHooks
} from "../renderer-settings-controller.js";
import {
  draftForDocument,
  editSamplingList,
  editSamplingScalar,
  editSettingsField,
  profileRoute,
  type SettingsEditorDraft
} from "../renderer-settings-model.js";
import {
  addConnectionHeader,
  applyDiscoveredModel,
  clearConnectionSecret,
  createSettingsConnection,
  createSettingsProfile,
  editConnectionHeader,
  providerProbeTarget,
  removeConnectionHeader,
  setConnectionSecret
} from "../renderer-settings-profile.js";

function documentWithStoredKey(): SettingsEditorDraft {
  const base = INITIAL_SETTINGS_DOCUMENT_V5;
  const connectionId = "connection.test";
  const modelId = "model.test";
  const profileId = "profile.test";
  const document = {
    ...base,
    connections: {
      ...base.connections,
      [connectionId]: {
        ...base.connections["builtin:dry-run"]!,
        name: "Test provider",
        preset: "custom" as const,
        protocol: "openai-chat-completions" as const,
        baseUrl: "https://example.test/v1",
        auth: { type: "bearer-stored" as const, secretId: "secret.test" },
        timeouts: { responseHeaderMs: 1_000, firstTokenMs: 1_000, idleMs: 1_000, totalMs: 5_000 }
      }
    },
    models: {
      ...base.models,
      [modelId]: {
        ...base.models["builtin:dry-run"]!,
        connectionId,
        remoteId: "test-model",
        name: "Test model",
        capabilities: {
          ...base.models["builtin:dry-run"]!.capabilities,
          imageInput: "unknown" as const
        }
      }
    },
    profiles: {
      ...base.profiles,
      [profileId]: { ...base.profiles.default!, modelId, name: "Test profile" }
    },
    routing: { ...base.routing, default: profileId }
  };
  return draftForDocument(document, profileId);
}

test("desktop settings draft clears inherited token alternatives and remains schema-valid", () => {
  let draft = documentWithStoredKey();
  let result = editSettingsField(draft.document, draft.selectedProfileId, "profile.tokenProbabilities", "4");
  assert.equal(result.error, null);
  result = editSettingsField(result.document, draft.selectedProfileId, "profile.tokenProbabilities", "");
  assert.equal(result.error, null);
  assert.equal(Object.hasOwn(result.document.profiles[draft.selectedProfileId]!, "tokenProbabilities"), false);
  validateSettingsDocumentV5(result.document);
});

test("desktop settings draft carries pending keys into provider probes and saves sampling lists", () => {
  let draft = documentWithStoredKey();
  draft = setConnectionSecret(draft, "pending-secret");
  const target = providerProbeTarget(draft);
  assert.equal("secrets" in target, true);
  if ("secrets" in target) assert.equal(target.secrets?.["secret.test"], "pending-secret");

  let result = editSamplingScalar(draft.document, draft.selectedProfileId, "topP", "0.8");
  assert.equal(result.error, null);
  result = editSamplingList(result.document, draft.selectedProfileId, "stop", "END\nTHE END");
  assert.equal(result.error, null);
  result = editSamplingList(result.document, draft.selectedProfileId, "phraseBias", "lantern | 1");
  assert.equal(result.error, null);
  validateSettingsDocumentV5(result.document);
  assert.deepEqual(result.document.profiles[draft.selectedProfileId]!.sampling?.stop, ["END", "THE END"]);
  assert.deepEqual(result.document.profiles[draft.selectedProfileId]!.sampling?.phraseBias, [{ phrase: "lantern", weight: 1 }]);
});

test("desktop settings draft omits an empty pending key from provider probes", () => {
  let draft = documentWithStoredKey();
  draft = setConnectionSecret(draft, "pending-secret");
  draft = setConnectionSecret(draft, "");
  const target = providerProbeTarget(draft);
  assert.equal("secrets" in target, false);
});

test("desktop settings draft can remove a stored key with an explicit action", () => {
  const draft = documentWithStoredKey();
  const cleared = clearConnectionSecret(draft);
  const connectionId = cleared.document.models[cleared.document.profiles[cleared.selectedProfileId]!.modelId]!.connectionId;
  assert.deepEqual(cleared.document.connections[connectionId]!.auth, { type: "none" });
  assert.equal(cleared.connectionSecrets["secret.test"], null);
  validateSettingsDocumentV5(cleared.document);
});

test("desktop settings draft edits custom environment headers and keeps them isolated", () => {
  const draft = documentWithStoredKey();
  let result = addConnectionHeader(draft.document, draft.selectedProfileId);
  assert.equal(result.error, null);
  result = editConnectionHeader(result.document, draft.selectedProfileId, 0, "X-Trace-Id", "TRACE_ID");
  assert.equal(result.error, null);
  validateSettingsDocumentV5(result.document);
  const connectionId = result.document.models[result.document.profiles[draft.selectedProfileId]!.modelId]!.connectionId;
  assert.deepEqual(result.document.connections[connectionId]!.headers, [{ name: "X-Trace-Id", value: { type: "env", env: "TRACE_ID" } }]);
  result = removeConnectionHeader(result.document, draft.selectedProfileId, 0);
  assert.equal(result.error, null);
  validateSettingsDocumentV5(result.document);
  assert.deepEqual(result.document.connections[connectionId]!.headers, []);
  assert.deepEqual(draft.document.connections["connection.test"]!.headers, []);
});

test("desktop settings profile and connection creation preserve a valid route graph", () => {
  const base = INITIAL_SETTINGS_DOCUMENT_V5;
  const profile = createSettingsProfile(base, base.routing.default);
  assert.equal(typeof profile, "object");
  if (typeof profile === "string") return;
  validateSettingsDocumentV5(profile.document);
  const connection = createSettingsConnection(profile.document, profile.selectedProfileId);
  assert.equal(typeof connection, "object");
  if (typeof connection === "string") return;
  validateSettingsDocumentV5(connection.document);
  assert.notEqual(connection.selectedProfileId, profile.selectedProfileId);
  assert.equal(Object.keys(connection.document.connections).length, Object.keys(base.connections).length + 1);
  assert.equal(Object.keys(connection.document.profiles).length, Object.keys(base.profiles).length + 2);
});

test("desktop settings new connections do not reuse a stored credential reference", () => {
  const draft = documentWithStoredKey();
  const connection = createSettingsConnection(draft.document, draft.selectedProfileId);
  assert.equal(typeof connection, "object");
  if (typeof connection === "string") return;
  assert.deepEqual(profileRoute(connection).connection.auth, { type: "none" });
  validateSettingsDocumentV5(connection.document);
});

test("desktop settings draft reports invalid typed values without replacing the document", () => {
  const draft = documentWithStoredKey();
  const result = editSettingsField(draft.document, draft.selectedProfileId, "connection.totalMs", "0");
  assert.match(result.error ?? "", /positive|whole|number/u);
  assert.strictEqual(result.document, draft.document);
});

test("desktop settings sampling scalars use the shared ranges and integer rules", () => {
  const draft = documentWithStoredKey();
  let result = editSamplingScalar(draft.document, draft.selectedProfileId, "topK", "200");
  assert.equal(result.error, null);
  result = editSamplingScalar(result.document, draft.selectedProfileId, "seed", "12345");
  assert.equal(result.error, null);
  result = editSamplingScalar(result.document, draft.selectedProfileId, "dryRange", "131072");
  assert.equal(result.error, null);
  assert.equal(result.document.profiles[draft.selectedProfileId]!.sampling?.topK, 200);
  assert.equal(result.document.profiles[draft.selectedProfileId]!.sampling?.seed, 12345);
  assert.equal(result.document.profiles[draft.selectedProfileId]!.sampling?.dryRange, 131072);
  result = editSamplingScalar(result.document, draft.selectedProfileId, "topK", "100001");
  assert.match(result.error ?? "", /100000/u);
  result = editSamplingScalar(result.document, draft.selectedProfileId, "seed", "12345.5");
  assert.match(result.error ?? "", /whole number/u);
  validateSettingsDocumentV5(result.document);
});

test("desktop settings profile operations preserve pending secrets for retained connections", async () => {
  const draft = setConnectionSecret(documentWithStoredKey(), "pending-secret");
  const harness = settingsControllerHarness(draft, {
    confirmDialog: async () => true
  });

  harness.controller.createProfile();
  assert.equal(harness.current().settingsEditor?.draft.connectionSecrets["secret.test"], "pending-secret");
  harness.controller.duplicateProfile();
  assert.equal(harness.current().settingsEditor?.draft.connectionSecrets["secret.test"], "pending-secret");
  await harness.controller.deleteProfile();
  assert.equal(harness.current().settingsEditor?.draft.connectionSecrets["secret.test"], "pending-secret");
});

test("desktop settings provider results keep edits and ignore a changed project", async () => {
  const firstCheck = deferred<ModelServerCheckResult>();
  const draft = documentWithStoredKey();
  const harness = settingsControllerHarness(draft, {
    api: { checkModelServer: async () => await firstCheck.promise } as unknown as StoryApi
  });

  const checking = harness.controller.checkConnection();
  await Promise.resolve();
  harness.controller.editField("profile.name", "Edited while checking");
  firstCheck.resolve({ state: "ready", message: "ready" });
  await checking;
  assert.equal(harness.current().settingsEditor?.draft.document.profiles[draft.selectedProfileId]?.name, "Edited while checking");
  assert.equal(harness.current().settingsEditor?.providerStatus?.message, "ready");

  const secondCheck = deferred<ModelServerCheckResult>();
  harness.replaceApi({ checkModelServer: async () => await secondCheck.promise } as unknown as StoryApi);
  const oldEditor = harness.current().settingsEditor;
  const checkingOldProject = harness.controller.checkConnection();
  await Promise.resolve();
  const replacement = createSettingsEditorState(harness.current().settings!, draft.selectedProfileId);
  if (replacement === null) throw new Error("settings fixture is not editable");
  harness.replaceState({
    project: { root: "other-project", directory: "Other", source: "explicit", exists: true, vault: "unsealed", open: true },
    settingsEditor: replacement
  });
  secondCheck.resolve({ state: "error", message: "stale" });
  await checkingOldProject;
  assert.equal(harness.current().settingsEditor, replacement);
  assert.notEqual(harness.current().settingsEditor, oldEditor);
});

test("desktop settings discovered model selection isolates a shared profile record", () => {
  const source = documentWithStoredKey();
  const duplicate = createSettingsProfile(source.document, source.selectedProfileId);
  assert.equal(typeof duplicate, "object");
  if (typeof duplicate === "string") return;

  const originalModelId = source.document.profiles[source.selectedProfileId]!.modelId;
  const discovered = applyDiscoveredModel(duplicate, {
    remoteId: "new-model",
    name: "New model",
    contextWindow: 32_000,
    maxOutputTokens: 4_000,
    source: "ollama-tags"
  });
  const originalModel = discovered.document.models[originalModelId]!;
  const duplicateModelId = discovered.document.profiles[discovered.selectedProfileId]!.modelId;
  const duplicateModel = discovered.document.models[duplicateModelId]!;

  assert.notEqual(duplicateModelId, originalModelId);
  assert.equal(originalModel.remoteId, source.document.models[originalModelId]!.remoteId);
  assert.equal(duplicateModel.remoteId, "new-model");
  assert.equal(duplicateModel.name, "New model");
  assert.deepEqual(duplicateModel.discovered, { contextWindow: 32_000, maxOutputTokens: 4_000 });
  validateSettingsDocumentV5(discovered.document);
});

function settingsControllerHarness(
  draft: SettingsEditorDraft,
  options: {
    readonly api?: StoryApi;
    readonly confirmDialog?: () => Promise<boolean>;
  } = {}
): {
  readonly controller: RendererSettingsController;
  readonly current: () => RendererState;
  readonly replaceApi: (api: StoryApi) => void;
  readonly replaceState: (update: Partial<RendererState>) => void;
} {
  const settings = editableSettingsView(draft.document);
  const editor = createSettingsEditorState(settings, draft.selectedProfileId);
  if (editor === null) throw new Error("settings fixture is not editable");
  let state: RendererState = {
    ...INITIAL_STATE,
    project: { root: "project", directory: "Project", source: "explicit", exists: true, vault: "unsealed", open: true },
    settings,
    settingsEditor: { ...editor, draft }
  };
  let api = options.api ?? ({ checkModelServer: async () => ({ state: "ready", message: "ready" }) } as unknown as StoryApi);
  const hooks: RendererSettingsHooks = {
    state: () => state,
    setState: (update) => { state = { ...state, ...update }; },
    api: () => api,
    run: async (_status, work) => await work(),
    textDialog: async () => null,
    confirmDialog: options.confirmDialog ?? (async () => false)
  };
  return {
    controller: new RendererSettingsController(hooks),
    current: () => state,
    replaceApi: (next) => { api = next; },
    replaceState: (update) => { state = { ...state, ...update }; }
  };
}

function editableSettingsView(document: SettingsEditorDraft["document"]): SettingsView {
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: 1,
    activeRevision: 1,
    pendingRevision: null,
    document,
    effective: {} as never,
    effectiveProse: {} as never,
    activeWriting: {} as never,
    lastActivationOutcome: null
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
