import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { StoryApi } from "../client/api.js";
import type { SettingsMutationResult, SettingsView } from "../shared/settings-v2-types.js";
import type { SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import { INITIAL_SETTINGS_DOCUMENT_V5 } from "../server/settings-v5-default.js";
import { initialAppState, type AppState } from "../web/src/app/state.js";
import { createStore, type Store } from "../web/src/app/store.js";
import { unsavedWork } from "../web/src/app/unsaved-work.js";
import { initialChaptersState } from "../web/src/chapters/state.js";
import { initialComposeState } from "../web/src/compose/state.js";
import { initialFactsState } from "../web/src/facts/state.js";
import { initialNotesState } from "../web/src/notes/state.js";
import type { LoadedSettings } from "../web/src/settings/state.js";
import {
  connectedState,
  createActionsForStore,
  fakeApi,
  lostAnswer,
  plainFailure,
  waitFor
} from "./web-story-fixtures.js";

/**
 * The settings page over a fake `StoryApi` (#409 step 9b): only what a browser
 * cannot force. A save whose answer was lost, a busy refusal, a refused
 * command, a read-only view, and the keys a save carries. Real app actions.
 */

const DOCUMENT = INITIAL_SETTINGS_DOCUMENT_V5 as unknown as SettingsDocumentV5;
const KEY = "sk-test-SECRET-1234567890";

function editableView(document: SettingsDocumentV5 = DOCUMENT, stateGeneration = 1): SettingsView {
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration,
    activeRevision: stateGeneration,
    pendingRevision: null,
    document,
    effective: { provider: "dry-run", baseUrl: "", model: "dry-run", apiKeyEnv: null, temperature: 0.8, maxTokens: 2048, systemPrompt: document.writing.defaultAuthorBrief, contextWindow: 32_768 },
    effectiveProse: { provider: "dry-run", baseUrl: "", model: "dry-run", apiKeyEnv: null, temperature: 0.8, maxTokens: 2048, systemPrompt: document.writing.defaultAuthorBrief, contextWindow: 32_768 },
    activeWriting: document.writing,
    lastActivationOutcome: null
  };
}

function readOnlyView(): SettingsView {
  const view = editableView();
  return {
    dataFormat: 1,
    editable: false,
    readOnlyReason: "successor-schema",
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective: view.effective,
    effectiveProse: view.effectiveProse,
    activeWriting: view.activeWriting,
    lastActivationOutcome: null
  };
}

const SAVED: SettingsMutationResult = {
  kind: "settings",
  settingsStateGeneration: 2,
  activeSettingsRevision: 2,
  pendingSettingsRevision: null,
  activationOutcome: null
};

interface Saves {
  readonly commands: Parameters<StoryApi["saveSettings"]>[0][];
}

function open(options: {
  readonly view?: SettingsView;
  readonly getSettings?: StoryApi["getSettings"];
  readonly discoverModels?: StoryApi["discoverModels"];
  readonly save?: (command: Parameters<StoryApi["saveSettings"]>[0], call: number) => Promise<SettingsMutationResult>;
} = {}) {
  const saves: Saves = { commands: [] };
  const fake = fakeApi({
    getSettings: options.getSettings ?? (async () => options.view ?? editableView()),
    methods: {
      saveSettings: async (command: Parameters<StoryApi["saveSettings"]>[0]) => {
        saves.commands.push(command);
        return await (options.save ?? (async () => SAVED))(command, saves.commands.length);
      },
      discoverModels: options.discoverModels ?? (async () => ({ observedAt: new Date(0).toISOString(), models: [] })),
      probeContextWindow: async () => ({ contextWindow: null })
    }
  });
  const store: Store<AppState> = createStore(initialAppState({ kind: "settings" }, null, "ink"));
  store.set((state) => ({ ...state, connection: connectedState(fake.api) }));
  const { actions } = createActionsForStore(store);
  return { store, fake, saves, actions };
}

function loaded(store: Store<AppState>): LoadedSettings {
  const settings = store.get().settings;
  assert.equal(settings.kind, "loaded");
  return settings as LoadedSettings;
}

