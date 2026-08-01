import { describe, expect, test } from "bun:test";
import { parseSettingsDocumentV2 } from "../../server/settings-v2-codec.js";
import { effectiveGenerationRuntime } from "../../server/settings-v2-conversion.js";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type {
  ProviderProbeTarget,
  SaveSettingsCommand,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import {
  selectedComposerText,
  setComposerText
} from "../src/composer-model.js";
import { pasteInto } from "../src/keys.js";
import {
  beginSettingsPasteEdit,
  SETTINGS_ROW_IDS,
  settingsDraftChanged,
  settingsRowCycles
} from "../src/settings-overlay-model.js";
import {
  localProviderPresetsSupported,
  selectableSettingsProviderChoices,
  settingsProviderChoice,
  SETTINGS_PROVIDER_CHOICES,
  type SettingsProviderChoiceId
} from "../src/settings-provider-choices.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import {
  deferred,
  draftRow,
  generationFromProbeTarget,
  key,
  openSettings,
  selectRow,
  settingsHarness as harness
} from "./settings-test-harness.js";

describe("inline settings menu", () => {
  test("up/down selects every row; Enter edits text and advances closed choices", async () => {
    const { state, press } = harness();
    await openSettings(press);

    for (const [index, row] of SETTINGS_ROW_IDS.entries()) {
      expect(state.settings?.cursor).toBe(index);
      await press(key("return"));
      if (row === "system-prompt") {
        expect(state.mode).toBe("EDITOR");
        expect(state.editor?.kind).toBe("document");
        expect(state.settings?.edit).toBe(null);
        expect(state.settings).not.toBe(null);
        await press(key("escape"));
        expect(state.mode).toBe("SETTINGS");
      } else if (settingsRowCycles(row)) {
        expect(state.mode).toBe("SETTINGS");
        expect(state.editor).toBe(null);
        expect(state.settings?.edit).toBe(null);
      } else {
        expect(state.mode).toBe("SETTINGS");
        expect(state.editor).toBe(null);
        expect(state.settings?.edit?.kind).toBe("inline");
        if (state.settings?.edit?.kind === "inline") {
          expect(state.settings.edit.row).toBe(row);
        }
        await press(key("escape"));
        expect(state.mode).toBe("SETTINGS");
      }
      if (index < SETTINGS_ROW_IDS.length - 1) await press(key("down"));
    }

    await press(key("down"));
    expect(state.settings?.cursor).toBe(SETTINGS_ROW_IDS.length - 1);
    for (let index = 0; index < SETTINGS_ROW_IDS.length + 2; index += 1) {
      await press(key("up"));
    }
    expect(state.settings?.cursor).toBe(0);
  });

  test("typing replaces the selected inline value and Escape cancels only the row", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "model");
    await press(key("return"));

    await press(key("x"));

    expect(state.settings?.edit?.composer.text).toBe("x");
    await press(key("escape"));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.draft.generation.model).toBe("");
    await press(key("escape"));
    expect(state.mode).toBe("NAV");
  });

  test("Shift+Arrow selects text inside an inline row", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "model");
    await press(key("return"));
    setComposerText(state.settings!.edit!.composer, "draft-model");

    await press(key("left", { shift: true }));
    await press(key("left", { shift: true }));
    await press(key("home", { shift: true }));

    expect(selectedComposerText(state.settings!.edit!.composer)).toBe("draft-model");
  });

  test("row commits build a local draft and s saves it through one durable mutation", async () => {
    const { source, state, press } = harness();
    const commands: SaveSettingsCommand[] = [];
    let current = source.settingsView;
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (!current.editable) throw new Error("demo settings must be editable");
      const effective = basicSettingsFromDocument(command.document);
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);

    await selectRow(press, state, "provider");
    await press(key("right"));
    expect(state.settings?.draft.generation.provider).toBe("openai-compatible");
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");

    expect(commands).toHaveLength(0);
    expect(state.settings?.draft.generation.model).toBe("gpt-5.6");
    expect(state.model).not.toBe("gpt-5.6");
    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.document.connections.demo?.protocol)
      .toBe("openai-chat-completions");
    expect(commands[0]!.document.models.demo?.remoteId).toBe("gpt-5.6");
    expect(state.settings?.draft.generation.model).toBe("gpt-5.6");
    expect(state.toast).toBe("settings saved");
  });

  test("committing an unchanged settings row is silent", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "model");
    await press(key("return"));
    setComposerText(
      state.settings!.edit!.composer,
      state.settings!.draft.generation.model
    );

    await press(key("return"));

    expect(state.settings?.edit).toBe(null);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
    expect(state.toast).toBe(null);
  });

  test("theme is a scoped selector and compose focus cycles as a closed choice", async () => {
    const { source, state, press } = harness();
    await openSettings(press);

    await press(key("right"));
    await press(key("right"));
    await press(key("right"));
    expect(state.config.theme).toBe("bond");
    expect(source.config.theme).toBe("bond");
    await selectRow(press, state, "model");
    await press(key("left"));
    expect(state.config.theme).toBe("bond");
    await selectRow(press, state, "compose-focus");
    expect(state.config.composeFocus).toBe("off");
    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.config.composeFocus).toBe("on");
    expect(source.config.composeFocus).toBe("on");
    await press(key("right"));
    expect(state.config.composeFocus).toBe("off");
  });

  test("Enter on compose-focus toggles without opening a text field", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "compose-focus");
    expect(state.config.composeFocus).toBe("off");

    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.config.composeFocus).toBe("on");
    expect(state.toast).toBe("compose focus · on");

    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.config.composeFocus).toBe("off");
  });

  test("paste refuses every closed choice and still opens text rows", async () => {
    const { state, press } = harness();
    await openSettings(press);

    for (const row of SETTINGS_ROW_IDS) {
      if (!settingsRowCycles(row)) continue;
      await selectRow(press, state, row);
      expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeFalse();
      expect(state.settings?.edit).toBe(null);
      await press(key("v", { ctrl: true }));
      expect(state.settings?.edit).toBe(null);
      expect(state.toast).toBe("this row is a selector · use ←→");
    }

    await selectRow(press, state, "model");
    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(state.settings?.edit?.kind).toBe("inline");
    if (state.settings?.edit?.kind === "inline") {
      expect(state.settings.edit.row).toBe("model");
    }
  });

  test("legacy settings keep local rows editable while server rows remain read-only", async () => {
    const { source, state, press } = harness();
    const legacy: SettingsView = {
      dataFormat: 1,
      editable: false,
      stateGeneration: null,
      activeRevision: null,
      pendingRevision: null,
      document: null,
      effective: source.settings,
      lastActivationOutcome: null
    };
    source.settingsView = legacy;
    source.api.getSettings = async () => legacy;
    await openSettings(press);

    await press(key("right"));
    await press(key("right"));
    await press(key("right"));
    expect(state.config.theme).toBe("bond");
    await selectRow(press, state, "provider");
    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.toast).toBe("legacy settings are read-only");
  });

  test("provider is a closed selector with an OpenAI preset", async () => {
    const { source, state, press } = harness();
    await openSettings(press);

    await selectRow(press, state, "provider");
    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.settings?.draft.generation.provider).toBe("openai-compatible");
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.2",
      apiKeyEnv: "OPENAI_API_KEY",
      contextWindow: null
    });
    expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("openai");
    await press(key("s"));
    expect(source.settings.model).toBe("gpt-5.2");
    await press(key("left"));
    expect(state.settings?.draft.generation.provider).toBe("dry-run");
    expect(state.settings?.draft.generation.contextWindow).toBe(32_768);
  });

  test("local provider choices apply safe localhost defaults", async () => {
    const localChoices = SETTINGS_PROVIDER_CHOICES.filter(
      (choice) => choice.plaintextDefaultRequiresOwnedLoopback === true
    );
    expect(localChoices.map((choice) => ({
      label: choice.label,
      baseUrl: choice.defaults.baseUrl,
      model: choice.defaults.model
    }))).toEqual([
      {
        label: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: ""
      },
      {
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2"
      },
      {
        label: "llama.cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: ""
      },
      {
        label: "KoboldCpp",
        baseUrl: "http://127.0.0.1:5001/v1",
        model: ""
      }
    ]);
    // A target without the account-ownership proof still offers these presets.
    // They are reachable there through the insecure HTTP (local) opt-in, and
    // hiding them said nothing about why a local model server had vanished.
    expect(selectableSettingsProviderChoices(false).map((choice) => choice.label))
      .toEqual(selectableSettingsProviderChoices(true).map((choice) => choice.label));
    expect(selectableSettingsProviderChoices(false).some(
      (choice) => choice.plaintextDefaultRequiresOwnedLoopback === true
    )).toBeTrue();

    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");

    await press(key("right"));
    await press(key("right"));
    await press(key("right"));

    expect(state.settings?.draft.generation).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKeyEnv: null,
      contextWindow: null
    });
    const rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("‹ LM Studio");

    await press(key("left"));
    expect(state.settings?.draft.generation).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "",
      model: ""
    });
    await press(key("right"));
    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2"
    });
    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: ""
    });
    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "http://127.0.0.1:5001/v1",
      model: ""
    });
  });

  test("paste opens the selected text row and replaces its seed inline", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "base-url");

    expect(state.settings?.edit).toBe(null);
    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(pasteInto(state, "http://127.0.0.1:11434/v1\r\n")).toBeTrue();
    expect(state.settings?.edit?.composer.text).toBe("http://127.0.0.1:11434/v1 ");

    await press(key("return"));
    expect(state.settings?.draft.generation.baseUrl)
      .toBe("http://127.0.0.1:11434/v1");
  });

  test("pasted API key uses the save sidecar and renders only a mask", async () => {
    const { source, state, cache, press } = harness();
    const commands: SaveSettingsCommand[] = [];
    let current = source.settingsView;
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (!current.editable) throw new Error("demo settings must be editable");
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective: basicSettingsFromDocument(command.document)
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");
    await selectRow(press, state, "api-key");

    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(pasteInto(state, "sk-pasted-secret")).toBeTrue();
    expect(state.settings?.edit?.kind).toBe("inline");
    if (state.settings?.edit?.kind === "inline") {
      expect(state.settings.edit.mode).toBe("secret");
    }
    const editingFrame = renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    );
    const editingText = frameText(editingFrame.lines);
    expect(editingText).toContain("••••••••");
    expect(editingText).not.toContain("sk-pasted-secret");
    expect(editingFrame.derived.composerSelectionProjection).not.toBe(null);
    await press(key("return"));

    expect(state.settings?.draft.generation.apiKeyEnv).toBe(null);
    expect(JSON.stringify(state.settings?.draft.generation))
      .not.toContain("sk-pasted-secret");
    const rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("•••••••• · stored");
    expect(rendered).not.toContain("sk-pasted-secret");

    await press(key("s"));
    expect(commands).toHaveLength(1);
    // Every entered key mints a fresh, crypto-strength secret ID: the server
    // refuses to rebind an ID the active document still resolves to a
    // different target, and the shared machine tier needs collision-proof
    // names across projects.
    const firstId = Object.keys(commands[0]!.connectionSecrets ?? {})[0]!;
    expect(firstId).toMatch(
      /^demo\.k[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(commands[0]!.connectionSecrets).toEqual({
      [firstId]: "sk-pasted-secret"
    });
    expect(commands[0]!.document.connections.demo?.auth).toEqual({
      type: "bearer-stored",
      secretId: firstId
    });
    expect(JSON.stringify(commands[0]!.document)).not.toContain("sk-pasted-secret");

    await draftRow(press, state, "api-key", "");
    await press(key("s"));
    expect(commands[1]!.connectionSecrets).toEqual({ [firstId]: null });
    expect(commands[1]!.document.connections.demo?.auth).toEqual({ type: "none" });

    await selectRow(press, state, "provider");
    for (let attempts = 0;
      state.settings?.draft.generation.provider !== "anthropic" && attempts < 8;
      attempts += 1) {
      await press(key("right"));
    }
    await draftRow(press, state, "model", "claude-sonnet");
    await selectRow(press, state, "api-key");
    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(pasteInto(state, "anthropic-pasted-secret")).toBeTrue();
    await press(key("return"));
    await press(key("s"));

    const thirdId = Object.keys(commands[2]!.connectionSecrets ?? {})[0]!;
    expect(thirdId.startsWith("demo.k")).toBeTrue();
    expect(thirdId).not.toBe(firstId);
    expect(commands[2]!.connectionSecrets).toEqual({
      [thirdId]: "anthropic-pasted-secret"
    });
    expect(commands[2]!.document.connections.demo?.auth).toEqual({
      type: "header-stored",
      name: "x-api-key",
      secretId: thirdId
    });
  });

  test("provider cycling preserves and reshapes a saved stored API key", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const openAiDocument = applyBasicSettingsDraft(source.settingsView.document, {
      ...source.settings,
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6",
      apiKeyEnv: null,
      contextWindow: null
    });
    const savedDocument = {
      ...openAiDocument,
      connections: {
        ...openAiDocument.connections,
        demo: {
          ...openAiDocument.connections.demo!,
          auth: {
            type: "bearer-stored" as const,
            secretId: "saved-openai-secret"
          }
        }
      }
    };
    const savedView: SettingsView = {
      ...source.settingsView,
      document: savedDocument,
      effective: basicSettingsFromDocument(savedDocument)
    };
    source.settingsView = savedView;
    source.settings = savedView.effective;
    source.api.getSettings = async () => savedView;

    await openSettings(press);
    await selectRow(press, state, "provider");
    for (let attempts = 0;
      state.settings?.draft.generation.provider !== "anthropic" && attempts < 8;
      attempts += 1) {
      await press(key("right"));
    }

    expect(state.settings?.draft.generation.provider).toBe("anthropic");
    expect(state.settings?.draft.generation.apiKeyEnv).toBe(null);
    await draftRow(press, state, "model", "claude-sonnet-5");
    const switched = applyBasicSettingsDraft(
      savedDocument,
      state.settings!.draft.generation
    );
    expect(selectSettingsRoute(switched).connection.auth).toEqual({
      type: "header-stored",
      name: "x-api-key",
      secretId: "saved-openai-secret"
    });
  });

  test("LAN HTTP selector toggles and round-trips through the basic draft", async () => {
    const { source, state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await press(key("right"));
    await draftRow(press, state, "base-url", "http://gpu-box.local:11434/v1");
    await draftRow(press, state, "model", "lan-model");
    await selectRow(press, state, "allow-insecure-http");
    await press(key("right"));

    expect(state.settings?.draft.generation.allowInsecureHttp).toBeTrue();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const document = applyBasicSettingsDraft(
      source.settingsView.document,
      state.settings!.draft.generation
    );
    expect(document.connections.demo?.allowInsecureHttp).toBeTrue();
    expect(basicSettingsFromDocument(document).allowInsecureHttp).toBeTrue();

    await press(key("left"));
    expect(state.settings?.draft.generation.allowInsecureHttp).toBe(undefined);
  });

  test("the selected row and inline field render inside Settings", async () => {
    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");
    let rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("▸ provider");
    expect(rendered).toContain("‹ dry-run ›");
    expect(rendered).toContain("↑↓ move · ←→ choose · ↵ next · s save");

    await selectRow(press, state, "model");
    await press(key("return"));
    rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("▸ model");
    expect(rendered).toContain("←→ cursor · ↵ keep row · esc cancel");
  });

  test("server checks use the unsaved inline draft", async () => {
    const { source, state, press } = harness();
    let checkedModel: string | null = null;
    source.api.checkModelServer = async (settings) => {
      checkedModel = generationFromProbeTarget(settings).model;
      return { state: "ready", message: "draft ready" };
    };
    await openSettings(press);
    await draftRow(press, state, "model", "draft-model");
    await press(key("c"));

    expect(checkedModel).toBe("draft-model");
    expect(state.settings?.result?.message).toBe("draft ready");
    await press(key("return"));
    expect(state.settings?.edit?.kind).toBe("inline");
    if (state.settings?.edit?.kind === "inline") {
      expect(state.settings.edit.row).toBe("model");
    }
    expect(state.settings?.result).toBe(null);
  });

  test("server checks retain LAN HTTP opt-in on an unsaved format-2 draft", async () => {
    const { source, state, press } = harness();
    const checks: ProviderProbeTarget[] = [];
    source.api.checkModelServer = async (target) => {
      checks.push(target);
      return { state: "ready", message: "LAN draft ready" };
    };
    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await press(key("right"));
    await draftRow(press, state, "base-url", "http://gpu-box.local:11434/v1");
    await draftRow(press, state, "model", "lan-model");
    await selectRow(press, state, "allow-insecure-http");
    await press(key("right"));
    await press(key("c"));

    const checked = checks[0];
    if (checked === undefined || !("kind" in checked)) {
      throw new Error("expected a format-2 provider probe target");
    }
    expect(checked.kind).toBe("settings-document");
    const connection = selectSettingsRoute(checked.document).connection;
    expect(connection.baseUrl).toBe("http://gpu-box.local:11434/v1");
    expect(connection.allowInsecureHttp).toBeTrue();
    expect(state.settings?.result?.message).toBe("LAN draft ready");
  });

  test("p detects the context window from the unsaved provider draft", async () => {
    const { source, state, cache, press } = harness();
    let probedModel: string | null = null;
    const probes: ProviderProbeTarget[] = [];
    source.api.probeContextWindow = async (settings) => {
      probes.push(settings);
      probedModel = generationFromProbeTarget(settings).model;
      return { contextWindow: 65_536 };
    };
    await openSettings(press);
    await draftRow(press, state, "model", "draft-model");
    await selectRow(press, state, "context-window");

    let rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("p detect");
    await press(key("p"));

    expect(probedModel).toBe("draft-model");
    expect(probes[0] !== undefined && "kind" in probes[0]).toBeTrue();
    expect(state.settings?.draft.generation.contextWindow).toBe(65_536);
    expect(state.settings?.result).toEqual({
      state: "ready",
      message: "context window · 65,536 tokens · s saves"
    });
    expect(state.settings?.probing).toBeFalse();
    rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("context window · 65,536 tokens · s saves");
    await draftRow(press, state, "model", "another-model");
    expect(state.settings?.draft.generation.contextWindow).toBe(null);
  });

  test("p probes blank-model KoboldCpp and llama.cpp drafts at the real boundary", async () => {
    const cases = [
      { id: "koboldcpp", contextWindow: 65_536 },
      { id: "llama-cpp", contextWindow: 32_768 }
    ] as const satisfies readonly {
      id: SettingsProviderChoiceId;
      contextWindow: number;
    }[];

    for (const expected of cases) {
      const { source, state, press } = harness();
      const choice = SETTINGS_PROVIDER_CHOICES.find(
        (candidate) => candidate.id === expected.id
      )!;
      let probes = 0;
      source.api.probeContextWindow = async (target) => {
        probes += 1;
        if (!("kind" in target)) throw new Error("expected a settings document");
        const runtime = effectiveGenerationRuntime(
          parseSettingsDocumentV2(target.document),
          target.purpose,
          {},
          {},
          { allowBlankModel: true }
        );
        expect(runtime.settings.model).toBe("");
        expect(runtime.providerRuntime.preset).toBe(expected.id);
        return { contextWindow: expected.contextWindow };
      };
      await openSettings(press);
      state.settings!.draft = {
        ...state.settings!.draft,
        generation: {
          ...state.settings!.draft.generation,
          provider: choice.provider,
          ...choice.defaults
        }
      };
      expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe(expected.id);
      expect(state.settings!.draft.generation.model).toBe("");
      await selectRow(press, state, "context-window");

      await press(key("p"));

      expect(probes).toBe(1);
      expect(state.settings?.draft.generation.contextWindow).toBe(expected.contextWindow);
      expect(state.settings?.result).toMatchObject({ state: "ready" });
    }
  });

  test("a probe that cannot answer sends the writer to manual entry", async () => {
    const { source, state, press } = harness();
    source.api.probeContextWindow = async () => ({ contextWindow: null });
    await openSettings(press);
    state.settings!.draft = {
      ...state.settings!.draft,
      generation: {
        ...state.settings!.draft.generation,
        provider: "openai-compatible",
        baseUrl: "https://127.0.0.1:1234/v1",
        model: ""
      }
    };
    await selectRow(press, state, "context-window");
    await press(key("p"));

    expect(state.settings?.result).toEqual({
      state: "warning",
      message: "context window unavailable · enter it here"
    });
  });

  test("a late context probe cannot overwrite a newer inline draft", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const gate = deferred<{ contextWindow: number | null }>();
    source.api.probeContextWindow = async () => {
      entered.resolve();
      return gate.promise;
    };
    await openSettings(press);
    await draftRow(press, state, "model", "model-a");
    await draftRow(press, state, "context-window", "8192");

    const probing = press(key("p"));
    await entered.promise;
    await draftRow(press, state, "model", "model-b");
    gate.resolve({ contextWindow: 32_768 });
    await probing;

    expect(state.settings?.draft.generation.model).toBe("model-b");
    expect(state.settings?.draft.generation.contextWindow).toBe(null);
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.probing).toBeFalse();
  });

  test("a late server check cannot publish against a newer inline draft", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const gate = deferred<{ state: "ready"; message: string }>();
    source.api.checkModelServer = async () => {
      entered.resolve();
      return gate.promise;
    };
    await openSettings(press);
    await draftRow(press, state, "model", "model-a");

    const checking = press(key("c"));
    await entered.promise;
    await draftRow(press, state, "model", "model-b");
    gate.resolve({ state: "ready", message: "model A ready" });
    await checking;

    expect(state.settings?.draft.generation.model).toBe("model-b");
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.checking).toBeFalse();
  });

  test("a server check cannot publish beneath an uncommitted row edit", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const gate = deferred<{ state: "ready"; message: string }>();
    source.api.checkModelServer = async () => {
      entered.resolve();
      return gate.promise;
    };
    await openSettings(press);
    await draftRow(press, state, "model", "model-a");

    const checking = press(key("c"));
    await entered.promise;
    await selectRow(press, state, "model");
    await press(key("return"));
    setComposerText(state.settings!.edit!.composer, "model-b");
    gate.resolve({ state: "ready", message: "model A ready" });
    await checking;

    expect(state.settings?.edit?.composer.text).toBe("model-b");
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.checking).toBeFalse();
  });

  test("a save whose activation fails surfaces the reason and keeps editing available", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    source.api.saveSettings = async (command) => {
      const candidateRevision = active.activeRevision + 1;
      const outcome = {
        transactionId: command.mutationId,
        candidateRevision,
        result: "validation-failed" as const,
        errorCode: "candidate_invalid" as const,
        atStateGeneration: active.stateGeneration + 3
      };
      source.settingsView = {
        ...active,
        stateGeneration: active.stateGeneration + 3,
        pendingRevision: candidateRevision,
        document: command.document,
        lastActivationOutcome: outcome
      };
      return {
        kind: "settings",
        settingsStateGeneration: active.stateGeneration + 1,
        activeSettingsRevision: active.activeRevision,
        pendingSettingsRevision: candidateRevision,
        activationOutcome: outcome
      };
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");
    await draftRow(press, state, "api-key-env", "NEW_PROVIDER_KEY");
    await press(key("s"));

    expect(state.toast).toBe("saved, not active · provider check failed");
    expect(state.settings?.view.pendingRevision).not.toBe(null);
    // Editing stays available for the retry.
    await selectRow(press, state, "model");
    await press(key("return"));
    expect(state.settings?.edit?.kind).toBe("inline");
    if (state.settings?.edit?.kind === "inline") {
      expect(state.settings.edit.row).toBe("model");
    }
  });

  test("a save whose activation commits reports active credentials without a restart", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    source.api.saveSettings = async (command) => {
      const candidateRevision = active.activeRevision + 1;
      const outcome = {
        transactionId: command.mutationId,
        candidateRevision,
        result: "committed" as const,
        errorCode: null,
        atStateGeneration: active.stateGeneration + 6
      };
      source.settingsView = {
        ...active,
        stateGeneration: active.stateGeneration + 6,
        activeRevision: candidateRevision,
        pendingRevision: null,
        document: command.document,
        effective: basicSettingsFromDocument(command.document),
        lastActivationOutcome: outcome
      };
      return {
        kind: "settings",
        settingsStateGeneration: active.stateGeneration + 1,
        activeSettingsRevision: active.activeRevision,
        pendingSettingsRevision: candidateRevision,
        activationOutcome: outcome
      };
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");
    await draftRow(press, state, "api-key-env", "NEW_PROVIDER_KEY");
    await press(key("s"));

    expect(state.toast).toBe("settings saved · credentials active");
    expect(state.settings?.view.pendingRevision).toBe(null);
    expect(state.settings?.view.effective.model).toBe("gpt-5.6");
  });

});
