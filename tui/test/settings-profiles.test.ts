import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { resolveSettingsProfile, selectSettingsRoute } from "../../shared/settings-route.js";
import type {
  SaveSettingsCommand,
  SettingsDocumentV2,
  SettingsView,
  ProviderProbeTarget
} from "../../shared/settings-v2-types.js";
import { setComposerText } from "../src/composer-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { settingsTextDraftForDocument } from "../src/settings-text.js";
import {
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

type EditableSettingsView = Extract<SettingsView, { readonly dataFormat: 2 }>;

describe("Generation Profile settings", () => {
  test("saves the complete profile document, routes, and selected profile behavior", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source);
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const saved = savedView(current, command.document);
      source.settingsView = saved;
      return savedResult(saved);
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await press(key("e"));
    expect(state.settings?.edit?.row).toBe("profile");
    setComposerText(state.settings!.edit!.composer, "Utility");
    await press(key("return"));

    await draftRow(press, state, "model", "gpt-5.6-terra");
    declareSelectedModelSupportsEffort(state);
    await selectRow(press, state, "effort");
    await press(key("right"));
    await selectRow(press, state, "cache-policy");
    await press(key("right"));
    await selectRow(press, state, "utility-route");
    await press(key("right"));
    await press(key("right"));
    await press(key("s"));

    expect(commands).toHaveLength(1);
    const document = commands[0]!.document;
    const utility = document.profiles["profile.1"];
    if (utility === undefined) throw new Error("new profile was not saved");
    expect(utility).toMatchObject({ name: "Utility", effort: "off", cachePolicy: "auto" });
    expect(document.routing.utility).toBe("profile.1");
    expect(document.routing.prose).toBe(undefined);
    expect(selectSettingsRoute(document, "utility").profileId).toBe("profile.1");
    expect(document.models[document.profiles.default!.modelId]!.remoteId).toBe("gpt-5.6");
    expect(document.models[utility.modelId]!.remoteId).toBe("gpt-5.6-terra");
    expect(utility.modelId).not.toBe(document.profiles.default!.modelId);
  });

  test("edits a duplicated profile connection without changing its original", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await draftRow(press, state, "base-url", "https://example.com/v1");

    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const original = selectSettingsRoute(document, "default");
    const selectedProfile = state.settings?.draft.selectedProfileId;
    if (selectedProfile === null || selectedProfile === undefined) throw new Error("selected profile missing");
    const selectedRoute = resolveSettingsProfile(document, selectedProfile);
    expect(original.connection.baseUrl).toBe("https://api.openai.com/v1");
    expect(original.model.connectionId).not.toBe(selectedRoute.model.connectionId);
    expect(selectedRoute.connection.baseUrl).toBe("https://example.com/v1");
  });

  test("clearing a duplicated stored key preserves the original profile credential", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source, "demo.saved-key");
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      return savedResult(current);
    };
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await draftRow(press, state, "api-key", "");

    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const original = selectSettingsRoute(document, "default");
    const selectedId = state.settings?.draft.selectedProfileId;
    if (selectedId === null || selectedId === undefined) throw new Error("selected profile missing");
    expect(original.connection.auth).toEqual({ type: "bearer-stored", secretId: "demo.saved-key" });
    expect(resolveSettingsProfile(document, selectedId).connection.auth).toEqual({ type: "none" });
    expect(state.settings?.connectionSecrets["demo.saved-key"]).toBe(undefined);

    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.connectionSecrets).toBe(undefined);
  });

  test("profile rename has an inline editor and a visible compact footer at 80 columns", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "profile");
    expect(frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: cache }).lines))
      .toContain("n new · ⇧n copy · e rename · d delete");
    await press(key("e"));
    expect(state.settings?.edit?.row).toBe("profile");
  });

  test("shows profile actions and pending discard together", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "profile");
    if (state.settings?.view.dataFormat !== 2) throw new Error("editable settings missing");
    state.settings!.view = { ...state.settings!.view, pendingRevision: 2 };
    const frame = frameText(renderStoryScreen(
      state,
      { width: 120, height: 30, wrapCache: cache }
    ).lines);
    expect(frame).toContain("n new · ⇧n copy · e rename · d delete · s · x · esc");
  });

  test("requires two uninterrupted delete commands for a profile", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));

    await press(key("d"));
    expect(state.settings?.deleteArmedProfileId).toBe("profile.1");
    await press(key("e"));
    setComposerText(state.settings!.edit!.composer, "Renamed");
    await press(key("return"));
    expect(state.settings?.deleteArmedProfileId).toBe(null);

    await press(key("d"));
    expect(state.settings?.draft.document?.profiles["profile.1"]?.name).toBe("Renamed");
    expect(state.settings?.deleteArmedProfileId).toBe("profile.1");
  });

  test("duplicates a 256-scalar profile name with a bounded unique suffix", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    const name = "a".repeat(256);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("e"));
    setComposerText(state.settings!.edit!.composer, name);
    await press(key("return"));
    await press(key("N"));

    const duplicate = state.settings?.draft.document?.profiles["profile.1"];
    expect(duplicate?.name).toBe(`${"a".repeat(251)} copy`);
    expect([...duplicate!.name]).toHaveLength(256);
  });

  test("cycles default and prose routes, then deletes a routed profile and rejects the last delete", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));

    await selectRow(press, state, "default-route");
    await press(key("right"));
    await selectRow(press, state, "prose-route");
    await press(key("right"));
    await press(key("right"));
    await selectRow(press, state, "utility-route");
    await press(key("right"));
    await press(key("right"));
    let document = state.settings?.draft.document;
    expect(document?.routing).toEqual({
      default: "profile.1",
      prose: "profile.1",
      utility: "profile.1"
    });

    await selectRow(press, state, "profile");
    await press(key("d"));
    await press(key("d"));
    document = state.settings?.draft.document;
    expect(document?.profiles.default !== undefined).toBeTrue();
    expect(document?.profiles["profile.1"]).toBe(undefined);
    expect(document?.routing).toEqual({ default: "default" });

    await press(key("d"));
    expect(state.settings?.deleteArmedProfileId).toBe(null);
    expect(state.toast).toBe("profile kept · the last profile cannot be removed");
  });

  test("deleting a profile removes only its private model and connection", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await draftRow(press, state, "base-url", "https://profile.example/v1");

    let document = state.settings?.draft.document;
    expect(Object.keys(document?.profiles ?? {})).toHaveLength(2);
    expect(Object.keys(document?.models ?? {})).toHaveLength(2);
    expect(Object.keys(document?.connections ?? {})).toHaveLength(2);

    await selectRow(press, state, "profile");
    await press(key("d"));
    await press(key("d"));

    document = state.settings?.draft.document;
    expect(Object.keys(document?.profiles ?? {})).toHaveLength(1);
    expect(Object.keys(document?.models ?? {})).toHaveLength(1);
    expect(Object.keys(document?.connections ?? {})).toHaveLength(1);
    expect(selectSettingsRoute(document!, "default").connection.baseUrl)
      .toBe("https://api.openai.com/v1");
  });

  test("drops a dry-run profile's pending key but preserves another profile's key", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    const probes: ProviderProbeTarget[] = [];
    source.api.discoverModels = async (target) => {
      probes.push(target);
      return { observedAt: "2026-08-01T00:00:00.000Z", models: [] };
    };
    await openSettings(press);
    await draftRow(press, state, "api-key", "default-key");
    const defaultSecretId = Object.keys(state.settings!.connectionSecrets)[0]!;

    await selectRow(press, state, "profile");
    await press(key("N"));
    await draftRow(press, state, "api-key", "profile-key");
    const profileSecretId = Object.keys(state.settings!.connectionSecrets)
      .find((id) => id !== defaultSecretId)!;
    const selectedProbe = probes.at(-1);
    if (selectedProbe === undefined || !("kind" in selectedProbe)) {
      throw new Error("expected a settings-document probe");
    }
    expect(selectedProbe.secrets).toEqual({ [profileSecretId]: "profile-key" });
    await selectRow(press, state, "provider");
    await press(key("left"));

    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    expect(state.settings?.draft.generation.provider).toBe("dry-run");
    expect(state.settings?.connectionSecrets).toEqual({ [defaultSecretId]: "default-key" });
    expect(state.settings?.connectionSecrets[profileSecretId]).toBe(undefined);
    expect(resolveSettingsProfile(document, "default").connection.auth)
      .toEqual({ type: "bearer-stored", secretId: defaultSecretId });
    expect(resolveSettingsProfile(document, "profile.1").connection.auth).toEqual({ type: "none" });
  });

  test("shows an unavailable imported effort and resets it to default in either direction", async () => {
    const { source, state, cache, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const modelId = document.profiles.default!.modelId;
    const unsupported = {
      ...document,
      profiles: {
        ...document.profiles,
        default: { ...document.profiles.default!, effort: "high" as const }
      },
      models: {
        ...document.models,
        [modelId]: {
          ...document.models[modelId]!,
          capabilities: {
            ...document.models[modelId]!.capabilities,
            reasoningEffort: "unknown" as const
          }
        }
      }
    };
    state.settings!.draft = settingsTextDraftForDocument(unsupported);
    await selectRow(press, state, "effort");
    expect(frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: cache }).lines))
      .toContain("‹ high › · unavailable");
    await press(key("left"));
    expect(state.settings?.draft.document?.profiles.default?.effort).toBe("default");

    state.settings!.draft = settingsTextDraftForDocument(unsupported);
    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.effort).toBe("default");
  });
});