const pages: ReturnType<typeof open>[] = [];
// A page that is left stops its pending model list and probe.
afterEach(() => {
  for (const page of pages.splice(0)) page.actions.settings.leave();
});

async function opened(options: Parameters<typeof open>[0] = {}) {
  const page = open(options);
  pages.push(page);
  // The settings code loads with the page; the page waits for it too.
  await page.actions.settings.load();
  page.actions.settings.open();
  await waitFor(() => page.store.get().settings.kind === "loaded");
  return page;
}

test("single-model discovery during a save keeps the sent model and selects the new draft model", async () => {
  let stored = editableView();
  let finishSave!: () => void;
  const saveReady = new Promise<void>((resolve) => { finishSave = resolve; });
  let finishDiscovery!: (result: Awaited<ReturnType<StoryApi["discoverModels"]>>) => void;
  const discovery = new Promise<Awaited<ReturnType<StoryApi["discoverModels"]>>>((resolve) => { finishDiscovery = resolve; });
  const { actions, store, saves } = await opened({
    getSettings: async () => stored,
    discoverModels: async () => discovery,
    save: async (command) => {
      await saveReady;
      stored = editableView(command.document, stored.stateGeneration! + 1);
      return SAVED;
    }
  });
  actions.settings.chooseProvider("openai-compatible");
  actions.settings.setBaseUrl("https://models.example.test/v1");
  actions.settings.setModel("previous-model");
  actions.settings.refreshModels();
  const saving = actions.settings.save();
  try {
    await waitFor(() => saves.commands.length === 1);
    finishDiscovery({
      observedAt: new Date(0).toISOString(),
      models: [{
        remoteId: "local-model", name: "Local model", contextWindow: 32_768,
        maxOutputTokens: null, source: "openai-models"
      }]
    });
    await waitFor(() => loaded(store).discovery?.kind === "ready");
    finishSave();
    await saving;
    assert.equal(loaded(store).draft.generation.model, "local-model");
    await actions.settings.save();
    assert.deepEqual(saves.commands.map(({ document }) => {
      const profile = document.profiles[document.routing.default]!;
      return document.models[profile.modelId]!.remoteId;
    }), ["previous-model", "local-model"]);
  } finally {
    finishSave();
    await saving;
  }
});

test("a save whose answer was lost keeps its intent, and the next Save sends the same mutation id", async () => {
  const { actions, store, saves } = await opened({
    save: async (_command, call) => {
      if (call === 1) throw lostAnswer();
      return SAVED;
    }
  });
  actions.settings.setWriting("defaultAuthorBrief", "A brief that must save once.");
  await actions.settings.save();

  assert.equal(saves.commands.length, 1);
  assert.notEqual(loaded(store).saveIntent, null);
  assert.equal(loaded(store).busy, null);
  assert.match(loaded(store).notice?.text ?? "", /Could not check whether settings saved/u);

  await actions.settings.save();
  assert.equal(saves.commands.length, 2);
  assert.equal(saves.commands[1]!.mutationId, saves.commands[0]!.mutationId);
  assert.deepEqual(saves.commands[1]!.document, saves.commands[0]!.document);
  assert.equal(loaded(store).saveIntent, null);
});

test("a busy refusal is retried until the save goes through", async () => {
  const { actions, store, saves } = await opened({
    save: async (_command, call) => {
      if (call === 1) throw plainFailure("resource_busy", "busy", 409);
      return SAVED;
    }
  });
  actions.settings.setWriting("defaultAuthorBrief", "Saved after a busy answer.");
  await actions.settings.save();

  assert.equal(saves.commands.length, 2);
  assert.equal(loaded(store).saveIntent, null);
  assert.equal(loaded(store).notice, null);
});

test("a refused command drops the intent, and the next Save builds a new one", async () => {
  const { actions, store, saves } = await opened({
    save: async (_command, call) => {
      if (call === 1) throw plainFailure("invalid_request", "The settings are not valid.", 400);
      return SAVED;
    }
  });
  actions.settings.setWriting("defaultAuthorBrief", "A brief the server refuses once.");
  await actions.settings.save();
  assert.equal(loaded(store).saveIntent, null);
  assert.match(loaded(store).notice?.text ?? "", /The settings are not valid/u);

  await actions.settings.save();
  assert.equal(saves.commands.length, 2);
  assert.notEqual(saves.commands[1]!.mutationId, saves.commands[0]!.mutationId);
});

test("a read-only view cannot be edited or saved", async () => {
  const { actions, store, saves } = await opened({ view: readOnlyView() });
  const before = loaded(store);
  actions.settings.setWriting("defaultAuthorBrief", "Nope.");
  actions.settings.setBaseUrl("https://example.test/v1");
  actions.settings.chooseProvider("openai-compatible");
  await actions.settings.save();

  assert.equal(loaded(store).draft, before.draft);
  assert.equal(saves.commands.length, 0);
  assert.equal(unsavedWork(null, initialComposeState(), initialFactsState(), initialNotesState(), store.get().settings).length, 0);
});

test("a typed key goes out under a fresh secret id, and a removed key goes out as null", async () => {
  const { actions, store, saves } = await opened();
  actions.settings.chooseProvider("openai-compatible");
  actions.settings.setBaseUrl("https://models.example.test/v1");
  actions.settings.setModel("example-model");
  actions.settings.setApiKey(KEY);

  // The key is in memory, and in the Copy text of nothing.
  const pending = loaded(store);
  assert.deepEqual(Object.values(pending.secrets), [KEY]);
  actions.settings.setWriting("defaultAuthorBrief", "A brief changed beside the key.");
  const items = unsavedWork(null, initialComposeState(), initialFactsState(), initialNotesState(), store.get().settings);
  assert.equal(items.length, 1);
  assert.ok(!JSON.stringify(items).includes(KEY));
  assert.match(items[0]!.text, /A brief changed beside the key\./u);

  await actions.settings.save();
  const first = saves.commands[0]!;
  const [firstId] = Object.keys(first.connectionSecrets ?? {});
  assert.ok(firstId !== undefined);
  assert.equal(first.connectionSecrets![firstId], KEY);
  const connection = Object.values(first.document.connections).find((candidate) => candidate.auth.type === "bearer-stored");
  assert.ok(connection !== undefined);
  assert.equal(connection.auth.type === "bearer-stored" ? connection.auth.secretId : null, firstId);
  assert.deepEqual(loaded(store).secrets, {});

  // The saved document now names the stored key; a different key gets another id.
  const stored = { ...DOCUMENT, ...first.document } as SettingsDocumentV5;
  const second = await opened({ view: editableView(stored, 2) });
  second.actions.settings.setApiKey(`${KEY}-next`);
  await second.actions.settings.save();
  const [nextId] = Object.keys(second.saves.commands[0]!.connectionSecrets ?? {});
  assert.ok(nextId !== undefined);
  assert.notEqual(nextId, firstId);

  // Remove: the stored key is deleted by a null under its own id.
  const third = await opened({ view: editableView(stored, 2) });
  third.actions.settings.removeApiKey();
  await third.actions.settings.save();
  assert.deepEqual(third.saves.commands[0]!.connectionSecrets, { [firstId]: null });
});

test("the unsaved settings never list a key, and nothing but changed prompts reaches the Copy text", async () => {
  const { actions, store } = await opened();
  actions.settings.chooseProvider("openai-compatible");
  actions.settings.setApiKey(KEY);
  const items = unsavedWork(null, initialComposeState(), initialFactsState(), initialNotesState(), store.get().settings);
  assert.deepEqual(items.map((item) => item.id), ["settings"]);
  assert.equal(items[0]!.text, "");
  // Neither the store's other slices nor the items carry it.
  const everything: Partial<AppState> = { chapters: initialChaptersState(), toasts: store.get().toasts };
  assert.ok(!JSON.stringify([items, everything]).includes(KEY));
});