function installNetworkSettings(
  source: ReturnType<typeof settingsHarness>["source"],
  storedSecretId?: string
): EditableSettingsView {
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  let document = applyBasicSettingsDraft(source.settingsView.document, {
    ...source.settings,
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    apiKeyEnv: null
  });
  const route = selectSettingsRoute(document, "default");
  document = {
    ...document,
    connections: {
      ...document.connections,
      [route.model.connectionId]: {
        ...route.connection,
        auth: storedSecretId === undefined
          ? { type: "none" }
          : { type: "bearer-stored", secretId: storedSecretId }
      }
    },
    models: {
      ...document.models,
      [route.profile.modelId]: {
        ...route.model,
        capabilities: { ...route.model.capabilities, reasoningEffort: "supported" }
      }
    }
  };
  const effective = basicSettingsFromDocument(document);
  const view: EditableSettingsView = {
    ...source.settingsView,
    document,
    effective,
    effectiveProse: effective
  };
  source.settings = effective;
  source.settingsView = view;
  source.api.getSettings = async () => source.settingsView;
  return view;
}

function declareSelectedModelSupportsEffort(
  state: ReturnType<typeof settingsHarness>["state"]
): void {
  const overlay = state.settings;
  const document = overlay?.draft.document;
  const profileId = overlay?.draft.selectedProfileId;
  if (overlay === null || overlay === undefined
    || document === null || document === undefined
    || profileId === null || profileId === undefined) {
    throw new Error("selected profile missing");
  }
  const modelId = document.profiles[profileId]!.modelId;
  overlay.draft = settingsTextDraftForDocument({
    ...document,
    models: {
      ...document.models,
      [modelId]: {
        ...document.models[modelId]!,
        capabilities: {
          ...document.models[modelId]!.capabilities,
          reasoningEffort: "supported"
        }
      }
    }
  }, profileId);
}

function savedView(
  view: EditableSettingsView,
  document: SettingsDocumentV2
): EditableSettingsView {
  const effective = basicSettingsFromDocument(document);
  return {
    ...view,
    stateGeneration: view.stateGeneration + 1,
    activeRevision: view.activeRevision + 1,
    document,
    effective,
    effectiveProse: basicSettingsFromDocument(
      document,
      selectSettingsRoute(document, "prose").profileId
    )
  };
}

function savedResult(view: EditableSettingsView) {
  return {
    kind: "settings" as const,
    settingsStateGeneration: view.stateGeneration,
    activeSettingsRevision: view.activeRevision,
    pendingSettingsRevision: null,
    activationOutcome: null
  };
}
